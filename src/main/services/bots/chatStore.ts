import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateRecord, withSchemaVersion } from '../../../shared/bots/migrations';
import {
  type BotChat,
  type BotChatWorkspace,
  type GroupEntry,
  type GroupEntryInput,
  isBotChatId,
  parseBotChat,
  parseGroupEntry,
} from '../../../shared/types/bot';
import { readJson, writeJsonAtomic } from './files';

export interface BotChatDraft {
  kind: BotChat['kind'];
  title: string;
  members: string[];
  bossBotId: string | null;
  workspace: BotChatWorkspace;
  routing?: Partial<BotChat['routing']>;
}

const TIMELINE = 'timeline.jsonl';
const NEWLINE = 0x0a;
/** 倒读时每隔这么多 seq 记一个行首偏移，深翻页直接从附近开始读 */
const CHECKPOINT_EVERY = 128;
/** `{"seq":N,"id":"…"` 是 appendEntry 写出的固定前缀；建索引时免整行解析 */
const ENTRY_HEAD = /^\{"seq":(\d+),"id":("(?:[^"\\]|\\.)*")/u;

interface IndexedEntry {
  seq: number;
  offset: number;
  length: number;
}

/** ids 只覆盖文件 rest 字节之后的行；rest=0 表示已完整 */
interface EntryIndex {
  ids: Map<string, IndexedEntry>;
  rest: number;
  /** 已收录的最小 seq；续扫时只收更小的 */
  min: number;
}

function parseLine(line: Buffer): GroupEntry | undefined {
  if (line.length === 0) return undefined;
  try {
    return parseGroupEntry(JSON.parse(line.toString('utf8')));
  } catch {
    return undefined;
  }
}

/** 按块切出完整行；返回剩余的不完整尾部 */
function* splitLines(
  data: Buffer,
  base: number
): Generator<{ line: Buffer; offset: number }, Buffer> {
  let start = 0;
  for (let i = data.indexOf(NEWLINE); i >= 0; i = data.indexOf(NEWLINE, start)) {
    yield { line: data.subarray(start, i), offset: base + start };
    start = i + 1;
  }
  return data.subarray(start);
}

/** userData/bot-chats/<chatId>/{chat.json, timeline.jsonl, workspace/} */
export class BotChatStore {
  private chats = new Map<string, BotChat>();
  private seqs = new Map<string, number>();
  /** id → 行位置；按需构建，append 时增量维护 */
  private indexes = new Map<string, EntryIndex>();
  /** seq（CHECKPOINT_EVERY 的倍数）→ 该行起始偏移；文件只追加，偏移长期有效 */
  private checkpoints = new Map<string, Map<number, number>>();
  private readonly chunkSize: number;

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
    options: { chunkSize?: number } = {}
  ) {
    this.chunkSize = Math.max(1, options.chunkSize ?? 64 * 1024);
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      if (!isBotChatId(name)) continue;
      const chat = parseBotChat(migrateRecord('chat', readJson(join(root, name, 'chat.json'))));
      if (chat?.id === name) this.chats.set(name, chat);
    }
  }

  list(): BotChat[] {
    return [...this.chats.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): BotChat | undefined {
    return this.chats.get(id);
  }

  workspaceDir(id: string): string {
    return join(this.dir(id), 'workspace');
  }

  /** send_image 的图片副本；删聊天时随目录一起删 */
  mediaDir(id: string): string {
    return join(this.dir(id), 'media');
  }

  create(draft: BotChatDraft, id: string = randomUUID()): BotChat | undefined {
    const at = this.now();
    const chat = parseBotChat({
      ...draft,
      // 解析缺省为 boss（旧数据不变）；新建群缺省智能选人
      routing: { ...(draft.kind === 'group' ? { mode: 'smart' } : {}), ...draft.routing },
      id,
      pinned: false,
      sessions: {},
      createdAt: at,
      updatedAt: at,
      version: 1,
    });
    if (!chat) return undefined;
    this.persist(chat);
    return chat;
  }

  /** mutate 的结果整体重新校验；id、createdAt 不可改 */
  update(id: string, mutate: (draft: BotChat) => BotChat): BotChat | undefined {
    const current = this.chats.get(id);
    if (!current) return undefined;
    const next = mutate(structuredClone(current));
    if (next.id !== id) return undefined;
    const chat = parseBotChat({
      ...next,
      createdAt: current.createdAt,
      updatedAt: this.now(),
      version: current.version + 1,
    });
    if (!chat) return undefined;
    this.persist(chat);
    return chat;
  }

  remove(id: string): boolean {
    if (!isBotChatId(id) || !this.chats.has(id)) return false;
    rmSync(this.dir(id), { recursive: true, force: true });
    this.chats.delete(id);
    this.seqs.delete(id);
    this.indexes.delete(id);
    this.checkpoints.delete(id);
    return true;
  }

  lastSeq(chatId: string): number {
    const cached = this.seqs.get(chatId);
    if (cached !== undefined) return cached;
    let last = 0;
    for (const entry of this.backward(chatId)) {
      last = entry.seq;
      break;
    }
    this.seqs.set(chatId, last);
    return last;
  }

  appendEntry(chatId: string, input: GroupEntryInput): GroupEntry | undefined {
    if (!this.chats.has(chatId)) return undefined;
    const entry = parseGroupEntry({ ...input, seq: this.lastSeq(chatId) + 1 });
    if (!entry) return undefined;
    mkdirSync(this.dir(chatId), { recursive: true });
    const json = JSON.stringify(entry);
    const fd = openSync(this.file(chatId), 'a+', 0o600);
    let offset: number;
    try {
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== NEWLINE;
      writeSync(fd, `${torn ? '\n' : ''}${json}\n`);
      offset = size + (torn ? 1 : 0);
    } finally {
      closeSync(fd);
    }
    this.seqs.set(chatId, entry.seq);
    this.indexes
      .get(chatId)
      ?.ids.set(entry.id, { seq: entry.seq, offset, length: Buffer.byteLength(json) });
    return entry;
  }

  /** 升序返回 seq < beforeSeq 的最后 limit 条；从文件尾按块倒读 */
  readEntries(chatId: string, options: { beforeSeq?: number; limit?: number } = {}): GroupEntry[] {
    const { beforeSeq = Number.POSITIVE_INFINITY, limit = 100 } = options;
    const entries: GroupEntry[] = [];
    if (limit <= 0) return entries;
    for (const entry of this.backward(chatId, beforeSeq)) {
      if (entry.seq >= beforeSeq) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
    return entries.reverse();
  }

  /** 升序返回 seq > afterSeq 的全部条目（倒读到 afterSeq 为止） */
  readAfter(chatId: string, afterSeq: number): GroupEntry[] {
    return [...this.backward(chatId, undefined, afterSeq)].reverse();
  }

  /** renderer 增量拉取：缺口超过 limit 时退回最新一页（由调用方按缺口合并） */
  readSince(chatId: string, afterSeq: number, limit: number): GroupEntry[] {
    if (this.lastSeq(chatId) - afterSeq > limit) return this.readEntries(chatId, { limit });
    return this.readAfter(chatId, afterSeq);
  }

  /** 从新到旧逐条产出，读到 seq ≤ afterSeq 即停；提前 break 即停止读盘。给 beforeSeq 时可从已知检查点开始读 */
  *backward(
    chatId: string,
    beforeSeq = Number.POSITIVE_INFINITY,
    afterSeq = 0
  ): Generator<GroupEntry> {
    if (!isBotChatId(chatId)) return;
    let fd: number;
    try {
      fd = openSync(this.file(chatId), 'r');
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      let marks = this.checkpoints.get(chatId);
      if (!marks) {
        marks = new Map();
        this.checkpoints.set(chatId, marks);
      }
      let position = size;
      let floor = Number.POSITIVE_INFINITY;
      for (const [seq, offset] of marks) {
        if (offset > size) {
          marks.clear();
          position = size;
          floor = Number.POSITIVE_INFINITY;
          break;
        }
        // 该行之前的行 seq 都更小；挑 ≥ beforeSeq 的最近检查点
        if (seq >= beforeSeq && seq < floor) {
          floor = seq;
          position = offset;
        }
      }
      let carry = Buffer.alloc(0);
      const emit = (line: Buffer, offset: number) => {
        const entry = parseLine(line);
        if (!entry || entry.seq >= floor) return undefined;
        floor = entry.seq;
        if (entry.seq % CHECKPOINT_EVERY === 0) marks.set(entry.seq, offset);
        return entry;
      };
      while (position > 0) {
        const length = Math.min(this.chunkSize, position);
        position -= length;
        const chunk = Buffer.allocUnsafe(length);
        readSync(fd, chunk, 0, length, position);
        const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
        let end = data.length;
        while (end > 0) {
          const at = data.lastIndexOf(NEWLINE, end - 1);
          if (at < 0) break;
          const entry = emit(data.subarray(at + 1, end), position + at + 1);
          if (entry && entry.seq <= afterSeq) return;
          if (entry) yield entry;
          end = at;
        }
        carry = Buffer.from(data.subarray(0, end));
      }
      const entry = emit(carry, 0);
      if (entry && entry.seq > afterSeq) yield entry;
    } finally {
      closeSync(fd);
    }
  }

  /** 全量顺序扫描（异步分块，不长时间占用主线程）；每块产出一批 */
  async *scanEntries(chatId: string): AsyncGenerator<GroupEntry[]> {
    if (!isBotChatId(chatId)) return;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.file(chatId), 'r');
    } catch {
      return;
    }
    try {
      let carry = Buffer.alloc(0);
      let last = 0;
      const size = Math.max(this.chunkSize, 256 * 1024);
      for (;;) {
        const chunk = Buffer.allocUnsafe(size);
        const { bytesRead } = await handle.read(chunk, 0, size, null);
        const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        const batch: GroupEntry[] = [];
        const take = (line: Buffer) => {
          const entry = parseLine(line);
          if (!entry || entry.seq <= last) return;
          last = entry.seq;
          batch.push(entry);
        };
        const lines = splitLines(data, 0);
        let step = lines.next();
        for (; !step.done; step = lines.next()) take(step.value.line);
        carry = Buffer.from(step.value);
        if (bytesRead === 0) take(carry);
        if (batch.length > 0) yield batch;
        if (bytesRead === 0) return;
      }
    } finally {
      await handle.close();
    }
  }

  hasEntry(chatId: string, id: string): boolean {
    return this.index(chatId).ids.has(id);
  }

  /** 分隔线之前的条目首次查找时才补全索引 */
  findEntry(chatId: string, id: string): GroupEntry | undefined {
    const index = this.index(chatId);
    if (!index.ids.has(id) && index.rest > 0) this.scanIndex(chatId, index, 0);
    const hit = index.ids.get(id);
    if (!hit) return undefined;
    let fd: number;
    try {
      fd = openSync(this.file(chatId), 'r');
    } catch {
      return undefined;
    }
    try {
      const line = Buffer.allocUnsafe(hit.length);
      readSync(fd, line, 0, hit.length, hit.offset);
      const entry = parseLine(line);
      return entry?.id === id ? entry : undefined;
    } finally {
      closeSync(fd);
    }
  }

  /** 首次使用时从文件尾倒扫到群「新对话」分隔线建 id 索引（只取行首 seq/id，不整行解析） */
  private index(chatId: string): EntryIndex {
    const cached = this.indexes.get(chatId);
    if (cached) return cached;
    const index: EntryIndex = {
      ids: new Map(),
      rest: Number.POSITIVE_INFINITY,
      min: Number.POSITIVE_INFINITY,
    };
    if (!isBotChatId(chatId)) return { ...index, rest: 0 };
    this.scanIndex(chatId, index, this.chats.get(chatId)?.epochSeq ?? 0);
    this.indexes.set(chatId, index);
    return index;
  }

  /** 从 index.rest 往文件头倒扫，收录 seq > floor 的行；遇到 ≤ floor 的行停下并记住续扫位置 */
  private scanIndex(chatId: string, index: EntryIndex, floor: number): void {
    if (index.rest <= 0) return;
    let fd: number;
    try {
      fd = openSync(this.file(chatId), 'r');
    } catch {
      index.rest = 0;
      return;
    }
    try {
      const size = Math.max(this.chunkSize, 256 * 1024);
      let position = Math.min(index.rest, fstatSync(fd).size);
      let carry = Buffer.alloc(0);
      /** false = 到下限，停在这一行（含）之后 */
      const add = (line: Buffer, offset: number): boolean => {
        const head = indexHead(line);
        if (!head || head.seq >= index.min) return true;
        if (head.seq <= floor) {
          index.rest = offset + line.length;
          return false;
        }
        index.min = head.seq;
        index.ids.set(head.id, { seq: head.seq, offset, length: line.length });
        return true;
      };
      while (position > 0) {
        const length = Math.min(size, position);
        position -= length;
        const chunk = Buffer.allocUnsafe(length);
        readSync(fd, chunk, 0, length, position);
        const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
        let end = data.length;
        while (end > 0) {
          const at = data.lastIndexOf(NEWLINE, end - 1);
          if (at < 0) break;
          if (!add(data.subarray(at + 1, end), position + at + 1)) return;
          end = at;
        }
        carry = Buffer.from(data.subarray(0, end));
      }
      if (!add(carry, 0)) return;
      index.rest = 0;
    } finally {
      closeSync(fd);
    }
  }

  private file(chatId: string): string {
    return join(this.dir(chatId), TIMELINE);
  }

  private persist(chat: BotChat): void {
    writeJsonAtomic(join(this.dir(chat.id), 'chat.json'), withSchemaVersion('chat', chat));
    this.chats.set(chat.id, chat);
  }

  private dir(id: string): string {
    if (!isBotChatId(id)) throw new Error('Invalid chat id');
    return join(this.root, id);
  }
}

function indexHead(line: Buffer): { seq: number; id: string } | undefined {
  if (line.length === 0 || line[line.length - 1] !== 0x7d) return undefined;
  const match = ENTRY_HEAD.exec(line.toString('utf8', 0, Math.min(line.length, 256)));
  if (match) {
    try {
      const id = JSON.parse(match[2]) as string;
      const seq = Number(match[1]);
      if (id && Number.isSafeInteger(seq)) return { seq, id };
    } catch {
      /* fall through */
    }
  }
  const entry = parseLine(line);
  return entry && { seq: entry.seq, id: entry.id };
}

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFutureRecord, migrateRecord, withSchemaVersion } from '../../../shared/bots/migrations';
import {
  GROUP_TASK_TEXT_MAX,
  GROUP_TASK_TITLE_MAX,
  type GroupTask,
  isBotChatId,
  parseGroupTask,
} from '../../../shared/types/bot';
import { writeAtomic } from './files';

interface ChatTasks {
  tasks: Map<string, GroupTask>;
  maxSeq: number;
  /** 文件中的非空行数，用于判断冗余度 */
  lines: number;
  /** 更新 schema 写出的行：读不懂，但压缩时原样保留，其 seq 计入 maxSeq */
  future: string[];
}

/**
 * 群任务看板：userData/bot-chats/<chatId>/tasks.jsonl，append-only 整条快照（后写覆盖），
 * 删除写墓碑 `{id, seq, deleted:true}`；坏行 / 截断行跳过。seq 取历史最大值 +1，删除后不复用。
 * 读写都是同步的：Main 单线程下「读-判-写」天然原子，并发认领由调用方在一次同步调用里完成。
 * 冗余行达到 max(minRedundant, 任务数) 时原子重写为最新快照；被删的最大 seq 以一条墓碑保留。
 */
export class GroupTaskStore {
  private readonly cache = new Map<string, ChatTasks>();
  private readonly minRedundant: number;
  constructor(
    private readonly root: string,
    options: { minRedundant?: number } = {}
  ) {
    this.minRedundant = options.minRedundant ?? 200;
  }

  list(chatId: string): GroupTask[] {
    if (!isBotChatId(chatId)) return [];
    return [...this.load(chatId).tasks.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((task) => ({ ...task }));
  }

  /** id 或 `#N` / `N` */
  find(chatId: string, ref: string): GroupTask | undefined {
    if (!isBotChatId(chatId)) return undefined;
    const { tasks } = this.load(chatId);
    const direct = tasks.get(ref);
    if (direct) return { ...direct };
    const match = /^#?(\d+)$/.exec(ref.trim());
    if (!match) return undefined;
    const seq = Number(match[1]);
    const task = [...tasks.values()].find((item) => item.seq === seq);
    return task && { ...task };
  }

  create(
    chatId: string,
    input: {
      title: string;
      detail?: string;
      check?: GroupTask['check'];
      createdBy: GroupTask['createdBy'];
    },
    now: number
  ): GroupTask | undefined {
    if (!isBotChatId(chatId)) return undefined;
    const title = input.title.trim().slice(0, GROUP_TASK_TITLE_MAX);
    if (!title) return undefined;
    const detail = input.detail?.trim().slice(0, GROUP_TASK_TEXT_MAX);
    const task: GroupTask = {
      id: randomUUID(),
      seq: this.load(chatId).maxSeq + 1,
      title,
      ...(detail ? { detail } : {}),
      ...(input.check ? { check: input.check } : {}),
      status: 'todo',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    return this.save(chatId, task);
  }

  save(chatId: string, task: GroupTask): GroupTask | undefined {
    const parsed = isBotChatId(chatId) ? parseGroupTask(task) : undefined;
    if (!parsed) return undefined;
    const state = this.load(chatId);
    this.append(chatId, withSchemaVersion('task', parsed));
    state.tasks.set(parsed.id, parsed);
    state.maxSeq = Math.max(state.maxSeq, parsed.seq);
    this.compactIfRedundant(chatId, state);
    return { ...parsed };
  }

  remove(chatId: string, id: string): boolean {
    if (!isBotChatId(chatId)) return false;
    const state = this.load(chatId);
    const task = state.tasks.get(id);
    if (!task) return false;
    this.append(chatId, { id, seq: task.seq, deleted: true });
    state.tasks.delete(id);
    this.compactIfRedundant(chatId, state);
    return true;
  }

  /** 聊天目录被删后丢掉缓存 */
  forget(chatId: string): void {
    this.cache.delete(chatId);
  }

  private file(chatId: string): string {
    return join(this.root, chatId, 'tasks.jsonl');
  }

  private append(chatId: string, record: unknown): void {
    mkdirSync(join(this.root, chatId), { recursive: true });
    // 前导换行把上次可能撕裂的末行隔开
    appendFileSync(this.file(chatId), `\n${JSON.stringify(record)}\n`, 'utf8');
    const state = this.cache.get(chatId);
    if (state) state.lines++;
  }

  private compactIfRedundant(chatId: string, state: ChatTasks): void {
    const kept = state.tasks.size + state.future.length;
    if (state.lines - kept < Math.max(this.minRedundant, kept)) return;
    const records: unknown[] = [...state.tasks.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((task) => withSchemaVersion('task', task));
    const top = Math.max(0, ...[...state.tasks.values()].map((task) => task.seq));
    if (state.maxSeq > top) records.push({ id: 'seq-floor', seq: state.maxSeq, deleted: true });
    const lines = [...records.map((record) => JSON.stringify(record)), ...state.future];
    try {
      writeAtomic(this.file(chatId), `${lines.join('\n')}\n`);
      state.lines = lines.length;
    } catch (error) {
      console.warn('[bots] tasks compaction failed', chatId, error);
    }
  }

  private load(chatId: string): ChatTasks {
    const cached = this.cache.get(chatId);
    if (cached) return cached;
    const state: ChatTasks = { tasks: new Map(), maxSeq: 0, lines: 0, future: [] };
    let text = '';
    try {
      text = readFileSync(this.file(chatId), 'utf8');
    } catch {
      /* 尚无任务 */
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      state.lines++;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (isFutureRecord('task', value)) {
          state.future.push(line);
          if (Number.isSafeInteger(value.seq))
            state.maxSeq = Math.max(state.maxSeq, value.seq as number);
          continue;
        }
        if (value?.deleted === true && typeof value.id === 'string') {
          state.tasks.delete(value.id);
          if (Number.isSafeInteger(value.seq))
            state.maxSeq = Math.max(state.maxSeq, value.seq as number);
          continue;
        }
        const task = parseGroupTask(migrateRecord('task', value));
        if (!task) continue;
        state.tasks.set(task.id, task);
        state.maxSeq = Math.max(state.maxSeq, task.seq);
      } catch {
        /* torn or invalid line */
      }
    }
    this.cache.set(chatId, state);
    this.compactIfRedundant(chatId, state);
    return state;
  }
}

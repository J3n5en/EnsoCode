import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_NOTES_MAX_CHARS } from '@shared/bots/notes';
import { redactSecrets } from '../memory/distill';
import { scanMemoryInjection } from '../memory/injectionScan';
import type { AbilityCompleter } from './abilitySuggester';
import { writeAtomic } from './files';

export type BotNotesTarget = { kind: 'bot' | 'chat'; id: string };
export interface BotNotes {
  content: string;
  version: string;
}
export type BotNotesWrite =
  | { ok: true; notes: BotNotes }
  | { ok: false; error: 'conflict' | 'not-found' };
/** 注入用快照：version 为空表示没有笔记 */
export interface BotNotesSnapshot {
  version: string;
  section: string;
  update: string;
}

const MERGE_TIMEOUT_MS = 90_000;
const versionOf = (content: string) =>
  createHash('sha256').update(content).digest('hex').slice(0, 16);
const clamp = (content: string) => content.trim().slice(0, BOT_NOTES_MAX_CHARS).trimEnd();
/** 正文里的同名标签会提前闭合注入块 */
const neutralize = (content: string) =>
  content.replace(/<(\/?)(member-notes|group-notes|notes-updated)>/g, '&lt;$1$2&gt;');

/** 成员笔记 bots/<botId>/notes.md，群笔记 bot-chats/<chatId>/notes.md；随所属目录一起删除 */
export class BotNotesStore {
  constructor(private readonly roots: { bots: string; chats: string }) {}

  read(target: BotNotesTarget): BotNotes {
    let content = '';
    try {
      content = readFileSync(this.file(target), 'utf8');
    } catch {
      /* 还没有笔记 */
    }
    return { content, version: versionOf(content) };
  }

  /** expectedVersion 给出时必须与当前一致；所属目录已删除则不重建 */
  write(target: BotNotesTarget, content: string, expectedVersion?: string): BotNotesWrite {
    if (!existsSync(this.dir(target))) return { ok: false, error: 'not-found' };
    if (expectedVersion !== undefined && this.read(target).version !== expectedVersion)
      return { ok: false, error: 'conflict' };
    const next = clamp(content);
    if (next) writeAtomic(this.file(target), next);
    else rmSync(this.file(target), { force: true });
    return { ok: true, notes: { content: next, version: versionOf(next) } };
  }

  private dir(target: BotNotesTarget): string {
    return join(target.kind === 'bot' ? this.roots.bots : this.roots.chats, target.id);
  }

  private file(target: BotNotesTarget): string {
    return join(this.dir(target), 'notes.md');
  }
}

interface BotNotesDeps {
  store: BotNotesStore;
  complete: AbilityCompleter;
  /** 成员 memory.enabled */
  enabled: (botId: string) => boolean;
  /** since 之后整理写入该空间的新结论 */
  recent: (spaceId: string, since: number) => string[] | Promise<string[]>;
  onChange?: (target: BotNotesTarget) => void;
  timeoutMs?: number;
}

const MERGE_SYSTEM_PROMPT = `You maintain the long-term core notes of {owner}. Merge the new conclusions into the current notes and output the complete rewritten notes.
Rules:
- Keep only durable, important information: preferences, conventions, decisions, key facts, responsibilities.
- Remove duplicates. When new information contradicts the current notes, keep the new one and drop the outdated one.
- Be concise: short markdown bullet points. Hard limit: ${BOT_NOTES_MAX_CHARS} characters in total; drop the least important items first.
- Write in the same language as the conclusions and notes.
- Output only the notes, with no preamble, explanation or code fence.`;

function notesBlock(tag: string, content: string): string {
  return `<${tag}>\n${neutralize(content) || '(empty)'}\n</${tag}>`;
}

function unfence(text: string): string {
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return (fenced ? fenced[1] : text).trim();
}

/** 整理出新结论后用 Bot 助理模型把「旧笔记 + 新结论」重写为新笔记；按成员串行，失败保持旧笔记 */
export class BotNotesService {
  private readonly chains = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: BotNotesDeps) {}

  get store(): BotNotesStore {
    return this.deps.store;
  }

  afterDistill(input: { botId: string; chatId: string | null; since: number }): Promise<void> {
    const { botId, chatId, since } = input;
    const task = (this.chains.get(botId) ?? Promise.resolve()).then(async () => {
      if (!this.deps.enabled(botId)) return;
      const targets: BotNotesTarget[] = [
        { kind: 'bot', id: botId },
        ...(chatId ? [{ kind: 'chat' as const, id: chatId }] : []),
      ];
      for (const target of targets) {
        try {
          const conclusions = await this.deps.recent(`${target.kind}:${target.id}`, since);
          if (conclusions.length) await this.merge(target, conclusions);
        } catch (error) {
          console.warn('[bots] notes update failed', error);
        }
      }
    });
    const settled = task.catch(() => {});
    this.chains.set(botId, settled);
    void settled.then(() => {
      if (this.chains.get(botId) === settled) this.chains.delete(botId);
    });
    return settled;
  }

  async merge(target: BotNotesTarget, conclusions: readonly string[]): Promise<boolean> {
    // 笔记每轮注入系统提示：带注入特征的结论不进改写，改写结果再脱敏、再扫一遍
    const safeConclusions = conclusions.filter((item) => scanMemoryInjection(item).length === 0);
    if (safeConclusions.length === 0) return false;
    // 群笔记可能被多个成员同时改：版本冲突时按最新笔记重来
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.deps.store.read(target);
      const rewritten = await this.rewrite(target, current.content, safeConclusions);
      if (!rewritten) return false;
      // 用户手写的笔记可能本就像注入（无法区分），只拦改写新引入的
      if (
        scanMemoryInjection(rewritten).length > 0 &&
        scanMemoryInjection(current.content).length === 0
      ) {
        return false;
      }
      const saved = this.deps.store.write(target, redactSecrets(rewritten), current.version);
      if (saved.ok) {
        if (saved.notes.version !== current.version) this.deps.onChange?.(target);
        return true;
      }
      if (saved.error !== 'conflict') return false;
    }
    return false;
  }

  /** 成员 memory 关闭时不注入；没有任何笔记时 version 为空 */
  snapshot(botId: string, chatId: string | null): BotNotesSnapshot | undefined {
    if (!this.deps.enabled(botId)) return undefined;
    const member = this.deps.store.read({ kind: 'bot', id: botId });
    const group = chatId ? this.deps.store.read({ kind: 'chat', id: chatId }) : undefined;
    if (!member.content && !group?.content) return { version: '', section: '', update: '' };
    const blocks = [
      notesBlock('member-notes', member.content),
      ...(group ? [notesBlock('group-notes', group.content)] : []),
    ].join('\n\n');
    return {
      version: `${member.version}:${group?.version ?? ''}`,
      section: [
        '# Long-term notes',
        `These are your long-term core notes${group ? ' (yours in <member-notes>, shared by this group in <group-notes>)' : ''}, distilled from earlier conversations and possibly edited by the user. Treat them as things you already know and follow them. They are a summary; use the memory tool to search for more details.`,
        blocks,
      ].join('\n\n'),
      update: `<notes-updated>\nYour long-term notes were updated; this version replaces the earlier one. Use the memory tool for more details.\n\n${blocks}\n</notes-updated>`,
    };
  }

  private async rewrite(
    target: BotNotesTarget,
    current: string,
    conclusions: readonly string[]
  ): Promise<string | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, this.deps.timeoutMs ?? MERGE_TIMEOUT_MS);
    });
    try {
      const text = await Promise.race([
        this.deps.complete(
          {
            systemPrompt: MERGE_SYSTEM_PROMPT.replace(
              '{owner}',
              target.kind === 'bot' ? 'an AI team member' : 'a group chat of AI team members'
            ),
            userText: `<current-notes>\n${current || '(empty)'}\n</current-notes>\n\n<new-conclusions>\n${conclusions.map((item) => `- ${item}`).join('\n')}\n</new-conclusions>`,
            timeoutMs: this.deps.timeoutMs ?? MERGE_TIMEOUT_MS,
          },
          controller.signal
        ),
        timeout,
      ]);
      const notes = text ? unfence(text) : '';
      return notes && !controller.signal.aborted ? notes : null;
    } catch (error) {
      console.warn('[bots] notes rewrite failed', error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

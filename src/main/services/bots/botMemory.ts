import type { DistillPayload } from '../memory/distill';
import { type MemoryAuthority, memorySpaceContext } from '../memory/space';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import { readJson, writeJsonAtomic } from './files';
import { rewoundWatermark } from './rewind';

interface MemoryConversation extends MemoryAuthority {
  conversationId: string;
  sessionFile?: string;
}
interface BotMemoryDeps {
  bots: BotStore;
  chats: BotChatStore;
  isCodeProject: (projectId: string) => boolean;
  schedule: (payload: DistillPayload) => Promise<string | undefined>;
  watermarksFile?: string;
  /** 整理推进了水位（有新内容被整理）后通知；since 为本次整理开始时间 */
  onDistilled?: (input: { botId: string; chatId: string | null; since: number }) => void;
}

export class BotMemoryService {
  private pending = new Map<string, Promise<void>>();
  private readonly watermarks = new Map<string, string>();
  private readonly removed = new Set<string>();
  private disposed = false;
  constructor(private readonly deps: BotMemoryDeps) {
    const saved = deps.watermarksFile ? readJson(deps.watermarksFile) : undefined;
    if (saved && typeof saved === 'object' && !Array.isArray(saved))
      for (const [id, entry] of Object.entries(saved))
        if (typeof entry === 'string' && entry) this.watermarks.set(id, entry);
  }

  remove(conversationId: string): void {
    this.watermarks.delete(conversationId);
    if (this.pending.has(conversationId)) this.removed.add(conversationId);
    this.persist();
  }

  /** 私聊回退：水位若在被裁掉的部分，退回到回退点之前，避免下次整理回落为全量重复整理 */
  rewind(conversationId: string, branch: readonly string[], targetEntryId: string): void {
    const conversation = this.deps.chats
      .list()
      .flatMap((chat) =>
        Object.entries(chat.sessions).map(([botId, session]) => ({ chat, botId, session }))
      )
      .find((item) => item.session.conversationId === conversationId);
    const current =
      this.watermarks.get(conversationId) ?? conversation?.session.distilledTo ?? undefined;
    const moved = rewoundWatermark(branch, targetEntryId, current);
    if (!moved) return;
    if (moved.next) this.watermarks.set(conversationId, moved.next);
    else this.watermarks.delete(conversationId);
    this.persist();
    if (conversation)
      this.deps.chats.update(conversation.chat.id, (draft) => {
        const session = draft.sessions[conversation.botId];
        if (session?.conversationId !== conversationId) return draft;
        if (moved.next) session.distilledTo = moved.next;
        else delete session.distilledTo;
        return draft;
      });
  }

  dispose(): void {
    this.disposed = true;
    this.watermarks.clear();
  }

  private persist(): void {
    if (this.deps.watermarksFile)
      writeJsonAtomic(this.deps.watermarksFile, Object.fromEntries(this.watermarks));
  }

  context(conversation: MemoryAuthority) {
    const bot = conversation.bot;
    const chat = bot?.chatId ? this.deps.chats.get(bot.chatId) : undefined;
    return {
      enabled: !bot || this.deps.bots.get(bot.botId)?.memory.enabled === true,
      context: memorySpaceContext(
        {
          projectId: conversation.projectId,
          ...(bot
            ? { bot: { botId: bot.botId, chatId: chat?.kind === 'group' ? chat.id : null } }
            : {}),
        },
        this.deps.isCodeProject
      ),
    };
  }

  distill(conversation: MemoryConversation): Promise<void> {
    const id = conversation.conversationId;
    const task = (this.pending.get(id) ?? Promise.resolve())
      .then(async () => {
        if (this.disposed || this.removed.has(id)) return;
        const { enabled, context } = this.context(conversation);
        if (!enabled || !conversation.sessionFile) return;
        const binding = conversation.bot;
        const chat = binding?.chatId ? this.deps.chats.get(binding.chatId) : undefined;
        const session = binding ? chat?.sessions[binding.botId] : undefined;
        const fromEntryId =
          this.watermarks.get(id) ??
          (session?.conversationId === id ? session.distilledTo : undefined);
        const since = Date.now();
        const next = await this.deps.schedule({
          sessionId: id,
          sessionFile: conversation.sessionFile,
          projectId: context.projectId ?? null,
          ...(context.botId ? { botId: context.botId } : {}),
          ...(context.botId && context.chatId ? { chatId: context.chatId } : {}),
          ...(fromEntryId ? { fromEntryId } : {}),
        });
        if (this.disposed || this.removed.has(id)) return;
        if (next) {
          this.watermarks.set(id, next);
          this.persist();
        }
        if (next && next !== fromEntryId && context.botId)
          this.deps.onDistilled?.({ botId: context.botId, chatId: context.chatId ?? null, since });
        if (
          next &&
          chat &&
          binding &&
          this.deps.chats.get(chat.id)?.sessions[binding.botId]?.conversationId === id
        ) {
          this.deps.chats.update(chat.id, (draft) => {
            draft.sessions[binding.botId].distilledTo = next;
            return draft;
          });
        }
      })
      .catch((error) => console.warn('[bots] memory distill failed', error));
    this.pending.set(id, task);
    void task.then(() => {
      if (this.pending.get(id) === task) {
        this.pending.delete(id);
        this.removed.delete(id);
      }
    });
    return task;
  }
}

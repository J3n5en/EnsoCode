import {
  budgetInboxItems,
  delegationInboxItems,
  INBOX_DISMISSIBLE,
  routineInboxItems,
  silenceInboxItems,
} from '../../../shared/bots/inbox';
import type { AgentWorkerEvent, ConversationAuthority } from '../../../shared/types/agent';
import type { BotRoutine, Delegation } from '../../../shared/types/bot';
import type { BotEvent, BotInboxItem, BotSilence } from '../../../shared/types/botIpc';
import type { BotUsageOverview } from '../../../shared/usage/botUsage';
import type { BotInboxStore } from './inboxStore';

export interface BotInboxDeps {
  store: BotInboxStore;
  conversation: (conversationId: string) => ConversationAuthority | undefined;
  delegations: () => readonly Delegation[];
  routines: () => readonly BotRoutine[];
  usage: () => Promise<{ day: string; bots: Record<string, BotUsageOverview> }>;
  silences: () => readonly BotSilence[];
  emit: (event: BotEvent) => void;
}

const TEXT_MAX = 200;
const clip = (text: string) => text.replace(/\s+/gu, ' ').trim().slice(0, TEXT_MAX);

const rootOf = (identity: { sessionId: string; parent?: { sessionId: string } }): string => {
  const raw = identity.parent?.sessionId ?? identity.sessionId;
  const sep = raw.indexOf('::');
  return sep === -1 ? raw : raw.slice(0, sep);
};

/**
 * Bot 收件箱（Main 权威）：审批 / 提问来自 worker 事件，其余从各自权威数据全量推导；
 * 结果落 inbox.jsonl，变化推 BotEvent{kind:'inbox'}。
 */
export class BotInboxService {
  private budgetDay = '';

  constructor(private readonly deps: BotInboxDeps) {
    // 新进程：上一进程的审批、提问与静默都已不存在
    let changed = deps.store.sync(['approval', 'ask', 'silence'], []);
    changed = this.syncSources() || changed;
    if (changed) this.changed();
    void this.syncBudget();
  }

  list(): BotInboxItem[] {
    // 跨自然日：昨天的预算提示结束、今天的重新判断
    if (this.budgetDay && this.budgetDay !== new Date().toDateString()) void this.syncBudget();
    return this.deps.store.list();
  }

  dismiss(key: string): { ok: true } | { ok: false; error: string } {
    const item = this.deps.store.get(key);
    if (!item || item.resolvedAt !== undefined) return { ok: false, error: 'not-found' };
    if (!INBOX_DISMISSIBLE.includes(item.kind)) return { ok: false, error: 'not-dismissible' };
    if (this.deps.store.dismiss(key)) this.changed();
    return { ok: true };
  }

  reopen(key: string): { ok: true } | { ok: false; error: string } {
    const item = this.deps.store.get(key);
    if (!item || item.resolvedAt !== undefined) return { ok: false, error: 'not-found' };
    if (this.deps.store.reopen(key)) this.changed();
    return { ok: true };
  }

  observe(event: AgentWorkerEvent | { type: 'worker-exited' }): void {
    if (event.type === 'worker-exited') {
      if (this.deps.store.sync(['approval', 'ask'], [])) this.changed();
      return;
    }
    if (!('identity' in event) || !event.identity) return;
    const conversationId = rootOf(event.identity as { sessionId: string });
    switch (event.type) {
      case 'approval-request':
      case 'ask-request': {
        const owner = this.owner(conversationId);
        if (!owner) return;
        const changed =
          event.type === 'approval-request'
            ? this.deps.store.upsert({
                key: `approval:${conversationId}:${event.request.requestId}`,
                kind: 'approval',
                ...owner,
                conversationId,
                approval: event.request,
                text: clip(`${event.request.tool} · ${event.request.summary}`),
              })
            : this.deps.store.upsert({
                key: `ask:${conversationId}:${event.ask.requestId}`,
                kind: 'ask',
                ...owner,
                conversationId,
                ask: event.ask,
                text: clip(event.ask.question),
              });
        if (changed) this.changed();
        return;
      }
      case 'approval-resolved':
      case 'ask-resolved': {
        const kind = event.type === 'approval-resolved' ? 'approval' : 'ask';
        if (this.deps.store.resolve(`${kind}:${conversationId}:${event.requestId}`)) this.changed();
        return;
      }
      case 'parent-ended':
      case 'parent-rejected':
        if (!('parent' in event.identity)) this.turnFinished(conversationId);
        return;
      default:
        return;
    }
  }

  /** 回合结束（含中止）：该会话残留的审批与提问随之结束 */
  turnFinished(conversationId: string): void {
    let changed = false;
    for (const item of this.deps.store.list())
      if (
        (item.kind === 'approval' || item.kind === 'ask') &&
        item.conversationId === conversationId
      )
        changed = this.deps.store.resolve(item.key) || changed;
    if (changed) this.changed();
  }

  onBotEvent(event: BotEvent): void {
    let changed = false;
    switch (event.kind) {
      case 'delegation':
        changed = this.deps.store.sync(
          ['delegation-interrupted'],
          delegationInboxItems(this.deps.delegations())
        );
        break;
      case 'routine':
        changed = this.deps.store.sync(
          ['routine-draft', 'routine-blocked'],
          routineInboxItems(this.deps.routines())
        );
        break;
      case 'silence':
        changed = this.syncSilences();
        break;
      case 'budget':
      case 'catalog':
        void this.syncBudget();
        break;
      default:
        return;
    }
    if (changed) this.changed();
  }

  private syncSources(): boolean {
    const delegations = this.deps.store.sync(
      ['delegation-interrupted'],
      delegationInboxItems(this.deps.delegations())
    );
    const routines = this.deps.store.sync(
      ['routine-draft', 'routine-blocked'],
      routineInboxItems(this.deps.routines())
    );
    return delegations || routines;
  }

  private syncSilences(): boolean {
    return this.deps.store.sync(
      ['silence'],
      silenceInboxItems(this.deps.silences(), this.deps.delegations())
    );
  }

  private async syncBudget(): Promise<void> {
    try {
      const overview = await this.deps.usage();
      this.budgetDay = new Date().toDateString();
      if (this.deps.store.sync(['budget'], budgetInboxItems(overview))) this.changed();
    } catch (error) {
      console.warn('[bots] inbox budget sync failed', error);
    }
  }

  /** 会话 → 聊天与成员；委派会话归到发起委派的聊天，并记下委托方 */
  private owner(
    conversationId: string
  ): Pick<BotInboxItem, 'chatId' | 'botId' | 'delegationId' | 'ownerBotId'> | undefined {
    const binding = this.deps.conversation(conversationId)?.bot;
    if (!binding) return undefined;
    if (!binding.delegationId) return { chatId: binding.chatId, botId: binding.botId };
    const record = this.deps.delegations().find((item) => item.id === binding.delegationId);
    return {
      chatId: binding.chatId ?? record?.chatId ?? null,
      botId: binding.botId,
      delegationId: binding.delegationId,
      ...(record ? { ownerBotId: record.parentBotId } : {}),
    };
  }

  private changed(): void {
    this.deps.emit({ kind: 'inbox' });
  }
}

import type { ConversationAuthority, ProjectedMessage } from '../../../shared/types/agent';
import type { BotProfile } from '../../../shared/types/bot';
import { localDayKey } from '../../../shared/usage/aggregate';
import {
  attributeBotRecords,
  type BotBudgetVerdict,
  type BotUsageOverview,
  type BotUsageRow,
  botOfConversation,
  budgetVerdict,
  localDayStart,
  sumBotUsage,
} from '../../../shared/usage/botUsage';
import { costOf, type PricingTable } from '../../../shared/usage/pricing';
import type { UsageRangeDays, UsageRecord } from '../../../shared/usage/types';

export interface BotUsageDeps {
  bots: { get(id: string): BotProfile | undefined; list(): BotProfile[] };
  /** 全部 bot 会话 authority（私聊、群聊、委派子会话） */
  conversations: () => readonly ConversationAuthority[];
  /** 读 pi jsonl 的用量记录（复用用量页解析缓存） */
  load: (file: string) => Promise<{ records: UsageRecord[] } | null>;
  pricing: (now: number) => Promise<PricingTable>;
  now?: () => number;
}

interface Ledger {
  /** undefined = 首次读盘进行中，期间到达的消息暂存 */
  records?: Map<string, UsageRecord>;
  pending: UsageRecord[];
  ready: Promise<void>;
}

/** 按成员归集 bot 会话的用量：排行、概览与日预算判定共用同一数据源 */
export class BotUsageService {
  /** 日预算判定用的今日账本：成员首次判定时读一次 jsonl，之后由 record 增量累计 */
  private readonly ledgers = new Map<string, Ledger>();
  private day = 0;
  private priced?: { day: number; table: PricingTable };

  constructor(private readonly deps: BotUsageDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async records(botId?: string): Promise<Map<string, UsageRecord[]>> {
    const sessions: { botId: string; records: UsageRecord[] }[] = [];
    for (const conversation of this.deps.conversations()) {
      const owner = botOfConversation(conversation);
      if (!owner || !conversation.sessionFile || (botId && owner !== botId)) continue;
      const parsed = await this.deps.load(conversation.sessionFile).catch(() => null);
      if (parsed) sessions.push({ botId: owner, records: parsed.records });
    }
    return attributeBotRecords(sessions);
  }

  /** 与用量页同一周期口径：[今天 00:00 + 1 天 - days 天, 明天 00:00) */
  async summary(days: UsageRangeDays): Promise<BotUsageRow[]> {
    const now = this.now();
    const [byBot, pricing] = await Promise.all([this.records(), this.deps.pricing(now)]);
    const start = localDayStart(now, 1 - days);
    const end = localDayStart(now, 1);
    const rows: BotUsageRow[] = [];
    for (const [botId, records] of byBot) {
      const totals = sumBotUsage(records, pricing, start, end);
      if (totals.messages === 0) continue;
      rows.push({ botId, name: this.deps.bots.get(botId)?.name ?? '', ...totals });
    }
    return rows.sort((a, b) => b.tokens - a.tokens);
  }

  async overview(): Promise<{ day: string; bots: Record<string, BotUsageOverview> }> {
    const now = this.now();
    const [byBot, pricing] = await Promise.all([this.records(), this.deps.pricing(now)]);
    const end = localDayStart(now, 1);
    const bots: Record<string, BotUsageOverview> = {};
    for (const bot of this.deps.bots.list()) {
      const records = byBot.get(bot.id) ?? [];
      const today = sumBotUsage(records, pricing, localDayStart(now), end);
      const exhausted = budgetVerdict(bot.budget, today);
      bots[bot.id] = {
        today,
        week: sumBotUsage(records, pricing, localDayStart(now, -6), end),
        month: sumBotUsage(records, pricing, localDayStart(now, -29), end),
        ...(exhausted ? { exhausted } : {}),
      };
    }
    return { day: localDayKey(now), bots };
  }

  /** 今日（本地自然日）已用 + reservedTokens 是否触达该成员的上限 */
  async exceeded(botId: string, reservedTokens = 0): Promise<BotBudgetVerdict | null> {
    await this.prepare(botId);
    return this.verdict(botId, reservedTokens);
  }

  /** 判定前备好该成员的今日账本与定价；未设预算不读文件 */
  async prepare(botId: string): Promise<void> {
    const budget = this.deps.bots.get(botId)?.budget;
    if (!budget) return;
    this.rollover();
    let ledger = this.ledgers.get(botId);
    if (!ledger) {
      const created: Ledger = { pending: [], ready: Promise.resolve() };
      created.ready = this.load(botId, created);
      this.ledgers.set(botId, created);
      ledger = created;
    }
    await Promise.all([
      ledger.ready,
      budget.dailyCostUsd !== undefined ? this.pricing() : undefined,
    ]);
  }

  /** prepare 之后同步判定：调用方在同一同步段里登记预留，并发回合不会一起越过上限 */
  verdict(botId: string, reservedTokens: number): BotBudgetVerdict | null {
    const bot = this.deps.bots.get(botId);
    if (!bot?.budget) return null;
    this.rollover();
    const now = this.now();
    const table = this.priced?.day === this.day ? this.priced.table : {};
    const today = sumBotUsage(
      [...(this.ledgers.get(botId)?.records?.values() ?? [])],
      table,
      localDayStart(now),
      localDayStart(now, 1)
    );
    if (reservedTokens > 0) {
      const rate =
        today.cost && today.tokens
          ? today.cost / today.tokens
          : (costOf(
              {
                model: bot.engine?.modelId ?? '',
                input: 1,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              table
            ) ?? 0);
      today.tokens += reservedTokens;
      if (today.cost !== null || rate > 0) today.cost = (today.cost ?? 0) + rate * reservedTokens;
    }
    return budgetVerdict(bot.budget, today);
  }

  /** 一条 assistant 消息结束：计入该成员今日账本；账本未建立时忽略（之后读盘会读到） */
  record(botId: string, conversationId: string, index: number, message: ProjectedMessage): void {
    const ledger = this.ledgers.get(botId);
    const usage = message.usage;
    if (!ledger || !usage) return;
    this.rollover();
    const ts = message.timestamp ?? this.now();
    if (ts < this.day) return;
    const entry: UsageRecord = {
      id:
        message.timestamp !== undefined ? `${conversationId}:${ts}` : `${conversationId}#${index}`,
      ts,
      model: message.model ?? 'unknown',
      provider: '',
      project: '',
      sessionId: conversationId,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      reasoning: 0,
    };
    if (ledger.records) ledger.records.set(entry.id, entry);
    else ledger.pending.push(entry);
  }

  private async load(botId: string, ledger: Ledger): Promise<void> {
    const start = this.day;
    const records = new Map<string, UsageRecord>();
    const seen = new Set<string>();
    for (const conversation of this.deps.conversations()) {
      if (botOfConversation(conversation) !== botId || !conversation.sessionFile) continue;
      const parsed = await this.deps.load(conversation.sessionFile).catch(() => null);
      for (const record of parsed?.records ?? []) {
        if (record.ts < start || !record.id || seen.has(record.id)) continue;
        seen.add(record.id);
        const id = `${conversation.conversationId}:${record.ts}`;
        records.set(id, { ...record, id });
      }
    }
    for (const record of ledger.pending) if (record.ts >= this.day) records.set(record.id, record);
    ledger.pending = [];
    ledger.records = records;
  }

  private rollover(): void {
    const day = localDayStart(this.now());
    if (day === this.day) return;
    this.day = day;
    for (const ledger of this.ledgers.values()) {
      for (const [id, record] of ledger.records ?? [])
        if (record.ts < day) ledger.records?.delete(id);
      ledger.pending = ledger.pending.filter((record) => record.ts >= day);
    }
  }

  private async pricing(): Promise<void> {
    if (this.priced?.day === this.day) return;
    const day = this.day;
    const table = await this.deps.pricing(this.now());
    this.priced = { day, table };
  }
}

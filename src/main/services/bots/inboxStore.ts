import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BotInboxInput } from '../../../shared/bots/inbox';
import type { BotInboxItem, BotInboxKind } from '../../../shared/types/botIpc';
import { writeAtomic } from './files';

const KINDS: readonly BotInboxKind[] = [
  'approval',
  'ask',
  'delegation-interrupted',
  'budget',
  'routine-draft',
  'routine-blocked',
  'silence',
];
const OPTIONAL_TEXT = ['botId', 'conversationId', 'delegationId', 'ownerBotId', 'text'] as const;
const OPTIONAL_TIME = ['since', 'dismissedAt', 'resolvedAt'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** 读盘收窄：字段类型不对就丢掉该字段，必需字段缺失整条丢弃 */
export function parseInboxItem(value: unknown): BotInboxItem | undefined {
  if (
    !isObject(value) ||
    typeof value.key !== 'string' ||
    !value.key ||
    !KINDS.includes(value.kind as BotInboxKind) ||
    !(value.chatId === null || typeof value.chatId === 'string') ||
    !isTime(value.createdAt) ||
    !isTime(value.updatedAt)
  )
    return undefined;
  const item: BotInboxItem = {
    key: value.key,
    kind: value.kind as BotInboxKind,
    chatId: value.chatId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  for (const field of OPTIONAL_TEXT)
    if (typeof value[field] === 'string') item[field] = value[field] as string;
  for (const field of OPTIONAL_TIME) if (isTime(value[field])) item[field] = value[field];
  const { routine, approval, ask, budget } = value;
  if (isObject(routine) && typeof routine.botId === 'string' && typeof routine.id === 'string')
    item.routine = { botId: routine.botId, id: routine.id };
  if (isObject(approval) && typeof approval.requestId === 'string')
    item.approval = approval as unknown as BotInboxItem['approval'];
  if (isObject(ask) && typeof ask.requestId === 'string')
    item.ask = ask as unknown as BotInboxItem['ask'];
  if (
    isObject(budget) &&
    (budget.reason === 'cost' || budget.reason === 'tokens') &&
    typeof budget.day === 'string'
  )
    item.budget = { reason: budget.reason, day: budget.day };
  return item;
}

const payload = (item: BotInboxInput | BotInboxItem): string => {
  const {
    createdAt: _c,
    updatedAt: _u,
    dismissedAt: _d,
    resolvedAt: _r,
    ...rest
  } = item as BotInboxItem;
  return JSON.stringify(canonical(rest));
};

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;

export interface BotInboxStoreOptions {
  now?: () => number;
  /** 已结束条目保留时长；超出后加载时丢弃 */
  retentionMs?: number;
  /** 冗余行达到 max(此值, 记录数) 时原子重写 */
  minRedundant?: number;
}

/** inbox.jsonl：append-only 整条快照，按 key 后写覆盖；忽略状态随记录持久 */
export class BotInboxStore {
  private readonly items = new Map<string, BotInboxItem>();
  private readonly now: () => number;
  private readonly minRedundant: number;
  private lines = 0;

  constructor(
    private readonly file: string,
    options: BotInboxStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.minRedundant = options.minRedundant ?? 200;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      this.lines++;
      try {
        const item = parseInboxItem(JSON.parse(line));
        if (item) this.items.set(item.key, item);
      } catch {
        /* torn line */
      }
    }
    const cutoff = this.now() - (options.retentionMs ?? 7 * 86_400_000);
    let expired = false;
    for (const [key, item] of this.items)
      if (item.resolvedAt !== undefined && item.resolvedAt < cutoff) {
        this.items.delete(key);
        expired = true;
      }
    if (expired || this.redundant()) this.compact();
  }

  /** 未结束的条目（含已忽略），按出现先后 */
  list(): BotInboxItem[] {
    return [...this.items.values()]
      .filter((item) => item.resolvedAt === undefined)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((item) => ({ ...item }));
  }

  get(key: string): BotInboxItem | undefined {
    const item = this.items.get(key);
    return item && { ...item };
  }

  /** 新建或更新；已结束的同 key 再出现时重新打开（清掉忽略） */
  upsert(input: BotInboxInput): boolean {
    const now = this.now();
    const current = this.items.get(input.key);
    if (!current || current.resolvedAt !== undefined) {
      this.write({ ...input, createdAt: now, updatedAt: now });
      return true;
    }
    if (payload(current) === payload(input)) return false;
    this.write({
      ...input,
      createdAt: current.createdAt,
      updatedAt: now,
      ...(current.dismissedAt !== undefined ? { dismissedAt: current.dismissedAt } : {}),
    });
    return true;
  }

  resolve(key: string): boolean {
    const current = this.items.get(key);
    if (!current || current.resolvedAt !== undefined) return false;
    const now = this.now();
    this.write({ ...current, updatedAt: now, resolvedAt: now });
    return true;
  }

  /** 某几类来源的全量：不在 inputs 里的活跃条目结束，其余 upsert */
  sync(kinds: readonly BotInboxKind[], inputs: readonly BotInboxInput[]): boolean {
    const keys = new Set(inputs.map((input) => input.key));
    let changed = false;
    for (const item of this.list())
      if (kinds.includes(item.kind) && !keys.has(item.key))
        changed = this.resolve(item.key) || changed;
    for (const input of inputs) changed = this.upsert(input) || changed;
    return changed;
  }

  dismiss(key: string): boolean {
    const current = this.items.get(key);
    if (!current || current.resolvedAt !== undefined || current.dismissedAt !== undefined)
      return false;
    const now = this.now();
    this.write({ ...current, updatedAt: now, dismissedAt: now });
    return true;
  }

  reopen(key: string): boolean {
    const current = this.items.get(key);
    if (!current || current.resolvedAt !== undefined || current.dismissedAt === undefined)
      return false;
    const { dismissedAt: _dismissed, ...rest } = current;
    this.write({ ...rest, updatedAt: this.now() });
    return true;
  }

  private write(item: BotInboxItem): void {
    this.items.set(item.key, item);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // 前导换行隔离撕裂的末行
      appendFileSync(this.file, `\n${JSON.stringify(item)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.lines++;
      if (this.redundant()) this.compact();
    } catch (error) {
      console.warn('[bots] inbox write failed', error);
    }
  }

  private redundant(): boolean {
    return this.lines - this.items.size >= Math.max(this.minRedundant, this.items.size);
  }

  private compact(): void {
    try {
      const snapshot = [...this.items.values()].map((item) => JSON.stringify(item));
      writeAtomic(this.file, snapshot.length > 0 ? `${snapshot.join('\n')}\n` : '');
      this.lines = snapshot.length;
    } catch (error) {
      console.warn('[bots] inbox compaction failed', error);
    }
  }
}

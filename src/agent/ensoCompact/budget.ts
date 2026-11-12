import type { CompactBranchEntry } from './types';

export const RESERVE_TOKENS = 16_384;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const MIN_IMAGE_TOKENS = 1_600;
export const MIN_SAVING_RATIO = 0.1;

export function imageTokens(part: { data?: string; bytes?: number }): number {
  const chars =
    typeof part.data === 'string'
      ? part.data.length
      : typeof part.bytes === 'number' && part.bytes > 0
        ? Math.ceil(part.bytes / 3) * 4
        : 0;
  return Math.max(Math.ceil(chars / 4), MIN_IMAGE_TOKENS);
}

export function estimateMessageTokens(message: unknown): number {
  const rec = (message ?? {}) as { content?: unknown };
  return Math.ceil(contentChars(rec.content) / 4);
}

export function sendBudget(contextWindow?: number): number {
  const window =
    typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  return Math.max(0, window - RESERVE_TOKENS);
}

export type EvictedItem = { label: string; tokens: number };
export type CutOk = {
  firstKeptEntryId: string;
  evicted: EvictedItem[];
  estimatedAfter: number;
};
export type CutFail = {
  fail: 'uncompressible' | 'no_saving';
  budget: number;
  estimatedAfter: number;
};

export function selectKeptBoundary(input: {
  branch: CompactBranchEntry[];
  preparation: { firstKeptEntryId: string; previousSummary?: string; tokensBefore: number };
  contextWindow?: number;
  /** 压前 tokens；给出时压后估算须至少省一成，否则判无节省 */
  savingBaseline?: number;
  summaryTokenHint?: number;
}): CutOk | CutFail {
  const { branch, preparation } = input;
  const budget = sendBudget(input.contextWindow);
  const hint =
    input.summaryTokenHint ?? Math.ceil((preparation.previousSummary ?? '').length / 4) + 2048;
  const origin = Math.max(
    0,
    branch.findIndex((entry) => entry.id === preparation.firstKeptEntryId)
  );
  const cuts = legalCuts(branch).filter((index) => index >= origin);
  // 尾巴里 assistant 的 usage 是压前整段上下文的账单，与切点无关，只按尾巴自身估算
  const estimateFrom = (cut: number) =>
    hint + branch.slice(cut).reduce((sum, entry) => sum + estimateMessageTokens(entry.message), 0);
  let estimatedAfter = estimateFrom(origin);
  for (const cut of cuts) {
    estimatedAfter = estimateFrom(cut);
    if (estimatedAfter > budget) continue;
    if (noSaving(input.savingBaseline, estimatedAfter)) {
      return { fail: 'no_saving', budget, estimatedAfter };
    }
    return {
      firstKeptEntryId: branch[cut].id ?? preparation.firstKeptEntryId,
      evicted: evictedItems(branch.slice(origin, cut)),
      estimatedAfter,
    };
  }
  return { fail: 'uncompressible', budget, estimatedAfter };
}

function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const rec = block as {
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      arguments?: unknown;
      data?: string;
    };
    if (rec.type === 'image') {
      chars += imageTokens(rec) * 4;
      continue;
    }
    if (typeof rec.text === 'string') chars += rec.text.length;
    if (typeof rec.thinking === 'string') chars += rec.thinking.length;
    if (rec.type === 'toolCall') {
      chars += (rec.name ?? '').length + JSON.stringify(rec.arguments ?? {}).length;
    }
  }
  return chars;
}

function legalCuts(branch: CompactBranchEntry[]): number[] {
  return branch.flatMap((entry, index) => {
    const role = entry.message?.role;
    return entry.id && (role === 'user' || role === 'assistant') ? [index] : [];
  });
}

function noSaving(baseline: number | undefined, after: number): boolean {
  if (baseline === undefined) return false;
  if (baseline <= 0) return after >= baseline;
  return (baseline - after) / baseline < MIN_SAVING_RATIO;
}

function evictedItems(entries: CompactBranchEntry[]): EvictedItem[] {
  return entries.flatMap((entry) => {
    const tokens = estimateMessageTokens(entry.message);
    const label = evictedLabel(entry);
    return label && tokens > 0 ? [{ label, tokens }] : [];
  });
}

function evictedLabel(entry: CompactBranchEntry): string | undefined {
  const msg = entry.message;
  if (!msg) return undefined;
  if (msg.role === 'toolResult') {
    const image = Array.isArray(msg.content)
      ? msg.content.some((block) => (block as { type?: string })?.type === 'image')
      : false;
    return image ? 'read image' : 'tool result';
  }
  if (msg.role === 'assistant') return 'assistant';
  if (msg.role === 'user') return 'user';
  return undefined;
}

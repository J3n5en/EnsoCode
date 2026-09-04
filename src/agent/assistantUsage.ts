import { emptyUsage } from '@shared/providers/piProviderTypes';

type UsageLike = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
  cost?: unknown;
};

type AssistantLike = {
  role?: unknown;
  usage?: UsageLike;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function completeUsage(usage: UsageLike | undefined): UsageLike {
  const empty = emptyUsage();
  const input = num(usage?.input);
  const output = num(usage?.output);
  const cacheRead = num(usage?.cacheRead);
  const cacheWrite = num(usage?.cacheWrite);
  const totalTokens =
    typeof usage?.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : input + output + cacheRead + cacheWrite;
  return {
    ...empty,
    ...usage,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: isRecord(usage?.cost) ? { ...empty.cost, ...usage.cost } : empty.cost,
  };
}

function needsUsagePatch(usage: UsageLike | undefined): boolean {
  if (!isRecord(usage)) return true;
  return (
    typeof usage.totalTokens !== 'number' ||
    !Number.isFinite(usage.totalTokens) ||
    !isRecord(usage.cost)
  );
}

/** pi 估上下文会读 assistant.usage.totalTokens；Cursor 轮次可能缺整块 usage。 */
export function ensureAssistantUsage(messages: unknown[]): number {
  let patched = 0;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'assistant') continue;
    const assistant = message as AssistantLike;
    if (!needsUsagePatch(assistant.usage)) continue;
    assistant.usage = completeUsage(assistant.usage);
    patched += 1;
  }
  return patched;
}

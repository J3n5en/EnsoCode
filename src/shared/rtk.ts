export interface RtkToolStats {
  status: 'compressed' | 'unchanged' | 'pending' | 'bypassed' | 'unavailable';
  originalCommand: string;
  rewrittenCommand?: string;
  inputTokens?: number;
  outputTokens?: number;
  reason?: string;
}

const cap = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

export function parseRtkToolStats(value: unknown): RtkToolStats | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { status, originalCommand, rewrittenCommand, inputTokens, outputTokens, reason } = record;
  if (
    (status !== 'compressed' &&
      status !== 'unchanged' &&
      status !== 'pending' &&
      status !== 'bypassed' &&
      status !== 'unavailable') ||
    typeof originalCommand !== 'string' ||
    (rewrittenCommand !== undefined && typeof rewrittenCommand !== 'string') ||
    (reason !== undefined && typeof reason !== 'string')
  )
    return undefined;
  const result: RtkToolStats = { status, originalCommand: cap(originalCommand, 16_000) };
  if (rewrittenCommand !== undefined) result.rewrittenCommand = cap(rewrittenCommand, 16_000);
  if (reason !== undefined) result.reason = cap(reason, 1_000);
  if (inputTokens !== undefined || outputTokens !== undefined) {
    if (
      typeof inputTokens !== 'number' ||
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      typeof outputTokens !== 'number' ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    )
      return undefined;
    result.inputTokens = inputTokens;
    result.outputTokens = outputTokens;
  }
  return result;
}

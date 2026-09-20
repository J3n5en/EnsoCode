export interface RtkSavings {
  tokens: number;
  percent: number | null;
}

export function rtkSavings(stats: {
  inputTokens?: number;
  outputTokens?: number;
}): RtkSavings | null {
  const { inputTokens, outputTokens } = stats;
  if (
    typeof inputTokens !== 'number' ||
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0
  ) {
    return null;
  }
  const tokens = Math.max(0, inputTokens - outputTokens);
  return {
    tokens,
    percent: inputTokens > 0 ? Math.round((tokens / inputTokens) * 100) : null,
  };
}

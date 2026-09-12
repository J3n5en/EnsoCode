export const COMPACT_STRATEGIES = ['standard', 'smart', 'continuous-memory'] as const;

export type CompactStrategy = (typeof COMPACT_STRATEGIES)[number];

export function parseCompactStrategy(value: unknown): CompactStrategy | null {
  return typeof value === 'string' && (COMPACT_STRATEGIES as readonly string[]).includes(value)
    ? (value as CompactStrategy)
    : null;
}

export function resolveCompactStrategy(value: unknown, legacySmart: unknown): CompactStrategy {
  const parsed = parseCompactStrategy(value);
  if (parsed) return parsed;
  return legacySmart === true ? 'smart' : 'standard';
}

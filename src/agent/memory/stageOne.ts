export type StageOneCandidate = {
  threadId: string;
  sessionFile: string;
  cwd: string;
  updatedAtSec: number;
  sourceKind: 'parent' | 'coworker' | 'child';
};

export type StageOneSelectOptions = {
  nowSec: number;
  currentThreadId?: string;
  minRolloutIdleHours?: number;
  maxRolloutAgeDays?: number;
  maxRolloutsPerStartup?: number;
  threadScanLimit?: number;
};

export type StageOneOutput = {
  rollout_summary: string;
  rollout_slug: string | null;
  raw_memory: string;
};

const HOUR = 3600;
const DAY = 24 * HOUR;

export function selectStageOneCandidates(
  threads: StageOneCandidate[],
  opts: StageOneSelectOptions
): StageOneCandidate[] {
  const minIdleSec = (opts.minRolloutIdleHours ?? 12) * HOUR;
  const maxAgeSec = (opts.maxRolloutAgeDays ?? 30) * DAY;
  const scanLimit = opts.threadScanLimit ?? 300;
  const maxRollouts = opts.maxRolloutsPerStartup ?? 64;
  const scanned = [...threads].sort((a, b) => b.updatedAtSec - a.updatedAtSec).slice(0, scanLimit);
  const out: StageOneCandidate[] = [];
  for (const thread of scanned) {
    if (out.length >= maxRollouts) break;
    if (opts.currentThreadId && thread.threadId === opts.currentThreadId) continue;
    if (thread.sourceKind !== 'parent') continue;
    const age = opts.nowSec - thread.updatedAtSec;
    if (age < minIdleSec || age > maxAgeSec) continue;
    out.push(thread);
  }
  return out;
}

function unwrapJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const want = [...expected].sort();
  return keys.length === want.length && keys.every((key, i) => key === want[i]);
}

export function parseStageOneResponse(text: string): StageOneOutput | undefined {
  try {
    const parsed: unknown = JSON.parse(unwrapJsonText(text));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (!hasExactKeys(value, ['rollout_summary', 'rollout_slug', 'raw_memory'])) return undefined;
    if (typeof value.rollout_summary !== 'string') return undefined;
    if (!(typeof value.rollout_slug === 'string' || value.rollout_slug === null)) return undefined;
    if (typeof value.raw_memory !== 'string') return undefined;
    return {
      rollout_summary: value.rollout_summary,
      rollout_slug: value.rollout_slug,
      raw_memory: value.raw_memory,
    };
  } catch {
    return undefined;
  }
}

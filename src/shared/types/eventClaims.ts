/** 没有任何心跳连续这么久，认领才算失联。有心跳就顺延，没有总时长上限。 */
export const DEFAULT_CLAIM_IDLE_LEASE_MS = 15 * 60_000;

export const CLAIM_KEY_MAX_CHARS = 256;
export const CLAIM_LABEL_MAX_CHARS = 120;
export const CLAIM_GROUP_MAX_CHARS = 64;

export interface EventClaimView {
  key: string;
  sessionId: string;
  pluginId: string;
  label?: string;
  group?: string;
  subscribedAt?: number;
  claimedAt: number;
  lastHeartbeatAt: number;
  leaseUntil: number;
  active: boolean;
}

export type EventClaimRecord = EventClaimView;

export interface EventClaimCandidate {
  sessionId: string;
  subscribedAt?: number;
  active?: boolean;
}

export type EventClaimAcquireResult =
  | {
      acquired: true;
      status: 'claimed' | 'renewed';
      ownerSessionId: string;
      claim: EventClaimView;
    }
  | {
      acquired: false;
      status: 'held-by-other';
      ownerSessionId: string;
      claim: EventClaimView;
    };

function boundedText(raw: unknown, max: number): string | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0 || text.length > max) return null;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 31 || code === 127) return null;
  }
  return text;
}

export function parseClaimKey(raw: unknown): string | null {
  const key = boundedText(raw, CLAIM_KEY_MAX_CHARS);
  return typeof key === 'string' ? key : null;
}

export function parseClaimLabel(raw: unknown): string | null | undefined {
  return boundedText(raw, CLAIM_LABEL_MAX_CHARS);
}

export function parseClaimGroup(raw: unknown): string | null | undefined {
  return boundedText(raw, CLAIM_GROUP_MAX_CHARS);
}

export function parseClaimSubscribedAt(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

function parseCandidate(raw: unknown): EventClaimCandidate | null {
  if (!isRecord(raw)) return null;
  const row = raw;
  const sessionId = parseClaimKey(row.sessionId);
  if (!sessionId) return null;
  const subscribedAt = parseClaimSubscribedAt(row.subscribedAt);
  if (subscribedAt === null) return null;
  if (row.active !== undefined && typeof row.active !== 'boolean') return null;
  return {
    sessionId,
    ...(subscribedAt !== undefined ? { subscribedAt } : {}),
    ...(row.active !== undefined ? { active: row.active } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseClaimCandidates(raw: unknown): EventClaimCandidate[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const out: EventClaimCandidate[] = [];
  for (const item of raw) {
    const parsed = parseCandidate(item);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

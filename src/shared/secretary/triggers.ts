import type {
  SecretaryTrigger,
  SecretaryTriggerCreateDraft,
  SecretaryTriggerUpdatePatch,
} from '../types/secretary';

export const DEFAULT_TRIGGER_PORT = 17654;
export const MIN_TRIGGER_PORT = 1024;
export const MAX_TRIGGER_PORT = 65535;
export const DEFAULT_TRIGGER_COALESCE_MS = 3_000;
export const MAX_TRIGGER_COALESCE_MS = 60_000;
export const MAX_TRIGGERS_PER_SECRETARY = 20;
export const TRIGGER_NAME_MAX_CHARS = 60;
export const TRIGGER_INSTRUCTION_MAX_CHARS = 4_000;
export const TRIGGER_SOURCE_MAX_CHARS = 120;
export const TRIGGER_EVENT_ID_MAX_CHARS = 128;
export const TRIGGER_PAYLOAD_MAX_CHARS = 16_000;
export const TRIGGER_HTTP_MAX_BYTES = 64 * 1024;

const TRIGGER_ID_RE = /^trg-[a-z0-9]{6,32}$/;

export interface TriggerInboundEvent {
  eventId?: string;
  source?: string;
  payload: string;
  at?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function clipPayload(text: string): string {
  if (text.length <= TRIGGER_PAYLOAD_MAX_CHARS) return text;
  return `${text.slice(0, TRIGGER_PAYLOAD_MAX_CHARS)}…`;
}

export function isTriggerId(value: unknown): value is string {
  return typeof value === 'string' && TRIGGER_ID_RE.test(value);
}

export function parseTriggerPort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value === 0) return 0;
  if (value >= MIN_TRIGGER_PORT && value <= MAX_TRIGGER_PORT) return value;
  return null;
}

export function buildTriggerUrls(
  port: number,
  triggerId: string
): {
  httpUrl: string;
  wsUrl: string;
} {
  return {
    httpUrl: `http://127.0.0.1:${port}/v1/triggers/${triggerId}`,
    wsUrl: `ws://127.0.0.1:${port}/v1/triggers/${triggerId}/ws`,
  };
}

function parseCoalesceMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_TRIGGER_COALESCE_MS) return null;
  return value;
}

export function parseTriggerCreateDraft(
  raw: unknown
): { ok: true; draft: SecretaryTriggerCreateDraft } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: 'invalid trigger draft' };
  const name = trimmedText(raw.name, TRIGGER_NAME_MAX_CHARS);
  if (!name) return { ok: false, error: 'invalid name' };
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== 'boolean') return { ok: false, error: 'invalid enabled' };
  const coalesceMs =
    raw.coalesceMs === undefined ? DEFAULT_TRIGGER_COALESCE_MS : parseCoalesceMs(raw.coalesceMs);
  if (coalesceMs === null) return { ok: false, error: 'invalid coalesceMs' };
  let instruction: string | undefined;
  if (raw.instruction !== undefined && raw.instruction !== null) {
    if (typeof raw.instruction !== 'string') return { ok: false, error: 'invalid instruction' };
    const clean = raw.instruction.trim();
    if (clean.length > TRIGGER_INSTRUCTION_MAX_CHARS)
      return { ok: false, error: 'instruction too long' };
    if (clean) instruction = clean;
  }
  let secretaryConversationId: string | undefined;
  if (raw.secretaryConversationId !== undefined && raw.secretaryConversationId !== null) {
    const conv = trimmedText(raw.secretaryConversationId, 128);
    if (!conv) return { ok: false, error: 'invalid secretaryConversationId' };
    secretaryConversationId = conv;
  }
  return {
    ok: true,
    draft: {
      name,
      enabled,
      coalesceMs,
      ...(instruction ? { instruction } : {}),
      ...(secretaryConversationId ? { secretaryConversationId } : {}),
    },
  };
}

export function parseTriggerUpdateDraft(
  raw: unknown
): { ok: true; patch: SecretaryTriggerUpdatePatch } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: 'invalid trigger patch' };
  const patch: SecretaryTriggerUpdatePatch = {};
  if (raw.name !== undefined) {
    const name = trimmedText(raw.name, TRIGGER_NAME_MAX_CHARS);
    if (!name) return { ok: false, error: 'invalid name' };
    patch.name = name;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return { ok: false, error: 'invalid enabled' };
    patch.enabled = raw.enabled;
  }
  if (raw.coalesceMs !== undefined) {
    const coalesceMs = parseCoalesceMs(raw.coalesceMs);
    if (coalesceMs === null) return { ok: false, error: 'invalid coalesceMs' };
    patch.coalesceMs = coalesceMs;
  }
  if (raw.instruction !== undefined) {
    if (raw.instruction === null) {
      patch.instruction = null;
    } else if (typeof raw.instruction === 'string') {
      const clean = raw.instruction.trim();
      if (clean.length > TRIGGER_INSTRUCTION_MAX_CHARS)
        return { ok: false, error: 'instruction too long' };
      patch.instruction = clean ? clean : null;
    } else {
      return { ok: false, error: 'invalid instruction' };
    }
  }
  if (raw.secretaryConversationId !== undefined) {
    if (raw.secretaryConversationId === null) {
      patch.secretaryConversationId = null;
    } else {
      const conv = trimmedText(raw.secretaryConversationId, 128);
      if (!conv) return { ok: false, error: 'invalid secretaryConversationId' };
      patch.secretaryConversationId = conv;
    }
  }
  return { ok: true, patch };
}

function parseTriggerItem(raw: unknown): SecretaryTrigger | null {
  if (!isObject(raw)) return null;
  if (!isTriggerId(raw.id)) return null;
  const name = trimmedText(raw.name, TRIGGER_NAME_MAX_CHARS);
  if (!name) return null;
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : null;
  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null;
  if (createdAt === null || updatedAt === null) return null;
  const coalesceMs = parseCoalesceMs(raw.coalesceMs) ?? DEFAULT_TRIGGER_COALESCE_MS;
  const instruction = trimmedText(raw.instruction, TRIGGER_INSTRUCTION_MAX_CHARS);
  const secretaryConversationId = trimmedText(raw.secretaryConversationId, 128);
  const lastFiredAt =
    typeof raw.lastFiredAt === 'number' && Number.isFinite(raw.lastFiredAt)
      ? raw.lastFiredAt
      : undefined;
  const fireCount =
    typeof raw.fireCount === 'number' && Number.isInteger(raw.fireCount) && raw.fireCount >= 0
      ? raw.fireCount
      : 0;
  return {
    id: raw.id,
    name,
    enabled: raw.enabled !== false,
    coalesceMs,
    createdAt,
    updatedAt,
    fireCount,
    ...(instruction ? { instruction } : {}),
    ...(secretaryConversationId ? { secretaryConversationId } : {}),
    ...(lastFiredAt !== undefined ? { lastFiredAt } : {}),
  };
}

export function parseTriggersFile(raw: unknown): SecretaryTrigger[] {
  if (!isObject(raw) || !Array.isArray(raw.triggers)) return [];
  const seen = new Set<string>();
  const out: SecretaryTrigger[] = [];
  for (const item of raw.triggers) {
    const parsed = parseTriggerItem(item);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
    if (out.length >= MAX_TRIGGERS_PER_SECRETARY) break;
  }
  return out;
}

export function parseTriggerEventObject(
  raw: Record<string, unknown>
): { ok: true; event: TriggerInboundEvent } | { ok: false; error: string } {
  const eventId = trimmedText(raw.eventId, TRIGGER_EVENT_ID_MAX_CHARS);
  const source = trimmedText(raw.source, TRIGGER_SOURCE_MAX_CHARS);
  const at =
    typeof raw.at === 'number' && Number.isFinite(raw.at) && raw.at > 0 ? raw.at : undefined;
  const textPart = typeof raw.text === 'string' ? raw.text.trim() : '';
  let dataPart = '';
  if (raw.data !== undefined) {
    try {
      dataPart = typeof raw.data === 'string' ? raw.data.trim() : JSON.stringify(raw.data);
    } catch {
      return { ok: false, error: 'invalid data' };
    }
  }
  let payload = [textPart, dataPart].filter(Boolean).join('\n');
  if (!payload) {
    // 兼容旧 webhook 直接发任意 JSON：没有 text/data 时整包序列化作为外部事件载荷
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (
        k === 'type' ||
        k === 'id' ||
        k === 'token' ||
        k === 'eventId' ||
        k === 'source' ||
        k === 'at'
      )
        continue;
      rest[k] = v;
    }
    const keys = Object.keys(rest);
    if (keys.length === 0) return { ok: false, error: 'empty event payload' };
    try {
      payload = JSON.stringify(rest);
    } catch {
      return { ok: false, error: 'invalid payload' };
    }
  }
  return {
    ok: true,
    event: {
      payload: clipPayload(payload),
      ...(eventId ? { eventId } : {}),
      ...(source ? { source } : {}),
      ...(at !== undefined ? { at } : {}),
    },
  };
}

export function parseTriggerInboundPayload(
  body: string,
  contentType?: string
): { ok: true; event: TriggerInboundEvent } | { ok: false; error: string } {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: 'empty body' };
  const isJson =
    (contentType?.toLowerCase().includes('application/json') ?? false) ||
    (contentType === undefined && (trimmed.startsWith('{') || trimmed.startsWith('[')));
  if (isJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: 'invalid json' };
    }
    if (isObject(parsed)) return parseTriggerEventObject(parsed);
    return { ok: true, event: { payload: clipPayload(JSON.stringify(parsed)) } };
  }
  return { ok: true, event: { payload: clipPayload(trimmed) } };
}

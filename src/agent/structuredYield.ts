export interface JsonSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

export interface SchemaCheck {
  ok: boolean;
  error?: string;
}

export function parseJsonFromAssistant(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), trimmed].filter((value): value is string =>
    Boolean(value)
  );
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) return parsed;
    const sliced = sliceFirstJson(candidate);
    if (sliced !== undefined) return sliced;
  }
  return undefined;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sliceFirstJson(text: string): unknown | undefined {
  const start = text.search(/[{[]/);
  if (start < 0) return undefined;
  for (let end = text.length; end > start; end--) {
    const parsed = tryParseJson(text.slice(start, end));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema): SchemaCheck {
  const expected = schema.type;
  if (expected) {
    const types = Array.isArray(expected) ? expected : [expected];
    if (!types.some((type) => matchesType(value, type))) {
      return { ok: false, error: `expected type ${types.join('|')}` };
    }
  }
  if (schema.type === 'object' || schema.properties || schema.required) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'expected object' };
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) return { ok: false, error: `missing required "${key}"` };
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        const nested = validateAgainstSchema(record[key], child);
        if (!nested.ok) return { ok: false, error: `${key}: ${nested.error}` };
      }
    }
  }
  if (schema.type === 'array' && schema.items) {
    if (!Array.isArray(value)) return { ok: false, error: 'expected array' };
    for (let i = 0; i < value.length; i++) {
      const nested = validateAgainstSchema(value[i], schema.items);
      if (!nested.ok) return { ok: false, error: `[${i}]: ${nested.error}` };
    }
  }
  return { ok: true };
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (type === 'number' || Number.isInteger(value))
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

export function pointerGet(data: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return data;
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`);
  const parts = pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current: unknown = data;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`JSON pointer not found: ${pointer}`);
      }
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object' || !(part in current)) {
      throw new Error(`JSON pointer not found: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function parseAgentUri(path: string): { id: string; pointer?: string } | undefined {
  const match = path.trim().match(/^agent:\/\/([^/?#]+)(?:\?q=([^#]*))?$/);
  if (!match) return undefined;
  const id = decodeURIComponent(match[1] ?? '');
  if (!id) return undefined;
  const raw = match[2];
  return { id, pointer: raw ? decodeURIComponent(raw) : undefined };
}

export function extractJsonValue(
  store: ReadonlyMap<string, unknown>,
  uri: string
): unknown | undefined {
  const parsed = parseAgentUri(uri);
  if (!parsed) return undefined;
  const value = store.get(parsed.id);
  if (value === undefined) return undefined;
  return parsed.pointer ? pointerGet(value, parsed.pointer) : value;
}

export const YIELD_NUDGE = (error: string): string =>
  `Your last reply was not valid JSON for the required schema (${error}). Reply with JSON only — no markdown, no prose.`;

export const YIELD_JSON_MARKER = '<!-- yield:json -->';

export function appendYieldJson(text: string, value: unknown): string {
  return `${text}\n\n${YIELD_JSON_MARKER}\n${JSON.stringify(value)}`;
}

export function withAgentRead<T extends { execute: (...args: never[]) => unknown }>(
  definition: T,
  getStore: () => ReadonlyMap<string, unknown>
): T {
  const execute = definition.execute as (
    toolCallId: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown
  ) => unknown;
  return {
    ...definition,
    execute: ((
      toolCallId: string,
      params: unknown,
      signal?: unknown,
      onUpdate?: unknown,
      ctx?: unknown
    ) => {
      const filePath = String((params as { path?: string }).path ?? '');
      if (parseAgentUri(filePath)) {
        const value = extractJsonValue(getStore(), filePath);
        if (value === undefined) throw new Error(`unknown agent yield: ${filePath}`);
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return Promise.resolve({ content: [{ type: 'text' as const, text }], details: undefined });
      }
      return execute(toolCallId, params, signal, onUpdate, ctx);
    }) as T['execute'],
  };
}

export async function collectStructuredYield(options: {
  text: string;
  schema: JsonSchema;
  prompt: (nudge: string) => Promise<void>;
  reread: () => string;
  maxNudges?: number;
}): Promise<{ value: unknown; text: string }> {
  const maxNudges = options.maxNudges ?? 2;
  let text = options.text;
  for (let attempt = 0; attempt <= maxNudges; attempt++) {
    const parsed = parseJsonFromAssistant(text);
    if (parsed !== undefined) {
      const check = validateAgainstSchema(parsed, options.schema);
      if (check.ok) return { value: parsed, text };
      if (attempt === maxNudges) {
        throw new Error(`structured yield failed after ${maxNudges} nudges: ${check.error}`);
      }
      await options.prompt(YIELD_NUDGE(check.error ?? 'invalid'));
    } else {
      if (attempt === maxNudges) {
        throw new Error(`structured yield failed after ${maxNudges} nudges: not JSON`);
      }
      await options.prompt(YIELD_NUDGE('not JSON'));
    }
    text = options.reread();
  }
  throw new Error('structured yield failed');
}

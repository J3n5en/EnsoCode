/** RFC 7230 token，供请求头名称校验与 UI 标红共用。 */
export const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** 表单行收成持久化映射。空表不落键。 */
export function normalizeProviderHeaders(
  rows: readonly { name: string; value: string }[]
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const canonical = new Map<string, string>();
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name || !value) continue;
    const key = name.toLowerCase();
    const previous = canonical.get(key);
    if (previous !== undefined && previous !== name) delete headers[previous];
    canonical.set(key, name);
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * 与 fetch/undici 的请求头值约束一致：只允许 \t、0x20-0x7E、0x80-0xFF。超出的（中文、零宽空格、
 * NUL、CR/LF 等）一条就会让该供应商每个请求都抛 ByteString/invalid header，必须在边界丢掉。
 */
const INVALID_HEADER_VALUE_RE = /[^\t\x20-\x7e\x80-\xff]/;

/** 与 fetch/undici 能发出的请求头值一致。空串在这里算合法，由规范化丢掉。 */
export function isSendableHeaderValue(value: string): boolean {
  return !INVALID_HEADER_VALUE_RE.test(value);
}

const droppedHeaderWarnings = new Set<string>();

function warnDroppedHeader(name: string): void {
  if (droppedHeaderWarnings.has(name)) return;
  droppedHeaderWarnings.add(name);
  console.warn(`[provider-headers] dropped ${name}: value cannot be sent as a header`);
}

/** IPC、设置和 worker 推送的边界收窄。非法条目丢弃，结果空则没有请求头。 */
export function parseProviderHeaders(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!HEADER_NAME_RE.test(name)) continue;
    if (typeof headerValue !== 'string') continue;
    if (!isSendableHeaderValue(headerValue)) {
      warnDroppedHeader(name);
      continue;
    }
    headers[name] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * pi 把 provider headers 当配置模板：`!` 开头跑 shell，`$VAR` / `${VAR}` 展开环境变量。
 * 用户请求头是字面量，先把 `$` 加倍，再给开头的 `!` 前置 `$`，让解析回到原文。
 */
export function escapePiConfigValue(value: string): string {
  const doubled = value.replaceAll('$', () => '$$');
  return doubled.startsWith('!') ? `$${doubled}` : doubled;
}

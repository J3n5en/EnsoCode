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

/** IPC、设置和 worker 推送的边界收窄。非法条目丢弃，结果空则没有请求头。 */
export function parseProviderHeaders(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!HEADER_NAME_RE.test(name)) continue;
    if (typeof headerValue !== 'string' || /[\r\n]/.test(headerValue)) continue;
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

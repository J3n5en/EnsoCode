import { isValidProxyUrl } from '../proxy';

/** 单个 API Key 服务商的代理策略；缺省（undefined）跟随全局代理。 */
export type ProviderProxyConfig = { mode: 'none' } | { mode: 'custom'; url: string };

export type ProviderProxyMode = 'global' | ProviderProxyConfig['mode'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 严格解析：undefined 表示跟随全局；结构或 URL 非法返回 null（IPC / spawn 入口据此拒绝）。
 */
export function parseProviderProxy(value: unknown): ProviderProxyConfig | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (value.mode === 'none') return keys.length === 1 ? { mode: 'none' } : null;
  if (
    value.mode === 'custom' &&
    keys.length === 2 &&
    typeof value.url === 'string' &&
    isValidProxyUrl(value.url)
  ) {
    return { mode: 'custom', url: value.url.trim() };
  }
  return null;
}

/** 宽松归一化：读 settings 用，坏值按跟随全局处理，不阻断其余配置。 */
export function normalizeProviderProxy(value: unknown): ProviderProxyConfig | undefined {
  return parseProviderProxy(value) ?? undefined;
}

export function sameProviderProxy(left: unknown, right: unknown): boolean {
  const a = normalizeProviderProxy(left);
  const b = normalizeProviderProxy(right);
  if (!a || !b) return a === b;
  return a.mode === b.mode && (a.mode === 'none' || a.url === (b as { url: string }).url);
}

// 贪婪匹配到授权段最后一个 @：密码里未编码的 @ 不能漏出半截
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;

/** 把文本里所有 `scheme://user:pass@` 的账密替换为 `***`，其余原样保留。 */
export function redactProxyUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1***@');
}

export function proxyUrlHasCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

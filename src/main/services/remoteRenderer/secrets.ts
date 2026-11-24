import { sameProviderProxy } from '@shared/providers/providerProxy';

/** 远端拿到的设置里密钥一律替换成哨兵；写回时按路径从宿主磁盘回填，明文不离开 Main。 */
export const REMOTE_SECRET_SENTINEL = '••••••••enso-remote-secret';
const REMOTE_URL_USER = 'enso-remote-secret';

const SECRET_KEY = /(apikey|api_key|secret|password|token|authorization|cookie)$/i;
/** 整个对象的值都视为密钥（MCP env、自定义请求头） */
const SECRET_CONTAINER = new Set(['env', 'headers']);

type Json = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 整串是带账密的 URL（如代理地址）时只把账密换成哨兵用户，地址仍可解析、可编辑 */
function maskUrlCredentials(value: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+@/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return undefined;
    url.username = REMOTE_URL_USER;
    url.password = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function redact(value: Json, secret: boolean): Json {
  if (typeof value === 'string') {
    if (secret && value.length > 0) return REMOTE_SECRET_SENTINEL;
    return maskUrlCredentials(value) ?? value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redact(item, secret || SECRET_KEY.test(key) || SECRET_CONTAINER.has(key));
  }
  return out;
}

export function redactSecrets<T>(value: T): T {
  return redact(value, false) as T;
}

function idOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === 'string' ? value.id : undefined;
}

function restore(next: Json, current: Json): Json {
  if (next === REMOTE_SECRET_SENTINEL) return typeof current === 'string' ? current : '';
  if (typeof next === 'string' && typeof current === 'string' && next !== current) {
    return maskUrlCredentials(current) === next ? current : next;
  }
  if (Array.isArray(next)) {
    const previous = Array.isArray(current) ? current : [];
    return next.map((item, index) => {
      const id = idOf(item);
      const match = id === undefined ? previous[index] : previous.find((p) => idOf(p) === id);
      return restore(item, match);
    });
  }
  if (!isRecord(next)) return next;
  const previous = isRecord(current) ? current : {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(next)) out[key] = restore(item, previous[key]);
  return out;
}

export function restoreSecrets<T>(next: T, current: unknown): T {
  return restore(next, current) as T;
}

/**
 * 远端表单探测已有 provider 时 key 是哨兵：只在 api、baseUrl、代理都与宿主一致时回填 key 与代理账密，
 * 远端不能借宿主的 key 走自己指定的代理。
 */
export function resolveProviderProbeSecret(
  config: unknown,
  providers: readonly unknown[]
): unknown {
  if (!isRecord(config) || config.apiKey !== REMOTE_SECRET_SENTINEL) return config;
  const match = providers.find(
    (p): p is Record<string, unknown> =>
      isRecord(p) &&
      p.api === config.api &&
      p.baseUrl === config.baseUrl &&
      sameProviderProxy(restore(config.proxy, p.proxy), p.proxy)
  );
  if (!match) return { ...config, apiKey: '' };
  return {
    ...config,
    apiKey: typeof match.apiKey === 'string' ? match.apiKey : '',
    ...(config.proxy === undefined ? {} : { proxy: match.proxy }),
  };
}

export function containsSentinel(value: unknown): boolean {
  if (value === REMOTE_SECRET_SENTINEL) return true;
  if (Array.isArray(value)) return value.some(containsSentinel);
  return isRecord(value) && Object.values(value).some(containsSentinel);
}

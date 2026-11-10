import { buildAuthHeaders, type CosyCredentials } from './vendor/cosy';
import { parseQoderRegionEndpoints } from './vendor/endpoints';
import { qoderDecodeBody } from './vendor/protocol/encoding';
import { getQoderRegionConfig, type QoderMode } from './vendor/region';

/** 每次请求独立发现节点，不使用上游按地区共享的账号路由缓存。 */
export async function discoverChatEndpoints(
  mode: QoderMode,
  credentials: CosyCredentials,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<string[]> {
  const url = `${getQoderRegionConfig(mode).centerUrl}/algo/api/v3/service/region/endpoints`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', ...buildAuthHeaders(null, url, credentials) },
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    if (!response.ok) return [];
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = JSON.parse(qoderDecodeBody(text));
    }
    const nodes = parseQoderRegionEndpoints(payload);
    if (!nodes) return [];
    const candidates = [...nodes.remoteAgentNodes, ...nodes.inferNodes, ...nodes.securityNodes];
    return [...new Set(candidates)].filter((candidate) => {
      try {
        const endpoint = new URL(candidate);
        const domains = mode === 'cn' ? ['qoder.com.cn'] : ['qoder.sh', 'qoder.com'];
        return (
          endpoint.protocol === 'https:' &&
          !endpoint.username &&
          !endpoint.password &&
          !endpoint.port &&
          domains.some(
            (domain) => endpoint.hostname === domain || endpoint.hostname.endsWith(`.${domain}`)
          )
        );
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

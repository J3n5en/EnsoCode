import { createHash } from 'node:crypto';
import { type ProviderProxyConfig, parseProviderProxy } from './providerProxy';

/** Main 与 worker 共用注册身份，不能用 settings UUID 或仅 modelId 替代。 */
export function providerKeyFor(model: {
  api: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  proxy?: ProviderProxyConfig;
}): string {
  const keyFp = createHash('sha256').update(model.apiKey).digest('hex').slice(0, 8);
  const host = createHash('sha256')
    .update(
      `${model.api}\0${model.baseUrl}${headerMaterial(model.headers)}${proxyMaterial(model.proxy)}`
    )
    .digest('hex')
    .slice(0, 12);
  return `enso-${host}-${keyFp}`;
}

/** 跟随全局不参与身份，旧 provider id 不变；同端点不同代理必须拆开注册；坏值不能借用跟随全局的身份。 */
function proxyMaterial(proxy: unknown): string {
  const parsed = parseProviderProxy(proxy);
  if (parsed === undefined) return '';
  if (parsed === null) return '\0proxy\0invalid';
  return parsed.mode === 'none' ? '\0proxy\0none' : `\0proxy\0custom\0${parsed.url}`;
}

/** 空表不参与身份，避免把「没配请求头」和「配了空对象」拆成两个 provider。 */
function headerMaterial(headers: Record<string, string> | undefined): string {
  if (!headers) return '';
  const entries = Object.entries(headers).sort(([left], [right]) => {
    const byName = left.toLowerCase().localeCompare(right.toLowerCase());
    return byName === 0 ? left.localeCompare(right) : byName;
  });
  if (entries.length === 0) return '';
  return `\0${entries.map(([name, value]) => `${name.toLowerCase()}\0${value}`).join('\0')}`;
}

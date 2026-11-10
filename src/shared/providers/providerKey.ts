import { createHash } from 'node:crypto';

/** Main 与 worker 共用注册身份，不能用 settings UUID 或仅 modelId 替代。 */
export function providerKeyFor(model: {
  api: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}): string {
  const keyFp = createHash('sha256').update(model.apiKey).digest('hex').slice(0, 8);
  const host = createHash('sha256')
    .update(`${model.api}\0${model.baseUrl}${headerMaterial(model.headers)}`)
    .digest('hex')
    .slice(0, 12);
  return `enso-${host}-${keyFp}`;
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

/** base64url 与配对 URI 编解码。不依赖 Buffer，三端通用（用全局 btoa/atob）。 */

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** QR 载荷：relay 地址 + Electron 一次性公钥。不含 contentKey。 */
export interface PairInvite {
  relay: string;
  publicKey: Uint8Array;
}

export function buildPairUri(invite: PairInvite): string {
  const pk = toBase64Url(invite.publicKey);
  return `enso://pair?relay=${encodeURIComponent(invite.relay)}&pk=${pk}`;
}

/**
 * 配对链接（二维码用）。PWA 与中继同源部署，所以中继地址本身就是手机要打开的网址，
 * 扫码即打开 PWA 并自动配对，不必先装应用再用页内扫码。
 * 参数放在 # 片段里：片段不会随请求发给服务器，公钥不会落到中继的访问日志。
 */
export function buildPairLink(invite: PairInvite): string {
  const pk = toBase64Url(invite.publicKey);
  const base = invite.relay.replace(/\/+$/, '');
  return `${base}/#relay=${encodeURIComponent(invite.relay)}&pk=${pk}`;
}

/** 解析配对码：兼容 enso:// 自定义 scheme 与 https 链接（片段或查询串） */
export function parsePairUri(uri: string): PairInvite {
  const text = uri.trim();
  const custom = /^enso:\/\/pair\?(.*)$/.exec(text);
  if (custom) return fromParams(new URLSearchParams(custom[1]));

  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    // 片段优先（buildPairLink 写在这里），查询串兜底
    const params = new URLSearchParams(url.hash.replace(/^#/, '') || url.search);
    // https 链接的来源站点即中继，relay 缺省时可从中推出
    return fromParams(params, url.origin);
  }
  throw new Error('not an enso pair uri');
}

function fromParams(params: URLSearchParams, fallbackRelay?: string): PairInvite {
  const relay = params.get('relay') ?? fallbackRelay;
  const pk = params.get('pk');
  if (!relay || !pk) throw new Error('pair uri missing relay or pk');
  return { relay, publicKey: fromBase64Url(pk) };
}

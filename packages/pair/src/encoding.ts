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

export function parsePairUri(uri: string): PairInvite {
  const match = /^enso:\/\/pair\?(.*)$/.exec(uri.trim());
  if (!match) throw new Error('not an enso pair uri');
  const params = new URLSearchParams(match[1]);
  const relay = params.get('relay');
  const pk = params.get('pk');
  if (!relay || !pk) throw new Error('pair uri missing relay or pk');
  return { relay, publicKey: fromBase64Url(pk) };
}

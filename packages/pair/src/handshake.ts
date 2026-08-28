import {
  type BoxedContentKey,
  boxContentKey,
  generateContentKey,
  generatePairKeypair,
  openBoxedContentKey,
} from './crypto';
import { fromBase64Url, toBase64Url } from './encoding';
import { normalizeRelayUrl } from './relay';

/** 配对握手：host 侧与 phone 侧共用，Electron 与 PWA 都调这里，避免两处实现漂移。 */

/** boxedKey 线格式：ephPublicKey.nonce.boxed（均 base64url） */
export function encodeBoxedKey(b: BoxedContentKey): string {
  return [toBase64Url(b.ephPublicKey), toBase64Url(b.nonce), toBase64Url(b.boxed)].join('.');
}

export function decodeBoxedKey(s: string): BoxedContentKey {
  const parts = s.split('.');
  if (parts.length !== 3) throw new Error('malformed boxedKey');
  return {
    ephPublicKey: fromBase64Url(parts[0]),
    nonce: fromBase64Url(parts[1]),
    boxed: fromBase64Url(parts[2]),
  };
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) ?? `relay ${res.status}`);
  return json;
}

// ── host 侧（Electron）────────────────────────────────────────────────

export interface HostPairSession {
  publicKeyB64: string;
  secretKey: Uint8Array;
  relayUrl: string;
}

/** 生成一次性 box 密钥对并向中继登记，返回可编成 QR 的会话 */
export async function startHostPairing(relayUrl: string): Promise<HostPairSession> {
  const relay = normalizeRelayUrl(relayUrl);
  const kp = generatePairKeypair();
  const publicKeyB64 = toBase64Url(kp.publicKey);
  await postJson(`${relay}/v1/pair/request`, { publicKey: publicKeyB64 });
  return { publicKeyB64, secretKey: kp.secretKey, relayUrl: relay };
}

export interface HostPairResult {
  pairId: string;
  hostToken: string;
  contentKey: Uint8Array;
  deviceName: string;
}

/** 轮询一次：未认领返回 null，已认领则解开 box 拿到 contentKey */
export async function pollHostPairing(session: HostPairSession): Promise<HostPairResult | null> {
  const json = await postJson(`${session.relayUrl}/v1/pair/request`, {
    publicKey: session.publicKeyB64,
  });
  if (json.state !== 'authorized') return null;
  const contentKey = openBoxedContentKey(
    decodeBoxedKey(json.response as string),
    session.secretKey
  );
  return {
    pairId: json.pairId as string,
    hostToken: json.hostToken as string,
    contentKey,
    deviceName: (json.deviceName as string) || 'phone',
  };
}

// ── phone 侧（PWA）────────────────────────────────────────────────────

export interface PhonePairResult {
  pairId: string;
  deviceToken: string;
  contentKey: Uint8Array;
}

/** 扫码后：生成 contentKey、box 给 host 公钥、claim 认领 */
export async function claimPairing(
  relayUrl: string,
  hostPublicKey: Uint8Array,
  deviceName: string
): Promise<PhonePairResult> {
  const relay = normalizeRelayUrl(relayUrl);
  const contentKey = generateContentKey();
  const boxed = boxContentKey(contentKey, hostPublicKey);
  const json = await postJson(`${relay}/v1/pair/claim`, {
    publicKey: toBase64Url(hostPublicKey),
    boxedKey: encodeBoxedKey(boxed),
    deviceName,
  });
  return {
    pairId: json.pairId as string,
    deviceToken: json.deviceToken as string,
    contentKey,
  };
}

/** 解绑：清中继房间（含 DO storage token），两端重连即被拒 */
export async function revokePairing(relayUrl: string, pairId: string): Promise<void> {
  await fetch(`${normalizeRelayUrl(relayUrl)}/v1/pair/${encodeURIComponent(pairId)}`, {
    method: 'DELETE',
  });
}

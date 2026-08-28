/**
 * 配对状态机 + 房间号/令牌工具。纯 Web 标准 API（crypto.subtle / getRandomValues / btoa），
 * 不依赖 Workers 专有模块，便于在 node 环境单测。
 */

export const PAIR_TTL_MS = 60_000; // 配对码（QR/claim）有效期
/**
 * 配对成功后，host 还能凭 publicKey 取回凭据的窗口。
 * publicKey 在 QR 里公开，若长期可换 hostToken，任何看过 QR 的人（拍照/录屏/
 * 肩窥）事后都能以 host 身份进房。窗口足够 host 轮询到手（含重试），随即关闭。
 */
export const CREDENTIAL_WINDOW_MS = 120_000;
export const MAX_FRAME_BYTES = 1_048_576; // 单业务帧上限 1MB

export type PairPhase = 'requested' | 'authorized';

export interface PairState {
  phase: PairPhase;
  hostPublicKey: string; // base64url，Electron 一次性公钥
  createdAt: number;
  boxedKey?: string; // base64url，手机 box 后的 contentKey（claim 时写入）
  deviceName?: string;
  hostToken?: string; // 配对成功后长期有效，用于重连进房
  deviceToken?: string;
  /** 进入 authorized 的时刻，用于计算凭据取回窗口 */
  authorizedAt?: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return toBase64Url(b);
}

/** pairId = sha256(host 公钥) 前 128 位。两端各自从 QR 里的公钥独立算出同一房间号，QR 无需带 pairId。 */
export async function pairIdFromPublicKey(publicKeyB64Url: string): Promise<string> {
  const data = new TextEncoder().encode(publicKeyB64Url);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(digest.subarray(0, 16));
}

export function isExpired(state: PairState, now: number): boolean {
  // 只有未认领的配对码会过期；authorized 后长期有效（用于重连）
  return state.phase === 'requested' && now - state.createdAt > PAIR_TTL_MS;
}

/** host 发起/轮询 request：无 state 或已过期则新建 requested，否则原样返回 */
export function request(
  prev: PairState | undefined,
  now: number,
  hostPublicKey: string
): PairState {
  if (!prev || isExpired(prev, now)) {
    return { phase: 'requested', hostPublicKey, createdAt: now };
  }
  return prev;
}

export type ClaimResult = { ok: true; next: PairState } | { ok: false; error: string };

/** 手机 claim：必须存在未过期的 requested，一次性（authorized 后再 claim 拒绝，防抢扫） */
export function claim(
  prev: PairState | undefined,
  now: number,
  boxedKey: string,
  deviceName: string
): ClaimResult {
  if (!prev) return { ok: false, error: 'no pending pair' };
  if (isExpired(prev, now)) return { ok: false, error: 'pair code expired' };
  if (prev.phase === 'authorized') return { ok: false, error: 'already claimed' };
  return {
    ok: true,
    next: {
      ...prev,
      phase: 'authorized',
      authorizedAt: now,
      boxedKey,
      deviceName,
      hostToken: randomToken(),
      deviceToken: randomToken(),
    },
  };
}

/**
 * host 是否还能凭 publicKey 取回 hostToken / boxedKey。
 * 窗口关闭后，publicKey 泄漏也换不到进房凭据（host 早已持 token 重连）。
 */
export function canFetchCredentials(state: PairState, now: number): boolean {
  if (state.phase !== 'authorized') return false;
  return now - (state.authorizedAt ?? state.createdAt) <= CREDENTIAL_WINDOW_MS;
}

export function tokenValid(
  state: PairState | undefined,
  role: 'host' | 'guest',
  token: string
): boolean {
  if (state?.phase !== 'authorized' || !token) return false;
  return role === 'host' ? token === state.hostToken : token === state.deviceToken;
}

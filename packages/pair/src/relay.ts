/** 中继默认地址与连接工具。域名可在设置里改，此处仅作缺省值。 */

export const DEFAULT_RELAY_URL = 'https://enso-pair-relay.j3.workers.dev';

/** http(s) → ws(s)，并去掉尾部斜杠 */
export function toWebSocketUrl(relayUrl: string): string {
  return relayUrl.trim().replace(/\/+$/, '').replace(/^http/, 'ws');
}

export function normalizeRelayUrl(relayUrl: string): string {
  return relayUrl.trim().replace(/\/+$/, '');
}

/** 指数退避 + 抖动：1s → 2s → 4s… 上限 30s，避免 DO 回收后重连风暴 */
export function backoffDelay(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

/** 配对成功后两端各自持久化的凭据 */
export interface PairedDevice {
  pairId: string;
  /** host 侧存 hostToken，phone 侧存 deviceToken */
  token: string;
  /** base64url 编码的 32 字节 contentKey */
  contentKey: string;
  deviceName: string;
  relayUrl: string;
  pairedAt: number;
}

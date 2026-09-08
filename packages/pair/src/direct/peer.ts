import type { DirectCandidate, IceServerEntry } from '../protocol';

/**
 * WebRTC 对端的最小抽象：浏览器用 RTCPeerConnection 实现，Electron main 用 node-datachannel。
 * 只暴露信令与字节收发，不碰业务明文；vitest 通过 DirectPeerFactory 注入假实现。
 */

export type Unsubscribe = () => void;

export interface DirectPeer {
  /** guest：内部创建 ordered DataChannel，返回 offer SDP */
  createOffer(): Promise<string>;
  /** host：接受 offer，等待 ondatachannel，返回 answer SDP */
  acceptOffer(sdp: string): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  addIceCandidate(candidate: DirectCandidate): Promise<void>;
  /** 只吐过滤后的本地候选（见 isAllowedCandidate），已去 a= 前缀 */
  onIceCandidate(cb: (candidate: DirectCandidate) => void): Unsubscribe;
  onOpen(cb: () => void): Unsubscribe;
  onMessage(cb: (bytes: Uint8Array) => void): Unsubscribe;
  /** 通道关闭或 ICE 失败/断开，二者归一为一次回调 */
  onClose(cb: () => void): Unsubscribe;
  /** false = 未 open 或背压拒绝，调用方应改走中继 */
  send(bytes: Uint8Array): boolean;
  /** 幂等；之后不再触发任何回调 */
  close(): void;
}

export type DirectPeerFactory = (iceServers: IceServerEntry[]) => DirectPeer | null;

/** libdatachannel 吐 `a=candidate:...`，浏览器吐 `candidate:...`；线上统一后者 */
export function normalizeCandidate(candidate: string): string {
  return candidate.startsWith('a=') ? candidate.slice(2) : candidate;
}

/** 放行 host（含 mDNS .local / IPv6）与 srflx（STUN 打洞）；拒绝 relay（不用 TURN）与未知 */
export function isAllowedCandidate(candidate: string): boolean {
  const typ = /\styp\s+(\S+)/.exec(normalizeCandidate(candidate))?.[1];
  return typ === 'host' || typ === 'srflx';
}

/** 心跳沿用中继的 ping/pong 文本约定；DataChannel 上由对端自己应答 */
export const DIRECT_PING = 'ping';
export const DIRECT_PONG = 'pong';

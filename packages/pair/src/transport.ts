/**
 * 统一的中继传输抽象：让 PairClient 可以透明地在浏览器 WebSocket 与原生壳传输
 * （例如 iOS `NWProtocolQUIC` 多流通道）之间切换，无需感知底层 socket 实现。
 */

export type RelayTransportKind = 'ws' | 'quic';
export type RelayTransportLane = 'ctrl' | 'bulk';

/**
 * 与标准 WebSocket 兼容的最小传输接口（可同时承载原生 QUIC 桥接适配器与浏览器 WebSocket）。
 * 原生 QUIC 桥接可将 control/ctrl/bulk 三条流映射为同一个接口，并可选实现 `sendOnLane`
 * 以显式把大包切到独立 `bulk` QUIC Stream。
 */
export interface RelaySocketLike {
  readonly readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  /** 可选车道发送（原生 QUIC 支持将 bulk 大包送往独立 Stream，不阻塞 ctrl） */
  sendOnLane?(data: ArrayBuffer | Uint8Array, lane: RelayTransportLane): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
  /** 底层传输类型，用于诊断展示（缺省为 'ws'） */
  readonly transportKind?: RelayTransportKind;
}

export interface RelayConnectParams {
  /** 原始配对中继 HTTP(S) 基地址，如 https://relay.applekk.com */
  relayUrl: string;
  /** 已经拼好的 WebSocket 连接 URL（包含 role/token/relayEpoch/sinceRelaySeq） */
  wsUrl: string;
  pairId: string;
  role: 'host' | 'guest';
  token: string;
  relayEpoch?: string;
  sinceRelaySeq?: number;
}

export type RelaySocketFactory = (params: RelayConnectParams) => RelaySocketLike;

/** 浏览器默认工厂：直接创建标准 WebSocket */
export const browserWebSocketFactory: RelaySocketFactory = (params) =>
  new WebSocket(params.wsUrl) as unknown as RelaySocketLike;

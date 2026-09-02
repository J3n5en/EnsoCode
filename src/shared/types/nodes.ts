/**
 * 「连接到节点」：本机作为 guest 连别的 EnsoCode 桌面。renderer ↔ main 的 IPC 数据形状。
 * 加密载荷在 main 解开后按 @enso/pair 的 HostToPhone 原样推给 renderer；这里不重定义帧类型。
 */

export interface RemoteNodeStatus {
  nodeId: string;
  /** 本机给对方起的名字（默认 host-info 的 hostname） */
  label: string;
  relayUrl: string;
  pairedAt: number;
  /** guest 与中继的 WSS 是否已连上 */
  connected: boolean;
  /** 对方桌面（host）是否在房间里 */
  hostOnline: boolean;
  /** 对方下发的自述（连上后才有） */
  hostname?: string;
  appVersion?: string;
}

export interface NodesStatus {
  nodes: RemoteNodeStatus[];
  /** safeStorage 是否可用；false 时 UI 须提示密钥无法加密存储 */
  secureStorage: boolean;
}

/** main → renderer：解密后的 host 下行帧（appearance/push-config 已在 main 过滤） */
export interface NodeMessage {
  nodeId: string;
  payload: unknown;
}

export type NodePairError = 'invalid-uri' | 'expired-or-claimed' | 'relay-unreachable';

export type NodePairResult =
  | { ok: true; node: RemoteNodeStatus }
  | { ok: false; error: NodePairError; detail?: string };

export interface NodeActionResult {
  ok: boolean;
  error?: string;
}

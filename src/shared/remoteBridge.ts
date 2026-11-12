/**
 * 远程桌面：浏览器壳页面（packages/phone desk）与 iframe 里桌面 renderer 之间的同源桥。
 * 壳持有加密隧道；renderer 的 web-preload 经 `window.parent.__ensoRemote` 调用。
 */

export type RemoteFrameKind = 'main' | 'settings';

/**
 * 跨 iframe 只传 JSON 字符串（encodeRemoteValue 之后的值）：对象若直接跨 realm 传递，
 * renderer 里 instanceof Array/Uint8Array/Map 会失效，必须在 iframe 自己的 realm 里解码。
 */
export interface RemoteBridgeFrame {
  invoke(channel: string, payload: string): Promise<string>;
  send(channel: string, payload: string): void;
  on(channel: string, listener: (payload: string) => void): () => void;
  /** renderer 帧卸载 */
  close(): void;
}

export interface RemoteBridge {
  /** 宿主平台（快捷键、路径展示随宿主） */
  platform: string;
  attach(kind: RemoteFrameKind): RemoteBridgeFrame;
  leader(): boolean;
  openSettings(link?: unknown): void;
  closeSettings(): void;
  /** 设置页打开时带来的 deep link，读后即清 */
  consumeSettingsLink(): unknown;
  /** 离开桌面模式回手机版 */
  exitDesk(): void;
  /**
   * 手机壳专属：手机到桌面的链路与浏览器推送。节点设置窗口同样实现本接口，
   * 但那侧没有这条链路，因此这组方法与 RemoteApi 一致按可选处理。
   */
  linkStatus?(): RemoteLinkStatus;
  onLinkStatus?(callback: (status: RemoteLinkStatus) => void): () => void;
  vapidPublicKey?(): string | null;
  setPushSubscription?(subscription: RemotePushSubscription | null): void;
  setPushPending?(pending: RemotePushPending): void;
}

/** web-preload 额外挂到 window.electronAPI.remote；桌面 preload 不提供 */
export interface RemoteApi {
  isLeader(): boolean;
  onLeaderChanged(callback: (leader: boolean) => void): () => void;
  /** 浏览器文件落到宿主临时目录，返回宿主绝对路径 */
  upload(file: File): Promise<string | null>;
  /** 本地图片 URL 前缀：`local-image://…` 在浏览器里改走壳的 SW 代理 */
  localImagePrefix: string;
  exitDesk(): void;
  /** 旧壳没有这组方法：renderer 据此保留原来的节点切换器 */
  linkStatus?(): RemoteLinkStatus;
  onLinkStatus?(callback: (status: RemoteLinkStatus) => void): () => void;
  vapidPublicKey?(): string | null;
  /** 本页已经订好的订阅；null = 退订。权限申请发生在调用方的点击里 */
  setPushSubscription?(subscription: RemotePushSubscription | null): void;
  setPushPending?(pending: RemotePushPending): void;
}

export type RemoteLinkState =
  | 'connecting'
  | 'online'
  | 'host-offline'
  | 'unauthorized'
  /** 同一配对已被另一个页面连上，本端停链不重连 */
  | 'replaced'
  | 'offline';

export type RemotePushError =
  | 'unsupported'
  | 'permission-denied'
  | 'service-unreachable'
  | 'subscribe-failed';

export interface RemotePushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface RemotePushPending {
  busy: boolean;
  enabled: boolean;
  error: RemotePushError | null;
}

/** 手机到这台桌面的链路，供完整版侧栏替换「连接到节点」 */
export interface RemoteLinkStatus {
  deviceLabel: string;
  state: RemoteLinkState;
  transport: 'relay' | 'direct';
  rttMs: number | null;
  pushReady: boolean;
  pushEnabled: boolean;
  pushBusy: boolean;
  pushAvailability: 'ok' | 'needs-install' | 'unsupported';
  pushError: RemotePushError | null;
}

/**
 * 远程桌面：壳页面（packages/phone desk、桌面的远程节点界面）与其中桌面 renderer 之间的同源桥。
 * 壳持有加密隧道；renderer 的 web-preload 经 `window.parent.__ensoRemote` 调用（顶层文档时 parent 即自身）。
 */

export type RemoteFrameKind = 'main' | 'settings';

/** 桌面远程节点层里改由所在电脑 main 处理的通道前缀：本机窗口、节点切换、系统通知 */
export const REMOTE_LOCAL_PREFIXES = ['nodes:', 'window:', 'notification:'] as const;

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
  /** 离开桌面模式回手机版；只有手机壳提供 */
  exitDesk?(): void;
  /** 打开壳里的「电脑与通知」抽屉（推送、已配对电脑）；只有新版手机壳提供 */
  openDevices?(): void;
  /**
   * 桌面远程节点层专属：所在电脑（guest）main 的通道。REMOTE_LOCAL_PREFIXES 前缀的调用改走这里，
   * 由 guest main 白名单裁决；invoke 回 `{ ok, value | error }` 的 JSON。
   */
  local?: Omit<RemoteBridgeFrame, 'close'>;
  /** 与 local 同时提供：所在电脑的平台（窗口外观随它） */
  localPlatform?: string;
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
  exitDesk?(): void;
  /** 有它时侧栏用电脑标签打开壳里的抽屉，「精简版」也收进抽屉；没有时保留 Info 弹层 */
  openDevices?(): void;
  /** 跑在另一台桌面的原生窗口里（远程节点层）：所在电脑的平台；窗口按钮与节点切换器可用 */
  nativePlatform?: string;
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

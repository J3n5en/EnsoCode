import {
  browserWebSocketFactory,
  type RelayConnectParams,
  type RelaySocketLike,
  type RelayTransportKind,
  type RelayTransportLane,
} from '@enso/pair';

/**
 * iOS 原生壳（WKWebView + NWProtocolQUIC + 本地 Desk HTTP 代理）注入到 `window.__ensoNative` 的桥接契约。
 * 浏览器 / PWA 环境不存在该对象，所有调用自动透明降级为标准 WebSocket / Service Worker / getUserMedia。
 */
export interface EnsoNativeQuicOpenParams {
  id: string;
  host: string;
  port: number;
  alpn: string;
  pairId: string;
  role: 'host' | 'guest';
  token: string;
  relayEpoch?: string;
  sinceRelaySeq?: number;
}

export interface EnsoNativeBridge {
  readonly platform: 'ios' | 'android';
  /** 是否具备原生 QUIC 传输能力（iOS Network.framework NWProtocolQUIC） */
  readonly quic?: boolean;
  /** 是否由原生壳在本地 loopback 提供 /desk/* 资源代理（替代 WKWebView 中缺失的 SW） */
  readonly deskProxy?: boolean;
  openQuic?(params: EnsoNativeQuicOpenParams): void;
  sendQuicText?(id: string, text: string): void;
  sendQuicBinary?(id: string, lane: RelayTransportLane, base64: string): void;
  closeQuic?(id: string, code?: number, reason?: string): void;
  onQuicOpen?(cb: (id: string) => void): void;
  onQuicControl?(cb: (id: string, text: string) => void): void;
  onQuicBinary?(cb: (id: string, base64: string) => void): void;
  onQuicClose?(cb: (id: string, code: number, reason: string) => void): void;
  /** 原生 AVFoundation 扫码；用户取消返回 null */
  scanQr?(): Promise<string | null>;
  /** 是否具备原生 APNs 端到端推送能力（iOS UNUserNotificationCenter + NSE 本地解密） */
  readonly push?: boolean;
  /** 申请系统通知权限、拿 APNs token 并用本机共享 Keychain E2E 密钥构造标准 WebPushSubscription */
  subscribePush?(
    vapidPublicKey: string,
    gatewayOrigin: string
  ): Promise<
    | { ok: true; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }
    | {
        ok: false;
        reason: 'unsupported' | 'permission-denied' | 'service-unreachable' | 'subscribe-failed';
      }
  >;
  /** 原生退订通知并清角标 */
  unsubscribePush?(): void;
  /** 是否具备原生灵动岛与小组件状态同步能力 */
  readonly widgets?: boolean;
  readonly liveActivity?: boolean;
  /** 把会话聚合快照同步给原生 App Group（小组件）与 ActivityKit（灵动岛） */
  updateWidgetState?(snapshot: NativeWidgetSnapshot): void;
  /** 回传 /desk/* 资源给原生 LocalDeskProxyServer */
  replyDeskAsset?(reqId: string, status: number, mime: string, bodyBase64: string): void;
  /** 是否具备原生画中画（AVPictureInPictureController）实时对话浮窗 */
  readonly pip?: boolean;
  startPip?(): void;
  stopPip?(): void;
  /** 切到后台时是否自动进入画中画 */
  setPipAuto?(enabled: boolean): void;
  /** 调整画中画窗口纵横比：竖屏大窗 / 方形 / 横屏 */
  setPipAspect?(aspect: NativePipAspect): void;
  /** 把当前对话的精简快照推给原生画中画浮窗 */
  updatePipState?(snapshot: NativePipSnapshot): void;
  onPipState?(cb: (state: NativePipStatus) => void): void;
}

export type NativePipAspect = 'portrait' | 'square' | 'landscape';

export interface NativePipStatus {
  supported: boolean;
  active: boolean;
  auto: boolean;
  aspect?: NativePipAspect;
  error?: string | null;
}

export interface NativePipToolStep {
  id: string;
  name: string;
  summary: string;
  state: 'running' | 'ok' | 'error';
  output?: string | null;
}

export interface NativePipTodoSummary {
  done: number;
  total: number;
  current?: string | null;
}

export interface NativePipPendingDetail {
  kind: 'approval' | 'ask';
  title: string;
  summary?: string | null;
}

export interface NativePipMessage {
  id: string;
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'tool-group' | 'system';
  text: string;
  toolName: string | null;
  toolState?: 'running' | 'ok' | 'error' | null;
  detail?: string | null;
  steps?: NativePipToolStep[] | null;
  stepCount?: number | null;
  isStreaming: boolean;
  isError: boolean;
  /** 整数毫秒 */
  timestamp: number;
}

export interface NativePipSnapshot {
  sessionId: string | null;
  title: string;
  projectName: string;
  status: 'running' | 'pending' | 'idle' | 'failed' | 'offline';
  pendingHint: string | null;
  pendingDetail?: NativePipPendingDetail | null;
  todo?: NativePipTodoSummary | null;
  meta?: string | null;
  theme?: 'dark' | 'light';
  runningCount: number;
  pendingCount: number;
  connectionState: string;
  /** 最多 18 条，旧 → 新 */
  messages: NativePipMessage[];
  /** 整数毫秒 */
  updatedAt: number;
}

export interface NativeWidgetSessionItem {
  id: string;
  title: string;
  projectName: string;
  status: string;
  pendingCount: number;
  unread: boolean;
  updatedAt: number;
}

export interface NativeWidgetSnapshot {
  deviceLabel: string;
  connectionState: string;
  transport: string;
  rttMs: number | null;
  runningCount: number;
  pendingCount: number;
  unreadCount: number;
  activeTitle: string | null;
  activeProject: string | null;
  activeSessionId: string | null;
  activeStatus: string;
  activeDetail: string | null;
  startedAt: number | null;
  sessions: NativeWidgetSessionItem[];
  updatedAt: number;
}

interface QuicEndpoint {
  host: string;
  port: number;
  alpn: string;
}

/** 同一中继的 /healthz QUIC 探测结果缓存（5 分钟内复用） */
const QUIC_PROBE_TTL_MS = 5 * 60_000;
/** Happy Eyeballs：UDP QUIC 在此时间内未完成建连则自动切回 WSS，防运营商封 UDP */
const QUIC_HAPPY_EYEBALLS_MS = 250;
const QUIC_BULK_BYTES = 16 * 1024;

interface RelayHealthInfo {
  at: number;
  endpoint: QuicEndpoint | null;
  apns: boolean;
}

const endpointCache = new Map<string, RelayHealthInfo>();
let quicConnSeq = 0;

export function getNativeBridge(): EnsoNativeBridge | null {
  if (typeof window === 'undefined') return null;
  const direct = (window as unknown as { __ensoNative?: EnsoNativeBridge }).__ensoNative;
  if (direct && typeof direct === 'object') return direct;
  try {
    if (window.top && window.top !== window) {
      const topBridge = (window.top as unknown as { __ensoNative?: EnsoNativeBridge }).__ensoNative;
      if (topBridge && typeof topBridge === 'object') return topBridge;
    }
  } catch {}
  return null;
}

export function isNativeIosApp(): boolean {
  return getNativeBridge()?.platform === 'ios';
}

export function hasNativeDeskProxy(): boolean {
  return Boolean(getNativeBridge()?.deskProxy);
}

export function hasNativePush(): boolean {
  const bridge = getNativeBridge();
  return Boolean(bridge?.push && typeof bridge.subscribePush === 'function');
}

export function pushNativeWidgetState(snapshot: NativeWidgetSnapshot): void {
  const bridge = getNativeBridge();
  if (!bridge?.updateWidgetState) return;
  try {
    bridge.updateWidgetState(snapshot);
  } catch {}
}

export async function requestNativeQrScan(): Promise<string | null> {
  const scan = getNativeBridge()?.scanQr;
  if (!scan) return null;
  return scan();
}

export function hasNativePip(): boolean {
  const bridge = getNativeBridge();
  return Boolean(bridge?.pip && typeof bridge.startPip === 'function');
}

function callPip(invoke: (bridge: EnsoNativeBridge) => void): void {
  const bridge = getNativeBridge();
  if (!bridge?.pip) return;
  try {
    invoke(bridge);
  } catch {}
}

export function startNativePip(): void {
  callPip((bridge) => bridge.startPip?.());
}

export function stopNativePip(): void {
  callPip((bridge) => bridge.stopPip?.());
}

export function setNativePipAuto(enabled: boolean): void {
  callPip((bridge) => bridge.setPipAuto?.(enabled));
}

export function setNativePipAspect(aspect: NativePipAspect): void {
  callPip((bridge) => bridge.setPipAspect?.(aspect));
}

export function pushNativePipState(snapshot: NativePipSnapshot): void {
  callPip((bridge) => bridge.updatePipState?.(snapshot));
}

/** 原生回调只能挂一个：这里收口后按 Set 分发，晚到的订阅者先拿到最近一次状态 */
const pipListeners = new Set<(status: NativePipStatus) => void>();
let pipBoundBridge: EnsoNativeBridge | null = null;
let lastPipStatus: NativePipStatus | null = null;

function parsePipStatus(raw: unknown): NativePipStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const aspect =
    value.aspect === 'portrait' || value.aspect === 'square' || value.aspect === 'landscape'
      ? value.aspect
      : 'portrait';
  return {
    supported: value.supported === true,
    active: value.active === true,
    auto: value.auto === true,
    aspect,
    error: typeof value.error === 'string' && value.error ? value.error : null,
  };
}

export function subscribeNativePipState(cb: (status: NativePipStatus) => void): () => void {
  const bridge = getNativeBridge();
  if (!bridge?.onPipState) return () => {};
  if (pipBoundBridge !== bridge) {
    pipBoundBridge = bridge;
    lastPipStatus = null;
    bridge.onPipState((raw) => {
      if (pipBoundBridge !== bridge) return;
      const status = parsePipStatus(raw);
      if (!status) return;
      lastPipStatus = status;
      for (const listener of [...pipListeners]) {
        try {
          listener(status);
        } catch {}
      }
    });
  }
  pipListeners.add(cb);
  if (lastPipStatus) cb(lastPipStatus);
  return () => {
    pipListeners.delete(cb);
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

async function probeRelayHealth(
  relayUrl: string,
  options?: { fresh?: boolean }
): Promise<RelayHealthInfo | null> {
  const now = Date.now();
  const cached = endpointCache.get(relayUrl);
  if (!options?.fresh && cached && now - cached.at < QUIC_PROBE_TTL_MS) return cached;
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return null;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${parsed.origin}/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const miss: RelayHealthInfo = { at: now, endpoint: null, apns: false };
      endpointCache.set(relayUrl, miss);
      return miss;
    }
    const body = (await res.json()) as {
      quic?: unknown;
      quicPort?: unknown;
      alpn?: unknown;
      apns?: unknown;
    };
    const endpoint: QuicEndpoint | null =
      body.quic === true &&
      typeof body.quicPort === 'number' &&
      Number.isInteger(body.quicPort) &&
      body.quicPort > 0 &&
      body.quicPort <= 65535
        ? {
            host: parsed.hostname,
            port: body.quicPort,
            alpn: typeof body.alpn === 'string' && body.alpn ? body.alpn : 'enso-pair/1',
          }
        : null;
    const info: RelayHealthInfo = { at: now, endpoint, apns: body.apns === true };
    endpointCache.set(relayUrl, info);
    return info;
  } catch {}
  const miss: RelayHealthInfo = { at: now, endpoint: null, apns: false };
  endpointCache.set(relayUrl, miss);
  return miss;
}

async function probeQuicEndpoint(relayUrl: string): Promise<QuicEndpoint | null> {
  return (await probeRelayHealth(relayUrl))?.endpoint ?? null;
}

/**
 * 解析当前中继的 APNs E2E 推送网关：只有当前中继为 `https://` 且 `/healthz` 返回 `apns: true`
 * 时返回其 origin；未配置 APNs 证书的中继（例如空置的 CF 中继）返回 null，避免假成功订阅。
 */
export async function resolveNativePushGatewayOrigin(relayUrl?: string): Promise<string | null> {
  if (!relayUrl) return null;
  try {
    const normalized = relayUrl.trim().replace(/^wss:\/\//i, 'https://');
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:') return null;
    const cached = endpointCache.get(normalized);
    // 仅命中过 apns:true 时复用缓存；未命中或曾因弱网/未重启中继失败时重新探测，避免 5 分钟假失败
    const health = await probeRelayHealth(normalized, { fresh: !cached?.apns });
    return health?.apns ? parsed.origin : null;
  } catch {
    return null;
  }
}

// 全局复用原生 QUIC 回调分发器：每个连接按 id 路由，避免反复覆盖 native callback
interface QuicCallbacks {
  onOpen: () => void;
  onControl: (text: string) => void;
  onBinary: (base64: string) => void;
  onClose: (code: number, reason: string) => void;
}

const quicRegistry = new Map<string, QuicCallbacks>();
let wiredBridge: EnsoNativeBridge | null = null;

function ensureQuicWired(native: EnsoNativeBridge): void {
  if (wiredBridge === native) return;
  wiredBridge = native;
  native.onQuicOpen?.((id) => quicRegistry.get(id)?.onOpen());
  native.onQuicControl?.((id, text) => quicRegistry.get(id)?.onControl(text));
  native.onQuicBinary?.((id, base64) => quicRegistry.get(id)?.onBinary(base64));
  native.onQuicClose?.((id, code, reason) => quicRegistry.get(id)?.onClose(code, reason));
}

/**
 * 复合 RelaySocketLike：
 * - 优先探测中继 `/healthz`，若开启 QUIC 则通过 iOS `NWProtocolQUIC` 发起连接；
 * - 若中继不支持 QUIC（如 CF Workers），或 QUIC 在 250ms Happy Eyeballs 窗口内未就绪，
 *   自动平滑回落标准 WebSocket，上层 PairClient 零感知。
 */
class HappyEyeballsRelaySocket implements RelaySocketLike {
  readyState = 0; // CONNECTING
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  transportKind: RelayTransportKind = 'ws';

  private active: 'pending' | 'quic' | 'ws' | 'closed' = 'pending';
  private quicId: string | null = null;
  private ws: RelaySocketLike | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    private native: EnsoNativeBridge,
    private params: RelayConnectParams
  ) {
    ensureQuicWired(native);
    void this.start();
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string, event: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(event);
      } catch {}
    }
  }

  private emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
    this.dispatch('open', { type: 'open' });
  }

  private emitMessage(event: { data: unknown }): void {
    this.onmessage?.(event);
    this.dispatch('message', event);
  }

  private emitError(): void {
    this.onerror?.();
    this.dispatch('error', { type: 'error' });
  }

  private async start(): Promise<void> {
    const endpoint = await probeQuicEndpoint(this.params.relayUrl);
    if (this.active !== 'pending') return;
    if (!endpoint || !this.native.openQuic) {
      this.fallbackToWs();
      return;
    }
    const id = `q-${++quicConnSeq}`;
    this.quicId = id;
    quicRegistry.set(id, {
      onOpen: () => {
        if (this.active !== 'pending' || this.quicId !== id) return;
        this.clearFallbackTimer();
        this.active = 'quic';
        this.transportKind = 'quic';
        this.emitOpen();
      },
      onControl: (text) => {
        if (this.active !== 'quic' || this.quicId !== id) return;
        // 心跳兼容：QUIC 控制流 {"type":"pong"} 映射为 PairClient/attachHeartbeat 期望的 "pong"
        try {
          const parsed = JSON.parse(text) as { type?: string };
          if (parsed.type === 'pong') {
            this.emitMessage({ data: 'pong' });
            return;
          }
          if (parsed.type === 'close') {
            const info = parsed as { code?: number; reason?: string };
            this.finishClose(info.code ?? 1000, info.reason ?? '');
            return;
          }
        } catch {}
        this.emitMessage({ data: text });
      },
      onBinary: (base64) => {
        if (this.active !== 'quic' || this.quicId !== id) return;
        this.emitMessage({ data: base64ToArrayBuffer(base64) });
      },
      onClose: (code, reason) => {
        quicRegistry.delete(id);
        if (this.active === 'pending') {
          // 建连阶段 QUIC 失败 → 立即回落 WSS，并使探测缓存短时失效以免卡住
          this.clearFallbackTimer();
          this.quicId = null;
          this.fallbackToWs();
          return;
        }
        if (this.active === 'quic') {
          this.finishClose(code, reason);
        }
      },
    });

    this.fallbackTimer = setTimeout(() => {
      if (this.active !== 'pending') return;
      const staleId = this.quicId;
      this.quicId = null;
      if (staleId) {
        quicRegistry.delete(staleId);
        this.native.closeQuic?.(staleId, 1000, 'happy-eyeballs-fallback');
      }
      this.fallbackToWs();
    }, QUIC_HAPPY_EYEBALLS_MS);

    this.native.openQuic({
      id,
      host: endpoint.host,
      port: endpoint.port,
      alpn: endpoint.alpn,
      pairId: this.params.pairId,
      role: this.params.role,
      token: this.params.token,
      ...(this.params.relayEpoch !== undefined ? { relayEpoch: this.params.relayEpoch } : {}),
      ...(this.params.sinceRelaySeq !== undefined
        ? { sinceRelaySeq: this.params.sinceRelaySeq }
        : {}),
    });
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private fallbackToWs(): void {
    if (this.active !== 'pending') return;
    this.clearFallbackTimer();
    this.active = 'ws';
    this.transportKind = 'ws';
    let ws: RelaySocketLike;
    try {
      ws = browserWebSocketFactory(this.params);
    } catch {
      this.finishClose(1006, 'ws-create-failed');
      return;
    }
    ws.binaryType = this.binaryType;
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws || this.active !== 'ws') return;
      this.emitOpen();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || this.active !== 'ws') return;
      this.emitMessage(event);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws || this.active !== 'ws') return;
      this.finishClose(event.code, event.reason);
    };
    ws.onerror = () => {
      if (this.ws !== ws || this.active !== 'ws') return;
      this.emitError();
    };
  }

  private finishClose(code: number, reason: string): void {
    if (this.active === 'closed') return;
    this.clearFallbackTimer();
    this.active = 'closed';
    this.readyState = 3;
    const event = { code, reason };
    this.onclose?.(event);
    this.dispatch('close', event);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.active === 'ws') {
      this.ws?.send(data);
      return;
    }
    if (this.active !== 'quic' || !this.quicId) return;
    if (typeof data === 'string') {
      const payload = data === 'ping' ? JSON.stringify({ type: 'ping' }) : data;
      this.native.sendQuicText?.(this.quicId, payload);
      return;
    }
    const bytes = toBytes(data);
    const lane: RelayTransportLane = bytes.byteLength >= QUIC_BULK_BYTES ? 'bulk' : 'ctrl';
    this.native.sendQuicBinary?.(this.quicId, lane, bytesToBase64(bytes));
  }

  sendOnLane(data: ArrayBuffer | Uint8Array, lane: RelayTransportLane): void {
    if (this.active === 'ws') {
      this.ws?.send(data);
      return;
    }
    if (this.active !== 'quic' || !this.quicId) return;
    this.native.sendQuicBinary?.(this.quicId, lane, bytesToBase64(toBytes(data)));
  }

  close(code = 1000, reason = ''): void {
    if (this.active === 'closed') return;
    this.clearFallbackTimer();
    const prev = this.active;
    this.active = 'closed';
    this.readyState = 3;
    if (this.quicId) {
      const id = this.quicId;
      this.quicId = null;
      quicRegistry.delete(id);
      this.native.closeQuic?.(id, code, reason);
    }
    if (prev === 'ws' && this.ws) {
      try {
        this.ws.close(code, reason);
      } catch {}
      this.ws = null;
    }
  }
}

/** 根据运行环境选择原生 QUIC（带 Happy Eyeballs 回落）或标准浏览器 WebSocket */
export function createNativeOrBrowserRelaySocket(params: RelayConnectParams): RelaySocketLike {
  const native = getNativeBridge();
  if (native?.quic && native.openQuic) {
    return new HappyEyeballsRelaySocket(native, params);
  }
  return browserWebSocketFactory(params);
}

/**
 * 注册给原生 iOS LocalDeskProxyServer 调用的资源拉取钩子：
 * WKWebView 加载本地 loopback `/desk/<pairId>/<ver>/*` 时，原生代理直接回调此函数通过加密隧道取资源。
 */
export function registerNativeDeskFetcher(
  fetcher: (path: string) => Promise<{ status: number; mime: string; body: Uint8Array }>
): () => void {
  const native = getNativeBridge();
  if (!native?.replyDeskAsset || typeof window === 'undefined') return () => {};
  const win = window as unknown as {
    __ensoDeskNativeFetch?: (reqId: string, path: string) => void;
  };
  const handler = (reqId: string, path: string) => {
    void fetcher(path)
      .then((asset) => {
        native.replyDeskAsset?.(reqId, asset.status, asset.mime, bytesToBase64(asset.body));
      })
      .catch(() => {
        native.replyDeskAsset?.(reqId, 502, 'text/plain', '');
      });
  };
  win.__ensoDeskNativeFetch = handler;
  return () => {
    if (win.__ensoDeskNativeFetch === handler) delete win.__ensoDeskNativeFetch;
  };
}

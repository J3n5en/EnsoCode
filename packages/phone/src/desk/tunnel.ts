import {
  createRemoteOrderedStream,
  createRemotePartAssembler,
  decodeBase64,
  gunzipRemoteFrame,
  type HostToRemote,
  isHostRemoteFrame,
  isRemotePart,
  type PairedDevice,
  type PhoneToHost,
  type RemoteKind,
  type RemoteToHost,
  splitRemoteFrame,
} from '@enso/pair';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { type ConnState, PairClient } from '../client';
import type { PhoneCacheStore } from '../sessionCache';
import { stallDelay } from './stall';

export interface DeskLinkHooks {
  onTransport?(transport: 'relay' | 'direct'): void;
  onRtt?(rttMs: number): void;
  onPushConfig?(key: string): void;
}

export interface DeskAsset {
  status: number;
  mime: string;
  body: Uint8Array;
}

type Sequenced = Extract<HostToRemote, { type: 'rpc-result' | 'rpc-event' }>;
type Request = Extract<RemoteToHost, { type: 'rpc-invoke' | 'rpc-send' }>;

interface Slot {
  cid: string;
  kind: RemoteKind;
  ready: boolean;
  everReady: boolean;
  queue: RemoteToHost[];
  pending: Map<
    number,
    { message: Request; resolve: (payload: string) => void; reject: (error: Error) => void }
  >;
  /** 最近发出的 rpc-send：链路可能在察觉前已断，续上后重发（宿主按 id 去重） */
  sends: Request[];
  /** 宿主帧按 seq 顺序应用；缺口久未补齐则重新 hello 让宿主补发 */
  stream: ReturnType<typeof createRemoteOrderedStream<Sequenced>>;
  gapTimer: ReturnType<typeof setTimeout> | null;
  listeners: Map<string, Set<(payload: string) => void>>;
  /** 宿主已丢失该 renderer（重启/缓冲溢出/超时）：壳重载对应 iframe */
  onReset: () => void;
}

export interface DeskFrame {
  invoke(channel: string, payload: string): Promise<string>;
  send(channel: string, payload: string): void;
  on(channel: string, listener: (payload: string) => void): () => void;
  emit(channel: string, args: unknown[]): void;
  close(): void;
}

const encodedArgs = (args: unknown[]) => JSON.stringify(args);
/**
 * 资源请求丢失（通道切换、宿主中继重连）时补发。只在宿主一段时间没有任何下行时才补：
 * 中继下行可能只有几 Mbps，大资源正在传时补发只会让同一份数据再排一遍队。
 */
const ASSET_RETRY_MS = 10_000;
/** 大帧走中继、小帧走直连会乱序；缺口期间这么久没收到任何数据视为丢帧 */
const GAP_RESYNC_MS = 8_000;
const MAX_RECENT_SENDS = 200;
/** 每收这么多分片字节回报一次，宿主据此放行下一段（窗口 512KB） */
const ACK_STEP = 128 * 1024;
const CAN_GUNZIP = typeof DecompressionStream === 'function';

/** 桌面模式不用手机版的会话缓存：连接前读 IndexedDB 里的全部会话正文只会拖慢启动 */
const NO_CACHE: PhoneCacheStore = {
  load: async () => null,
  save: async () => {},
  clear: async () => {},
};

/**
 * 远程桌面隧道：复用手机 PairClient 的中继/直连/重连，承载 rpc-* 与 asset 帧。
 * 每个 renderer iframe 一个 cid；断线重连后逐个重新 hello，宿主能续上就补发缓冲，否则重载 iframe。
 */
export class DeskTunnel {
  private client: PairClient;
  private online = false;
  private seq = 0;
  private slots = new Map<string, Slot>();
  /** 在途资源请求：断线重连后整批重发（应答丢了也能补回） */
  private assets = new Map<
    number,
    {
      message: RemoteToHost;
      resolve: (asset: DeskAsset) => void;
      retry: ReturnType<typeof setInterval>;
    }
  >();
  private parts = createRemotePartAssembler();
  /** 同一路径在途只请求一次（modulepreload 与 import 会同时向 SW 取同一个大文件） */
  private assetPaths = new Map<string, Promise<DeskAsset>>();
  private lastInbound = 0;
  /** 已收到的分片字符数（流控 ack 用） */
  receivedBytes = 0;
  /** 线上收到的大帧字符数（分片、整帧资源、整帧压缩）：启动画面据此显示首次下载进度 */
  downloadedBytes = 0;
  private ackedBytes = 0;
  leader = false;
  private readOnly = false;
  /** 本次页面加载：宿主据此回收旧页面遗留的 renderer */
  private readonly page = crypto.randomUUID();

  constructor(
    device: PairedDevice,
    private onState: (state: ConnState) => void,
    private onFatal: (error: string) => void,
    private link: DeskLinkHooks = {}
  ) {
    this.client = new PairClient(
      device,
      {
        onState: (state) => this.setState(state),
        onCatalog() {},
        onProjects() {},
        onProviders() {},
        onSession() {},
        onRemoteFrame: (frame) => this.receive(frame),
        onTransport: (transport) => this.link.onTransport?.(transport),
        onRtt: (rttMs) => this.link.onRtt?.(rttMs),
        onPushConfig: (key) => this.link.onPushConfig?.(key),
        // host-info 先报 readOnly 再报 remoteDesktop：不支持时区分只读与旧桌面
        onReadOnly: (readOnly) => {
          this.readOnly = readOnly;
        },
        onRemoteDesktop: (available) => {
          if (!available) this.onFatal(this.readOnly ? 'read-only' : 'host-outdated');
        },
      },
      undefined,
      NO_CACHE
    );
  }

  /** 推送订阅帧走手机协议，不进 renderer 隧道 */
  sendGuest(message: PhoneToHost): void {
    this.client.send(message);
  }

  start(): void {
    const client = this.client;
    client.connect();
    const visible = () => document.visibilityState === 'visible';
    document.addEventListener('visibilitychange', () => {
      if (visible()) client.nudge('visibility');
      else client.conceal();
      client.send({ type: 'presence', visible: visible() });
    });
    window.addEventListener('online', () => {
      if (visible()) client.nudge('online');
    });
    window.addEventListener('pageshow', (event) => {
      if (visible()) client.nudge(event.persisted ? 'online' : 'visibility');
    });
    window.addEventListener('focus', () => {
      if (visible()) client.nudge('visibility');
    });
    window.addEventListener('pagehide', (event) => {
      client.conceal();
      // 真卸载（刷新/离开）尽力告别；进 bfcache 的页面可能回来，不发
      if (!event.persisted && this.online)
        for (const cid of this.slots.keys()) this.post({ type: 'rpc-bye', cid });
    });
  }

  private setState(state: ConnState): void {
    this.onState(state);
    const was = this.online;
    this.online = state === 'online';
    if (this.online && was) {
      // 已在线又收到 host-online：桌面到中继的连接重建过，之前发过去的请求、发过来的帧可能都丢在旧连接上。
      // 按 seq 重新 hello 让宿主补发，在途资源重新请求
      for (const slot of this.slots.values()) if (slot.ready) this.hello(slot);
      for (const { message } of this.assets.values()) this.post(message);
      return;
    }
    if (this.online === was) return;
    for (const slot of this.slots.values()) slot.ready = false;
    if (!this.online) return;
    // 先声明会回报进度，宿主随即对大帧限流
    this.ack();
    for (const slot of this.slots.values()) this.hello(slot);
    for (const { message } of this.assets.values()) this.post(message);
  }

  private post(message: RemoteToHost): void {
    for (const frame of splitRemoteFrame(message, () => crypto.randomUUID())) {
      this.client.send(frame as PhoneToHost, { bulk: frame.type === 'part' });
    }
  }

  private ack(): void {
    this.ackedBytes = this.receivedBytes;
    this.client.send({
      type: 'remote-ack',
      bytes: this.receivedBytes,
      ...(CAN_GUNZIP ? { gzip: true as const } : {}),
    });
  }

  private hello(slot: Slot): void {
    this.post({
      type: 'rpc-hello',
      cid: slot.cid,
      kind: slot.kind,
      seq: slot.stream.applied,
      page: this.page,
    });
  }

  /** 续上后重发宿主可能没收到的请求：未决 invoke 与最近的 send，按发出顺序，排在离线队列之前 */
  private resend(slot: Slot): void {
    const queued = new Set(slot.queue.map((message) => ('id' in message ? message.id : undefined)));
    const lost = [...[...slot.pending.values()].map((entry) => entry.message), ...slot.sends]
      .filter((message) => message.id === undefined || !queued.has(message.id))
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    for (const message of lost) this.post(message);
  }

  private ordered(slot: Slot, frame: Sequenced): void {
    for (const ready of slot.stream.push(frame.seq, frame)) this.apply(slot, ready);
    if (slot.stream.overflowed) {
      this.reset(slot);
      return;
    }
    if (!slot.stream.gap) {
      if (slot.gapTimer) clearTimeout(slot.gapTimer);
      slot.gapTimer = null;
    } else if (!slot.gapTimer) {
      this.watchGap(slot, Date.now());
    }
  }

  /** 缺口持续且这段时间没收到任何数据才判丢帧、重新 hello；大帧还在传时继续等 */
  private watchGap(slot: Slot, since: number): void {
    const delay = stallDelay(Date.now(), GAP_RESYNC_MS, since, this.lastInbound);
    slot.gapTimer = setTimeout(() => {
      slot.gapTimer = null;
      if (!slot.stream.gap || !this.slots.has(slot.cid)) return;
      if (stallDelay(Date.now(), GAP_RESYNC_MS, since, this.lastInbound) > 0) {
        this.watchGap(slot, since);
        return;
      }
      if (this.online) this.hello(slot);
      this.watchGap(slot, Date.now());
    }, delay);
  }

  /** 无法续上：通知宿主释放旧 renderer（否则它仍算在线主界面），重载 iframe 以新 cid 接入 */
  private reset(slot: Slot): void {
    this.drop(slot, 'remote-session-lost');
    this.slots.delete(slot.cid);
    if (this.online) this.post({ type: 'rpc-bye', cid: slot.cid });
    slot.onReset();
  }

  private apply(slot: Slot, frame: Sequenced): void {
    if (frame.type === 'rpc-result') {
      const pending = slot.pending.get(frame.id);
      if (!pending) return;
      slot.pending.delete(frame.id);
      if (frame.ok) pending.resolve(JSON.stringify(frame.data ?? null));
      else pending.reject(new Error(frame.error));
      return;
    }
    if (slot.kind === 'main' && frame.ch === IPC_CHANNELS.REMOTE_LEADER_CHANGED) {
      this.leader = Array.isArray(frame.args) && frame.args[0] === true;
    }
    this.dispatch(slot, frame.ch, JSON.stringify(frame.args ?? []));
  }

  private dispatch(slot: Slot, channel: string, payload: string): void {
    for (const listener of [...(slot.listeners.get(channel) ?? [])]) {
      try {
        listener(payload);
      } catch (error) {
        console.error('[desk] listener failed', channel, error);
      }
    }
  }

  private receive(frame: HostToRemote, nested = false): void {
    this.lastInbound = Date.now();
    if (!nested && (isRemotePart(frame) || frame.type === 'asset' || frame.type === 'gzip'))
      this.downloadedBytes += frame.data.length;
    if (isRemotePart(frame)) {
      this.receivedBytes += frame.data.length;
      if (this.receivedBytes - this.ackedBytes >= ACK_STEP) this.ack();
      const assembled = this.parts.push(frame);
      if (
        assembled &&
        typeof assembled === 'object' &&
        typeof (assembled as { type?: unknown }).type === 'string' &&
        isHostRemoteFrame(assembled as { type: string }) &&
        !isRemotePart(assembled)
      ) {
        this.receive(assembled as HostToRemote, true);
      }
      return;
    }
    switch (frame.type) {
      case 'gzip':
        void gunzipRemoteFrame(frame).then((inner) => {
          const type = (inner as { type?: unknown } | null)?.type;
          if (typeof type !== 'string' || type === 'gzip' || type === 'part') return;
          if (isHostRemoteFrame({ type })) this.receive(inner as HostToRemote, true);
        });
        return;
      case 'asset': {
        const pending = this.assets.get(frame.id);
        if (!pending) return;
        this.assets.delete(frame.id);
        clearInterval(pending.retry);
        pending.resolve({ status: frame.status, mime: frame.mime, body: decodeBase64(frame.data) });
        return;
      }
      case 'rpc-ready': {
        const slot = this.slots.get(frame.cid);
        if (!slot) return;
        if (!frame.ok) {
          this.onFatal(frame.error);
          return;
        }
        const lost = slot.everReady && !frame.resumed;
        const resumed = slot.everReady && frame.resumed;
        slot.everReady = true;
        if (lost) {
          this.reset(slot);
          return;
        }
        if (resumed && frame.replay) this.resend(slot);
        if (slot.kind === 'main') {
          this.leader = frame.leader;
          this.dispatch(slot, IPC_CHANNELS.REMOTE_LEADER_CHANGED, encodedArgs([frame.leader]));
        }
        slot.ready = true;
        const queued = slot.queue;
        slot.queue = [];
        for (const message of queued) this.post(message);
        return;
      }
      case 'rpc-result':
      case 'rpc-event': {
        const slot = this.slots.get(frame.cid);
        if (slot) this.ordered(slot, frame);
        return;
      }
    }
  }

  private drop(slot: Slot, reason: string): void {
    for (const pending of slot.pending.values()) pending.reject(new Error(reason));
    slot.pending.clear();
    slot.queue = [];
    slot.sends = [];
    if (slot.gapTimer) clearTimeout(slot.gapTimer);
    slot.gapTimer = null;
  }

  private enqueue(slot: Slot, message: RemoteToHost): void {
    if (slot.ready && this.online) this.post(message);
    else slot.queue.push(message);
  }

  attach(kind: RemoteKind, onReset: () => void): DeskFrame {
    const slot: Slot = {
      cid: crypto.randomUUID(),
      kind,
      ready: false,
      everReady: false,
      queue: [],
      pending: new Map(),
      sends: [],
      stream: createRemoteOrderedStream<Sequenced>(),
      gapTimer: null,
      listeners: new Map(),
      onReset,
    };
    this.slots.set(slot.cid, slot);
    if (this.online) this.hello(slot);
    return {
      invoke: (channel, payload) =>
        new Promise<string>((resolve, reject) => {
          const message: Request = {
            type: 'rpc-invoke',
            cid: slot.cid,
            id: ++this.seq,
            ch: channel,
            args: JSON.parse(payload),
          };
          slot.pending.set(message.id as number, { message, resolve, reject });
          this.enqueue(slot, message);
        }),
      send: (channel, payload) => {
        const message: Request = {
          type: 'rpc-send',
          cid: slot.cid,
          id: ++this.seq,
          ch: channel,
          args: JSON.parse(payload),
        };
        slot.sends.push(message);
        if (slot.sends.length > MAX_RECENT_SENDS) slot.sends.shift();
        this.enqueue(slot, message);
      },
      on: (channel, listener) => {
        let set = slot.listeners.get(channel);
        if (!set) {
          set = new Set();
          slot.listeners.set(channel, set);
        }
        set.add(listener);
        return () => set.delete(listener);
      },
      emit: (channel, args) => this.dispatch(slot, channel, encodedArgs(args)),
      close: () => {
        if (!this.slots.has(slot.cid)) return;
        this.slots.delete(slot.cid);
        this.drop(slot, 'remote-frame-closed');
        if (this.online) this.post({ type: 'rpc-bye', cid: slot.cid });
      },
    };
  }

  fetchAsset(path: string): Promise<DeskAsset> {
    const inflight = this.assetPaths.get(path);
    if (inflight) return inflight;
    const promise = new Promise<DeskAsset>((resolve) => {
      const id = ++this.seq;
      const message: RemoteToHost = { type: 'asset-get', id, path };
      let sentAt = Date.now();
      const retry = setInterval(() => {
        if (!this.online || stallDelay(Date.now(), ASSET_RETRY_MS, this.lastInbound, sentAt) > 0)
          return;
        sentAt = Date.now();
        this.post(message);
      }, ASSET_RETRY_MS / 2);
      this.assets.set(id, { message, resolve, retry });
      if (this.online) this.post(message);
    }).finally(() => this.assetPaths.delete(path));
    this.assetPaths.set(path, promise);
    return promise;
  }
}

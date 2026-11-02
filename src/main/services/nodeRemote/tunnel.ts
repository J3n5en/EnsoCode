import { randomUUID } from 'node:crypto';
import {
  createRemoteOrderedStream,
  createRemotePartAssembler,
  decodeBase64,
  gunzipRemoteFrame,
  type HostToRemote,
  isHostRemoteFrame,
  isRemotePart,
  type RemoteKind,
  type RemoteToHost,
  splitRemoteFrame,
} from '@enso/pair';

export interface NodeAsset {
  status: number;
  mime: string;
  body: Uint8Array;
}

export interface NodeFrameHandlers {
  onEvent(channel: string, payload: string): void;
  /** 宿主已丢失该 renderer：调用方重载页面 */
  onReset(): void;
}

type Sequenced = Extract<HostToRemote, { type: 'rpc-result' | 'rpc-event' }>;
type Request = Extract<RemoteToHost, { type: 'rpc-invoke' | 'rpc-send' }>;

interface Slot {
  cid: string;
  kind: RemoteKind;
  ready: boolean;
  everReady: boolean;
  queue: Request[];
  pending: Map<
    number,
    { message: Request; resolve: (v: string) => void; reject: (e: Error) => void }
  >;
  stream: ReturnType<typeof createRemoteOrderedStream<Sequenced>>;
  gapTimer: NodeJS.Timeout | null;
  handlers: NodeFrameHandlers;
}

/** 缺口持续这么久视为丢帧，重新 hello 让宿主补发 */
const GAP_RESYNC_MS = 8_000;
/** 每收这么多分片字节回报一次进度（宿主据此放行后续大帧） */
const ACK_STEP = 128 * 1024;

/**
 * guest 桌面经配对通道驱动宿主 renderer 的 rpc 隧道（对应浏览器端 DeskTunnel）。
 * 上线即发 remote-ack(gzip)：宿主才会压缩大帧，并按回报的字节数限流。
 */
export class NodeRemoteTunnel {
  private online = false;
  private seq = 0;
  private receivedBytes = 0;
  private ackedBytes = 0;
  private slots = new Map<string, Slot>();
  private assets = new Map<number, { message: RemoteToHost; resolve: (a: NodeAsset) => void }>();
  private parts = createRemotePartAssembler();

  constructor(private readonly post: (frame: RemoteToHost) => void) {}

  private postSplit(message: RemoteToHost): void {
    for (const frame of splitRemoteFrame(message, randomUUID)) this.post(frame as RemoteToHost);
  }

  private hello(slot: Slot): void {
    this.post({ type: 'rpc-hello', cid: slot.cid, kind: slot.kind, seq: slot.stream.applied });
  }

  private ack(): void {
    this.ackedBytes = this.receivedBytes;
    this.post({ type: 'remote-ack', bytes: this.receivedBytes, gzip: true });
  }

  /** 宿主在线（含中继重建后再次 host-online）：逐个 hello 续上，补发在途资源请求 */
  setOnline(online: boolean): void {
    this.online = online;
    for (const slot of this.slots.values()) {
      slot.ready = false;
    }
    if (!online) return;
    // 宿主换连接会重置限流窗口与压缩开关，每次上线都重新声明
    this.ack();
    for (const slot of this.slots.values()) this.hello(slot);
    for (const { message } of this.assets.values()) this.post(message);
  }

  attach(kind: RemoteKind, handlers: NodeFrameHandlers): string {
    const slot: Slot = {
      cid: randomUUID(),
      kind,
      ready: false,
      everReady: false,
      queue: [],
      pending: new Map(),
      stream: createRemoteOrderedStream<Sequenced>(),
      gapTimer: null,
      handlers,
    };
    this.slots.set(slot.cid, slot);
    if (this.online) this.hello(slot);
    return slot.cid;
  }

  invoke(cid: string, channel: string, payload: string): Promise<string> {
    const slot = this.slots.get(cid);
    if (!slot) return Promise.reject(new Error('remote-frame-closed'));
    return new Promise((resolve, reject) => {
      const message: Request = {
        type: 'rpc-invoke',
        cid,
        id: ++this.seq,
        ch: channel,
        args: JSON.parse(payload),
      };
      slot.pending.set(message.id as number, { message, resolve, reject });
      this.enqueue(slot, message);
    });
  }

  send(cid: string, channel: string, payload: string): void {
    const slot = this.slots.get(cid);
    if (!slot) return;
    let args: unknown;
    try {
      args = JSON.parse(payload);
    } catch {
      return;
    }
    this.enqueue(slot, {
      type: 'rpc-send',
      cid,
      id: ++this.seq,
      ch: channel,
      args,
    });
  }

  detach(cid: string): void {
    const slot = this.slots.get(cid);
    if (!slot) return;
    this.drop(slot, 'remote-frame-closed');
    if (this.online) this.post({ type: 'rpc-bye', cid });
  }

  fetchAsset(path: string): Promise<NodeAsset> {
    return new Promise((resolve) => {
      const message: RemoteToHost = { type: 'asset-get', id: ++this.seq, path };
      this.assets.set(message.id, { message, resolve });
      if (this.online) this.post(message);
    });
  }

  close(): void {
    for (const slot of [...this.slots.values()]) this.detach(slot.cid);
    for (const { resolve } of this.assets.values()) {
      resolve({ status: 503, mime: 'text/plain', body: new Uint8Array() });
    }
    this.assets.clear();
  }

  receive(frame: HostToRemote, nested = false): void {
    if (isRemotePart(frame)) {
      if (!nested) {
        this.receivedBytes += frame.data.length;
        if (this.online && this.receivedBytes - this.ackedBytes >= ACK_STEP) this.ack();
      }
      const whole = this.parts.push(frame) as { type?: unknown } | null;
      if (
        whole &&
        typeof whole.type === 'string' &&
        whole.type !== 'part' &&
        isHostRemoteFrame(whole as { type: string })
      ) {
        this.receive(whole as HostToRemote, true);
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
        pending.resolve({ status: frame.status, mime: frame.mime, body: decodeBase64(frame.data) });
        return;
      }
      case 'rpc-ready': {
        const slot = this.slots.get(frame.cid);
        if (!slot) return;
        if (!frame.ok) {
          this.reset(slot, frame.error);
          return;
        }
        if (slot.everReady && !frame.resumed) {
          this.reset(slot, 'remote-session-lost');
          return;
        }
        if (slot.everReady && frame.replay) {
          const queued = new Set(slot.queue.map((m) => m.id));
          for (const { message } of slot.pending.values()) {
            if (!queued.has(message.id)) this.postSplit(message);
          }
        }
        slot.everReady = true;
        slot.ready = true;
        const queue = slot.queue;
        slot.queue = [];
        for (const message of queue) this.postSplit(message);
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

  private ordered(slot: Slot, frame: Sequenced): void {
    for (const next of slot.stream.push(frame.seq, frame)) this.apply(slot, next);
    if (slot.stream.overflowed) {
      this.reset(slot, 'remote-session-lost');
      return;
    }
    if (!slot.stream.gap) {
      if (slot.gapTimer) clearTimeout(slot.gapTimer);
      slot.gapTimer = null;
    } else if (!slot.gapTimer) {
      slot.gapTimer = setTimeout(() => {
        slot.gapTimer = null;
        if (this.online && slot.stream.gap && this.slots.has(slot.cid)) this.hello(slot);
      }, GAP_RESYNC_MS);
    }
  }

  private apply(slot: Slot, frame: Sequenced): void {
    if (frame.type === 'rpc-event') {
      slot.handlers.onEvent(frame.ch, JSON.stringify(frame.args ?? []));
      return;
    }
    const pending = slot.pending.get(frame.id);
    if (!pending) return;
    slot.pending.delete(frame.id);
    if (frame.ok) pending.resolve(JSON.stringify(frame.data ?? null));
    else pending.reject(new Error(frame.error));
  }

  private enqueue(slot: Slot, message: Request): void {
    if (slot.ready && this.online) this.postSplit(message);
    else slot.queue.push(message);
  }

  private drop(slot: Slot, reason: string): void {
    this.slots.delete(slot.cid);
    for (const pending of slot.pending.values()) pending.reject(new Error(reason));
    slot.pending.clear();
    slot.queue = [];
    if (slot.gapTimer) clearTimeout(slot.gapTimer);
    slot.gapTimer = null;
  }

  private reset(slot: Slot, reason: string): void {
    this.drop(slot, reason);
    if (this.online) this.post({ type: 'rpc-bye', cid: slot.cid });
    slot.handlers.onReset();
  }
}

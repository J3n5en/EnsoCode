import type { HostToPhone, IceServerEntry, PhoneToHost } from '../protocol';
import { createReassembler, encodeChunks, type Reassembler } from './chunk';
import {
  DIRECT_NEGOTIATE_TIMEOUT_MS,
  type DirectAction,
  type DirectRole,
  type DirectState,
  type DirectTransport,
  directBackoffDelay,
  initialDirectState,
  reduceDirect,
} from './directSession';
import {
  type DirectPeer,
  type DirectPeerFactory,
  isAllowedCandidate,
  normalizeCandidate,
} from './peer';

/** 经中继 E2E 帧交换的直连信令（上下行并集） */
export type DirectSignal = Extract<
  PhoneToHost | HostToPhone,
  { type: 'direct-offer' | 'direct-answer' | 'direct-ice' | 'direct-close' }
>;

export interface DirectLinkDeps {
  role: DirectRole;
  /** null = 本端没有 WebRTC 实现（原生模块加载失败等），永远走中继 */
  factory: DirectPeerFactory | null;
  /** host 自用常量；guest 以 host-info 下发值覆盖 */
  iceServers?: IceServerEntry[];
  /** 把信令帧加密后经中继发出（调用方负责 sealFrame + ws.send） */
  sendSignal(signal: DirectSignal): void;
  /** 直连上收到的完整密文帧 → 调用方走同一 handleFrame */
  onFrame(frame: Uint8Array): void;
  onTransportChange(transport: DirectTransport): void;
  /** 切通道后修复缝隙：guest 重发 snapshot/subscribe，host 重推 meta */
  onResync(): void;
}

/** DataChannel 心跳字节：与分片头（0x00/0x01）区分，在拆片之前拦截 */
const PING = 0x02;
const PONG = 0x03;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * 状态机 + peer 生命周期 + 定时器 + 分片 + 心跳的胶水，三端共用。
 * 调用方只需：把 host-info / 直连信令 / 在线态 / 网络变化喂进来，并在发送前问 transport()。
 */
export class DirectLink {
  private state: DirectState;
  private peer: DirectPeer | null = null;
  private peerGen = 0;
  private dcOpen = false;
  private iceServers: IceServerEntry[];
  private reassembler: Reassembler = createReassembler();
  private negotiateTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatDeadline: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private deps: DirectLinkDeps) {
    this.state = initialDirectState(deps.role);
    this.iceServers = deps.iceServers ?? [];
  }

  // ── 输入 ──────────────────────────────────────────────────────────

  /** guest：收到 host-info，读能力与 STUN 列表 */
  hostInfo(info: { capabilities?: string[]; iceServers?: IceServerEntry[] }): void {
    if (info.iceServers) this.iceServers = info.iceServers;
    const capable = this.deps.factory !== null && (info.capabilities ?? []).includes('direct-v1');
    this.dispatch({ type: 'peer-capable', capable });
  }

  peerOnline(online: boolean): void {
    this.dispatch({ type: 'peer-online', online });
  }

  handleSignal(signal: DirectSignal): void {
    switch (signal.type) {
      case 'direct-offer':
        this.pendingOffer = signal.sdp;
        this.dispatch({ type: 'offer', gen: signal.gen });
        break;
      case 'direct-answer':
        this.pendingAnswer = signal.sdp;
        this.dispatch({ type: 'answer', gen: signal.gen });
        break;
      case 'direct-ice':
        this.pendingIce = { candidate: signal.candidate, sdpMid: signal.sdpMid };
        this.dispatch({ type: 'ice', gen: signal.gen });
        break;
      case 'direct-close':
        this.dispatch({ type: 'remote-close', gen: signal.gen });
        break;
    }
  }

  networkChange(): void {
    this.dispatch({ type: 'network-change' });
  }

  /** 对端解绑 / 本端遗忘设备：拆干净但对象仍可复用 */
  peerGone(): void {
    this.dispatch({ type: 'peer-gone' });
  }

  close(): void {
    if (this.closed) return;
    this.dispatch({ type: 'peer-gone' });
    this.closed = true;
    this.clearRetry();
  }

  // ── 输出 ──────────────────────────────────────────────────────────

  transport(): DirectTransport {
    return this.state.phase === 'connected' && this.dcOpen ? 'direct' : 'relay';
  }

  /** 直连可用时分片发出；返回 false 表示调用方应改走中继 */
  send(frame: Uint8Array): boolean {
    if (this.transport() !== 'direct' || !this.peer) return false;
    for (const chunk of encodeChunks(frame)) {
      if (!this.peer.send(chunk)) return false;
    }
    return true;
  }

  // ── 内部：状态机驱动 ──────────────────────────────────────────────

  private pendingOffer = '';
  private pendingAnswer = '';
  private pendingIce: { candidate: string; sdpMid: string | null } | null = null;

  private dispatch(event: Parameters<typeof reduceDirect>[1]): void {
    if (this.closed) return;
    const { state, actions } = reduceDirect(this.state, event);
    this.state = state;
    for (const action of actions) this.run(action);
  }

  private run(action: DirectAction): void {
    switch (action.type) {
      case 'create-offer':
        this.spawnPeer(action.gen, (peer) =>
          peer.createOffer().then((sdp) => {
            if (this.peerGen === action.gen && !this.closed) {
              this.deps.sendSignal({ type: 'direct-offer', gen: action.gen, sdp });
            }
          })
        );
        break;
      case 'accept-offer': {
        const offer = this.pendingOffer;
        this.spawnPeer(action.gen, (peer) =>
          peer.acceptOffer(offer).then((sdp) => {
            if (this.peerGen === action.gen && !this.closed) {
              this.deps.sendSignal({ type: 'direct-answer', gen: action.gen, sdp });
            }
          })
        );
        break;
      }
      case 'apply-answer':
        void this.peer?.acceptAnswer(this.pendingAnswer).catch(() => this.failGen(action.gen));
        break;
      case 'apply-ice':
        if (this.pendingIce) void this.peer?.addIceCandidate(this.pendingIce).catch(() => {});
        break;
      case 'start-timeout':
        this.clearNegotiateTimer();
        this.negotiateTimer = setTimeout(() => {
          this.negotiateTimer = null;
          this.dispatch({ type: 'negotiate-timeout', gen: action.gen });
        }, DIRECT_NEGOTIATE_TIMEOUT_MS);
        break;
      case 'destroy-peer':
        this.destroyPeer();
        break;
      case 'send-close':
        this.deps.sendSignal({ type: 'direct-close', gen: action.gen });
        break;
      case 'switch':
        this.deps.onTransportChange(action.transport);
        break;
      case 'resync':
        this.deps.onResync();
        break;
      case 'schedule-retry':
        this.clearRetry();
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.dispatch({ type: 'cooldown-elapsed' });
        }, directBackoffDelay(action.attempt));
        break;
    }
  }

  private spawnPeer(gen: number, start: (peer: DirectPeer) => Promise<void>): void {
    this.destroyPeer();
    const peer = this.deps.factory?.(this.iceServers) ?? null;
    if (!peer) {
      // 本端建不出 peer（原生模块缺失等）：视为不具备能力，静默回 idle，不发信令不重试
      this.dispatch({ type: 'peer-capable', capable: false });
      return;
    }
    this.peer = peer;
    this.peerGen = gen;
    this.reassembler = createReassembler();
    peer.onIceCandidate((c) => {
      if (this.peerGen !== gen || !isAllowedCandidate(c.candidate)) return;
      this.deps.sendSignal({
        type: 'direct-ice',
        gen,
        candidate: normalizeCandidate(c.candidate),
        sdpMid: c.sdpMid,
      });
    });
    peer.onOpen(() => {
      if (this.peerGen !== gen) return;
      this.dcOpen = true;
      this.clearNegotiateTimer();
      this.startHeartbeat(peer, gen);
      this.dispatch({ type: 'dc-open', gen });
    });
    peer.onMessage((bytes) => {
      if (this.peerGen !== gen) return;
      this.alive();
      if (bytes.byteLength === 1 && bytes[0] === PING) {
        peer.send(new Uint8Array([PONG]));
        return;
      }
      if (bytes.byteLength === 1 && bytes[0] === PONG) return;
      const frame = this.reassembler.push(bytes);
      if (frame) this.deps.onFrame(frame);
    });
    peer.onClose(() => {
      if (this.peerGen === gen) this.dispatch({ type: 'dc-close', gen });
    });
    void start(peer).catch(() => this.failGen(gen));
  }

  /** 建 peer / SDP 阶段抛错：等价于本代通道关闭 */
  private failGen(gen: number): void {
    if (this.peerGen === gen || this.state.gen === gen) {
      this.dispatch({ type: 'dc-close', gen });
    }
  }

  private destroyPeer(): void {
    this.clearNegotiateTimer();
    this.stopHeartbeat();
    this.dcOpen = false;
    const peer = this.peer;
    this.peer = null;
    this.peerGen = -1;
    try {
      peer?.close();
    } catch {}
  }

  // ── 心跳 ──────────────────────────────────────────────────────────

  private startHeartbeat(peer: DirectPeer, gen: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.peerGen !== gen) return;
      peer.send(new Uint8Array([PING]));
      this.heartbeatDeadline ??= setTimeout(() => {
        this.heartbeatDeadline = null;
        if (this.peerGen === gen) this.dispatch({ type: 'dc-close', gen });
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private alive(): void {
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = null;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.alive();
  }

  private clearNegotiateTimer(): void {
    if (this.negotiateTimer) clearTimeout(this.negotiateTimer);
    this.negotiateTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

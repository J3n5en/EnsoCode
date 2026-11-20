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
import { describeCandidates } from './nat';
import {
  DIRECT_BUFFER_LIMIT,
  type DirectPeer,
  type DirectPeerFactory,
  isAllowedCandidate,
  normalizeCandidate,
} from './peer';
import { DIRECT_QUALITY_TIMEOUT_MS, shouldPreferRelay } from './rttPrefer';

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
  /** 每代协商的结果与双方候选摘要（NAT 类型 / 地址族），供日志判断为何打不通 */
  onDiagnostic?(line: string): void;
  /** DataChannel ping→pong 往返（ms）；仅直连通道 */
  onRtt?(ms: number): void;
  /** guest：DC 刚开时测中继 E2E；缺省则跳过比速、打开即切直连 */
  onNeedRelayProbe?(): void;
}

/** DataChannel 心跳字节：与分片头（0x00/0x01）区分，在拆片之前拦截 */
const PING = 0x02;
const PONG = 0x03;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
/** 回前台探活：对端在局域网/直连上，正常几十毫秒内回 pong */
const PROBE_TIMEOUT_MS = 2_000;

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
  private pingSentAt: number | null = null;
  private closed = false;
  private qualityGen: number | null = null;
  private qualityTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDirectRtt: number | null = null;
  private lastRelayRtt: number | null = null;

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
        if (signal.gen === this.state.gen) this.remoteCandidates.push(signal.candidate);
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

  /**
   * 回前台只探活：通道还通就继续用，免得拆掉重协商时在途帧全丢；短时间无回音才判死切回中继。
   * 未连通时返回 false，由调用方按网络变化重建。
   */
  probe(timeoutMs = PROBE_TIMEOUT_MS): boolean {
    const peer = this.peer;
    const gen = this.peerGen;
    if (this.transport() !== 'direct' || !peer) return false;
    this.pingSentAt = Date.now();
    peer.send(new Uint8Array([PING]));
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = setTimeout(() => {
      this.heartbeatDeadline = null;
      if (this.peerGen === gen) this.dispatch({ type: 'dc-close', gen });
    }, timeoutMs);
    return true;
  }

  /** 中继业务 probe 往返（ms）；仅 guest 比速窗口消费 */
  noteRelayRtt(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.lastRelayRtt = ms;
    this.maybeFinishQuality();
  }

  /** 对端解绑 / 本端遗忘设备：拆干净但对象仍可复用 */
  peerGone(): void {
    this.dispatch({ type: 'peer-gone' });
  }

  close(): void {
    if (this.closed) return;
    this.dispatch({ type: 'peer-gone' });
    this.closed = true;
    // idle/cooldown 态 teardown 为空：定时器与 peer 无条件清干净
    this.clearRetry();
    this.destroyPeer();
  }

  // ── 输出 ──────────────────────────────────────────────────────────

  transport(): DirectTransport {
    return this.state.phase === 'connected' && this.dcOpen ? 'direct' : 'relay';
  }

  /** 直连可用时分片发出；返回 false 表示调用方应改走中继 */
  send(frame: Uint8Array): boolean {
    if (this.transport() !== 'direct' || !this.peer) return false;
    // 余量放不下整帧就整帧走中继：大帧连发时若中途背压，半帧会污染对端拼帧器而作废整条直连
    if ((this.peer.buffered?.() ?? 0) + frame.byteLength > DIRECT_BUFFER_LIMIT) return false;
    const chunks = encodeChunks(frame);
    for (let i = 0; i < chunks.length; i++) {
      if (!this.peer.send(chunks[i])) {
        // 半帧已出：对端拼帧器已污染，本代通道作废重协商，别让下一帧拼到残片后面
        if (i > 0) this.failGen(this.peerGen);
        return false;
      }
    }
    return true;
  }

  // ── 内部：状态机驱动 ──────────────────────────────────────────────

  private pendingOffer = '';
  private pendingAnswer = '';
  private pendingIce: { candidate: string; sdpMid: string | null } | null = null;
  private localCandidates: string[] = [];
  private remoteCandidates: string[] = [];

  private dispatch(event: Parameters<typeof reduceDirect>[1]): void {
    if (this.closed) return;
    const prev = this.state;
    const { state, actions } = reduceDirect(this.state, event);
    this.state = state;
    this.diagnose(prev, event);
    for (const action of actions) this.run(action);
  }

  private diagnose(prev: DirectState, event: Parameters<typeof reduceDirect>[1]): void {
    if (!this.deps.onDiagnostic || prev.phase !== 'negotiating') return;
    const outcome =
      this.state.phase === 'connected'
        ? 'open'
        : event.type === 'negotiate-timeout' || event.type === 'dc-close'
          ? 'failed'
          : null;
    if (!outcome) return;
    this.deps.onDiagnostic(
      `direct ${outcome} gen=${prev.gen} local[${describeCandidates(this.localCandidates)}] remote[${describeCandidates(this.remoteCandidates)}]`
    );
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
        // spawnPeer 建不出 peer 时已在同批 action 内回 idle：不留空转定时器
        if (!this.peer) break;
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
      // 本端建不出 peer（原生模块缺失等）：guest 视为不具备能力静默回 idle；
      // host 对 peer-capable 不响应，按本代关闭处理，免得空等 15s
      if (this.deps.role === 'guest') this.dispatch({ type: 'peer-capable', capable: false });
      else this.dispatch({ type: 'dc-close', gen });
      return;
    }
    this.peer = peer;
    this.peerGen = gen;
    this.reassembler = createReassembler();
    this.localCandidates = [];
    this.remoteCandidates = [];
    peer.onIceCandidate((c) => {
      if (this.peerGen !== gen) return;
      this.localCandidates.push(c.candidate);
      if (!isAllowedCandidate(c.candidate)) return;
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
      if (this.deps.role === 'guest' && this.deps.onNeedRelayProbe) {
        this.beginQuality(gen);
        return;
      }
      this.dispatch({ type: 'dc-open', gen });
    });
    peer.onMessage((bytes) => {
      if (this.peerGen !== gen) return;
      this.alive();
      if (bytes.byteLength === 1 && bytes[0] === PING) {
        peer.send(new Uint8Array([PONG]));
        return;
      }
      if (bytes.byteLength === 1 && bytes[0] === PONG) {
        if (this.pingSentAt !== null) {
          const rtt = Date.now() - this.pingSentAt;
          this.deps.onRtt?.(rtt);
          this.lastDirectRtt = rtt;
          this.pingSentAt = null;
          this.maybeFinishQuality();
        }
        return;
      }
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
    this.clearQuality();
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
    const ping = (): void => {
      if (this.peerGen !== gen) return;
      this.pingSentAt = Date.now();
      peer.send(new Uint8Array([PING]));
      this.heartbeatDeadline ??= setTimeout(() => {
        this.heartbeatDeadline = null;
        if (this.peerGen === gen) this.dispatch({ type: 'dc-close', gen });
      }, HEARTBEAT_TIMEOUT_MS);
    };
    ping();
    this.heartbeatTimer = setInterval(ping, HEARTBEAT_INTERVAL_MS);
  }

  private alive(): void {
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = null;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.pingSentAt = null;
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

  private beginQuality(gen: number): void {
    this.clearQuality();
    this.qualityGen = gen;
    this.lastDirectRtt = null;
    this.lastRelayRtt = null;
    this.deps.onNeedRelayProbe?.();
    this.qualityTimer = setTimeout(() => this.finishQuality(gen), DIRECT_QUALITY_TIMEOUT_MS);
  }

  private maybeFinishQuality(): void {
    if (this.qualityGen === null || this.qualityGen !== this.peerGen) return;
    if (this.lastDirectRtt === null || this.lastRelayRtt === null) return;
    this.finishQuality(this.qualityGen);
  }

  private finishQuality(gen: number): void {
    if (this.qualityGen !== gen) return;
    this.clearQuality();
    if (this.peerGen !== gen || !this.dcOpen) return;
    if (
      this.lastDirectRtt !== null &&
      this.lastRelayRtt !== null &&
      shouldPreferRelay(this.lastDirectRtt, this.lastRelayRtt)
    ) {
      this.deps.onDiagnostic?.(
        `direct slower than relay ${Math.round(this.lastDirectRtt)}ms>${Math.round(this.lastRelayRtt)}ms, stay relay`
      );
      this.dispatch({ type: 'prefer-relay' });
      return;
    }
    this.dispatch({ type: 'dc-open', gen });
  }

  private clearQuality(): void {
    if (this.qualityTimer) clearTimeout(this.qualityTimer);
    this.qualityTimer = null;
    this.qualityGen = null;
  }
}

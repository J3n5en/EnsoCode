import {
  attachHeartbeat,
  backoffDelay,
  type CatalogEntry,
  createBrowserDirectPeerFactory,
  DirectLink,
  type DirectPeerFactory,
  type DirectTransport,
  encodeVoiceChunks,
  fromBase64Url,
  type Heartbeat,
  type HostToPhone,
  isConnectStuck,
  isForegroundSocketStale,
  isPairSyncCursor,
  type NudgeReason,
  openFrame,
  type PairBotActivity,
  type PairBotChatSummary,
  type PairBotEvent,
  type PairBotInboxItem,
  type PairBotMember,
  type PairedDevice,
  type PairSessionSync,
  type PairSyncCursor,
  type PhoneToHost,
  type ProjectEntry,
  type ProjectGroupEntry,
  type ProviderEntry,
  parsePairSessionSync,
  RELAY_CONNECT_TIMEOUT_MS,
  sealFrame,
  shouldReplaceOnNudge,
  toWebSocketUrl,
  VISIBILITY_PROBE_MS,
} from '@enso/pair';
import {
  applyGuestEvent,
  applyGuestHistory,
  applyGuestSnapshot,
  emptyGuestView,
  type GuestSessionView,
  markAllFailed,
} from '@shared/pair/guestProjection';
import {
  applyCatalog,
  applySnapshot,
  applySubscribe,
  initialSync,
  type SyncState,
  type SyncTracking,
} from '@shared/pair/syncProjection';
import { normalizeTimelinePrefs } from '@shared/pair/timelinePrefs';
import {
  SPEECH_MAX_SECONDS,
  SPEECH_SAMPLE_RATE,
  type SpeechErrorCode,
  type SpeechTranscribeResult,
  type VoiceSession,
} from '@shared/types/speech';
import { type PhoneCacheData, type PhoneCacheStore, phoneCache } from './sessionCache';
import {
  setCompactReadOnlyTools,
  setExpandLiveEdits,
  setTerminalAppearance,
  setTimelinePrefs,
} from './stubs/settings-store';
import { setHostTheme } from './theme';

/**
 * 与中继的长连接：自动重连（指数退避 + 抖动）、加解密、
 * 重连后按游标增量续传（游标失配则回落全量 snapshot）。
 */

export type ConnState = 'connecting' | 'online' | 'host-offline' | 'unauthorized' | 'offline';

/** 与桌面远程节点视图共用一份投影结构 */
export type SessionView = GuestSessionView;

export type GroupTimelineFrame = Extract<HostToPhone, { type: 'group-timeline' }>;
export type BotChatStateFrame = Extract<HostToPhone, { type: 'bot-chat-state' }>;
export type BotSendResultFrame = Extract<HostToPhone, { type: 'bot-send-result' }>;

const VOICE_TIMEOUT_MS = 60_000;
/** 约 200ms 一块：桌面边收边识别 */
const VOICE_CHUNK_SAMPLES = SPEECH_SAMPLE_RATE / 5;
const SPEECH_ERRORS: readonly string[] = [
  'disabled',
  'not-ready',
  'invalid-audio',
  'failed',
] satisfies SpeechErrorCode[];

export interface ClientEvents {
  onState(state: ConnState): void;
  onCatalog(entries: CatalogEntry[], pinnedOrder?: string[]): void;
  onProjects(projects: ProjectEntry[], groups?: ProjectGroupEntry[]): void;
  onProviders(providers: ProviderEntry[]): void;
  onSession(sessionId: string, view: SessionView): void;
  /** 桌面下发 VAPID 公钥：有它才能 pushManager.subscribe */
  onPushConfig?(vapidPublicKey: string): void;
  /** 订阅到快照或增量确认之间为 syncing；旧内容仍可展示 */
  onSync?(state: SyncState): void;
  /** 订阅的会话已被桌面删除（曾在目录、现在消失）：上层应跳离该会话 */
  onGhostSession?(sessionId: string): void;
  /** 上滑翻页在途变化 */
  onHistoryPending?(sessionId: string, pending: boolean): void;
  /** 业务帧出口切换：直连（WebRTC）↔ 中继 */
  onTransport?(transport: DirectTransport): void;
  /** 当前业务通道 ping→pong 往返（ms） */
  onRtt?(ms: number): void;
  /** 桌面语音识别是否可用；断线/换主机视为不可用 */
  onVoiceInput?(available: boolean): void;
  /** 桌面把本设备设为只读（host-info.readOnly）；host 侧另有强制拦截 */
  onReadOnly?(readOnly: boolean): void;
  /** 写命令被 host 拦截（如作用域刚被改成只读） */
  onCommandRejected?(command: string, error: string): void;
  /** Bot 模式（桌面开启时才下发；enabled=false = 已关闭） */
  onBotCatalog?(enabled: boolean, bots: PairBotMember[]): void;
  onBotChats?(chats: PairBotChatSummary[]): void;
  onGroupTimeline?(frame: GroupTimelineFrame): void;
  onBotEvent?(event: PairBotEvent): void;
  onBotChatState?(frame: BotChatStateFrame): void;
  onBotSendResult?(frame: BotSendResultFrame): void;
  onBotRetryResult?(frame: Extract<HostToPhone, { type: 'bot-retry-result' }>): void;
  /** Bot 收件箱整表（未结束且未忽略） */
  onBotInbox?(items: PairBotInboxItem[]): void;
  /** 成员实时运行态整表；clockOffset = 本机时钟 − host 时钟 */
  onBotActivity?(items: PairBotActivity[], clockOffset: number): void;
  /** 一条回复的产物卡片与 send_image 图（bot-artifacts 应答） */
  onBotArtifacts?(frame: Extract<HostToPhone, { type: 'bot-artifacts' }>): void;
  onBotArtifactImage?(frame: Extract<HostToPhone, { type: 'bot-artifact-image' }>): void;
}

export class PairClient {
  private ws: WebSocket | null = null;
  private heartbeat: Heartbeat | null = null;
  private contentKey: Uint8Array;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** 中继已告知配对被解除：与 closed（本端主动关闭）区分，前者要提示用户重新配对 */
  private revoked = false;
  private subscribedId: string | null = null;
  private sessions = new Map<string, SessionView>();
  /** 分页请求在途标记（每会话一次一发，响应或换订阅时清） */
  private historyPending = new Set<string>();
  private sync: SyncTracking = initialSync;
  private direct: DirectLink;
  private cursors = new Map<string, PairSyncCursor>();
  private baselines = new Set<string>();
  private pendingSync: {
    sessionId: string;
    requestId: string;
    observed?: PairSyncCursor | 'mixed';
  } | null = null;
  private freshSessionId: string | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private receiveQueue = Promise.resolve();
  private sendQueue = Promise.resolve();
  private cacheReady = false;
  private cacheLoading = false;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheDirty = false;
  /** 当前这条 WS 已经发过进房 snapshot/subscribe；host-online 立刻再来时不再打第二遍 */
  private roomPrimed = false;
  /** 上次退到后台的时刻；回前台用来判断 TCP 是否多半已被冻死 */
  private hiddenAt: number | null = null;
  /** 换中继 socket 期间先别发 offer，等 host-online 再 ICE restart */
  private pendingDirectRestart = false;
  private probeNonce = 0;
  private probeSentAt: number | null = null;
  private voiceInput = false;
  /** 未结束的录音会话：partial 路由与结果/断线结算 */
  private voices = new Map<
    string,
    {
      onPartial: (text: string, correcting: boolean) => void;
      settle: (result: SpeechTranscribeResult) => void;
    }
  >();
  private metadata: Omit<PhoneCacheData, 'sessions'> = {
    catalog: [],
    pinnedOrder: [],
    projects: [],
    projectGroups: [],
    providers: [],
  };

  constructor(
    private device: PairedDevice,
    private events: ClientEvents,
    directFactory: DirectPeerFactory | null = createBrowserDirectPeerFactory(),
    private cache: PhoneCacheStore = phoneCache
  ) {
    this.contentKey = fromBase64Url(device.contentKey);
    this.direct = new DirectLink({
      role: 'guest',
      factory: directFactory,
      // 信令只走中继；直连未建/已坏时信令就是为了修它
      sendSignal: (signal) => this.sendViaRelay(signal as PhoneToHost),
      onFrame: (frame) => this.enqueueFrame(frame),
      onTransportChange: (t) => {
        if (t === 'relay' && this.ws?.readyState !== 1 && !this.revoked && !this.closed) {
          this.events.onState('offline');
          this.dropVoice();
        }
        this.events.onTransport?.(t);
      },
      // 切通道瞬间旧通道在途帧可能丢：按重连同一套语义补（目录 + 游标增量）
      onResync: () => {
        this.roomPrimed = false;
        this.primeRoom();
      },
      onDiagnostic: (line) => console.info(`[pair] ${line}`),
      onRtt: (ms) => this.events.onRtt?.(ms),
      onNeedRelayProbe: () => this.sendRelayProbe(),
    });
  }

  transport(): DirectTransport {
    return this.direct.transport();
  }

  connect(): void {
    if (this.closed || this.revoked || this.cacheLoading || (this.ws && this.ws.readyState < 2))
      return;
    if (!this.cacheReady) {
      this.cacheLoading = true;
      void this.cache
        .load(this.device.pairId)
        .then((cached) => {
          if (!cached || this.closed || this.revoked) return;
          const { sessions, ...metadata } = cached;
          this.metadata = metadata;
          this.sync = {
            ...this.sync,
            knownIds: new Set(metadata.catalog.map((entry) => entry.id)),
          };
          this.events.onCatalog(metadata.catalog, metadata.pinnedOrder);
          this.events.onProjects(metadata.projects, metadata.projectGroups);
          this.events.onProviders(metadata.providers);
          for (const { id, view, cursor } of sessions) {
            this.sessions.set(id, view);
            this.baselines.add(id);
            if (cursor) this.cursors.set(id, cursor);
            this.events.onSession(id, { ...view, messages: new Map(view.messages) });
          }
        })
        .catch(() => {})
        .finally(() => {
          this.cacheReady = true;
          this.cacheLoading = false;
          this.connect();
        });
      return;
    }
    this.events.onState('connecting');
    const base = toWebSocketUrl(this.device.relayUrl);
    const url = `${base}/v1/pair/${encodeURIComponent(this.device.pairId)}?role=guest&token=${encodeURIComponent(this.device.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.roomPrimed = false;

    // 半开死链的 close 事件可能永不到达：心跳判死后直接走关闭路径，幂等防双跑
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const closed = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (this.ws !== ws) return;
      this.heartbeat?.stop();
      this.heartbeat = null;
      this.ws = null;
      this.roomPrimed = false;
      // 1008 = 中继明确告知凭据已失效（解绑时下发，或带失效凭据重连时下发）
      if (code === 1008 || this.revoked) {
        this.revoke();
        return;
      }
      if (this.closed) return;
      // 直连还活着就不算掉线：中继默默重连，直连再掉时由 onTransportChange 补置 offline
      if (this.direct.transport() !== 'direct') {
        this.events.onState('offline');
        this.dropVoice();
      }
      this.scheduleReconnect();
    };
    this.heartbeat = attachHeartbeat(
      ws,
      () => {
        try {
          ws.close();
        } catch {}
        closed(null);
      },
      (ms) => {
        if (this.direct.transport() === 'relay') this.events.onRtt?.(ms);
      }
    );
    connectTimer = setTimeout(() => {
      if (isConnectStuck(ws.readyState, RELAY_CONNECT_TIMEOUT_MS)) {
        try {
          ws.close();
        } catch {}
        closed(null);
      }
    }, RELAY_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.closed || this.revoked || this.ws !== ws) return;
      clearTimeout(connectTimer);
      this.attempt = 0;
      this.primeRoom();
    };

    ws.onmessage = (event) => {
      if (this.closed || this.revoked || this.ws !== ws) return;
      if (typeof event.data === 'string') {
        try {
          const control = JSON.parse(event.data) as { type?: string };
          if (control.type === 'host-online') {
            this.events.onState('online');
            this.direct.peerOnline(true);
            this.flushDirectRestart();
            this.primeRoom();
          } else if (control.type === 'host-offline') {
            this.events.onState('host-offline');
            this.direct.peerOnline(false);
            this.roomPrimed = false;
            this.dropVoice();
          } else if (control.type === 'revoked') {
            // 桌面端解除了配对：立即停手，别再重连
            this.revoke();
          }
        } catch {}
        return;
      }
      this.enqueueFrame(new Uint8Array(event.data as ArrayBuffer), ws);
    };

    ws.onclose = (event) => closed(event.code);

    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  /** 回前台只探活；网络恢复拆半开链，死链立即重连 */
  nudge(reason: NudgeReason = 'visibility'): void {
    if (this.closed || this.revoked) return;
    // 已经在连：别把刚发起的握手掐掉再开第二条
    if (this.ws?.readyState === 0) {
      if (reason === 'online' || reason === 'network-change') this.pendingDirectRestart = true;
      return;
    }
    const hiddenMs = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
    this.hiddenAt = null;
    const stale =
      (reason === 'visibility' || reason === 'resume') && isForegroundSocketStale(hiddenMs);
    const replace =
      stale || shouldReplaceOnNudge(reason, this.ws !== null, this.ws?.readyState ?? null);
    // 直连信令必须走活着的中继。先拆 socket 再发 offer 会把这一轮丢进 15s 超时。
    if (reason === 'online' || reason === 'network-change' || stale) {
      if (replace) this.pendingDirectRestart = true;
      else this.direct.networkChange();
    }
    if (replace) {
      this.replaceRelay();
      return;
    }
    this.heartbeat?.probe(
      reason === 'visibility' || reason === 'resume' ? VISIBILITY_PROBE_MS : undefined
    );
  }

  private flushDirectRestart(): void {
    if (!this.pendingDirectRestart) return;
    this.pendingDirectRestart = false;
    this.direct.networkChange();
  }

  /** 退后台瞬间记下时刻，回前台判断是否该直接换链 */
  conceal(): void {
    this.hiddenAt ??= Date.now();
  }

  close(): void {
    this.flushCache();
    this.closed = true;
    this.pendingDirectRestart = false;
    this.stopSyncRetry();
    if (this.timer) clearTimeout(this.timer);
    this.direct.close();
    this.heartbeat?.stop();
    this.heartbeat = null;
    try {
      this.ws?.close();
    } catch {}
    this.dropVoice();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.revoked) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), backoffDelay(this.attempt++));
  }

  /** 拆掉旧链并立刻重连，不走 onclose 后再退避 */
  private replaceRelay(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    const old = this.ws;
    if (old) {
      this.heartbeat?.stop();
      this.heartbeat = null;
      this.ws = null;
      this.roomPrimed = false;
      try {
        old.close();
      } catch {}
    }
    this.connect();
  }

  private enqueueFrame(frame: Uint8Array, socket?: WebSocket): void {
    this.receiveQueue = this.receiveQueue
      .then(async () => {
        if (this.closed || this.revoked || (socket && socket !== this.ws)) return;
        await this.handleFrame(frame, socket);
      })
      .catch(() => {});
  }

  private async handleFrame(frame: Uint8Array, socket?: WebSocket): Promise<void> {
    let payload: HostToPhone;
    try {
      payload = (await openFrame(this.contentKey, frame)) as HostToPhone;
    } catch {
      return;
    }
    if (this.closed || this.revoked || (socket && socket !== this.ws)) return;
    switch (payload.type) {
      case 'catalog': {
        // 幽灵会话判定要在 onCatalog 前：上层可能据 ghost 立即切走
        const { tracking, ghost } = applyCatalog(
          this.sync,
          this.subscribedId,
          payload.entries.map((e) => e.id)
        );
        const ghostId = ghost ? this.subscribedId : null;
        const ids = new Set(payload.entries.map((entry) => entry.id));
        for (const id of this.sync.knownIds) {
          if (ids.has(id)) continue;
          this.sessions.delete(id);
          this.baselines.delete(id);
          this.cursors.delete(id);
        }
        this.setSync(tracking);
        if (ghostId) this.subscribe(null);
        if (ghostId) this.events.onGhostSession?.(ghostId);
        this.metadata.catalog = payload.entries;
        this.metadata.pinnedOrder = payload.pinnedOrder ?? [];
        this.events.onCatalog(payload.entries, payload.pinnedOrder);
        this.scheduleCache();
        break;
      }
      case 'projects':
        this.metadata.projects = payload.projects;
        this.metadata.projectGroups = payload.groups ?? [];
        this.events.onProjects(payload.projects, payload.groups);
        this.scheduleCache();
        break;
      case 'providers':
        this.metadata.providers = payload.providers;
        this.events.onProviders(payload.providers);
        this.scheduleCache();
        break;
      case 'appearance':
        // 先写调色板再算主题：sync-terminal 要用它推导整套 UI 变量
        setTerminalAppearance(payload.terminal, payload.terminalFontFamily);
        setHostTheme(payload.theme);
        setCompactReadOnlyTools(payload.compactReadOnlyTools !== false);
        setExpandLiveEdits(payload.expandLiveEdits !== false);
        setTimelinePrefs(normalizeTimelinePrefs(payload));
        break;
      case 'agent-event':
        this.acceptAgentEvent(payload.event as Record<string, unknown>, payload.cursor);
        break;
      case 'session-sync': {
        const response = parsePairSessionSync(payload);
        if (response) this.applySessionSync(response);
        else console.warn('[pair] dropped invalid session-sync');
        break;
      }
      case 'push-config':
        this.events.onPushConfig?.(payload.vapidPublicKey);
        break;
      case 'host-info':
        this.direct.hostInfo(payload);
        this.setVoiceInput(payload.voiceInput === true);
        this.events.onReadOnly?.(payload.readOnly === true);
        break;
      case 'voice-result': {
        const { error } = payload;
        this.voices.get(payload.requestId)?.settle(
          error === undefined
            ? { ok: true, text: typeof payload.text === 'string' ? payload.text : '' }
            : {
                ok: false,
                error: SPEECH_ERRORS.includes(error) ? (error as SpeechErrorCode) : 'failed',
              }
        );
        break;
      }
      case 'voice-partial':
        this.voices.get(payload.requestId)?.onPartial(payload.text, payload.correcting === true);
        break;
      case 'direct-answer':
      case 'direct-ice':
        this.direct.handleSignal(payload);
        break;
      case 'probe-ack':
        if (payload.nonce === this.probeNonce && this.probeSentAt !== null) {
          this.direct.noteRelayRtt(Date.now() - this.probeSentAt);
          this.probeSentAt = null;
        }
        break;
      case 'history': {
        // 上滑分页应答：只并入消息，不动 status/审批（那些以尾窗快照为准）
        if (!this.historyPending.has(payload.sessionId)) break;
        this.historyPending.delete(payload.sessionId);
        this.events.onHistoryPending?.(payload.sessionId, false);
        const view = this.sessions.get(payload.sessionId);
        if (!view) break;
        const next = applyGuestHistory(view, payload);
        if (next === view) break;
        this.sessions.set(payload.sessionId, next);
        this.events.onSession(payload.sessionId, { ...next, messages: new Map(next.messages) });
        this.scheduleCache();
        break;
      }
      case 'bot-catalog':
        if (Array.isArray(payload.bots)) {
          this.events.onBotCatalog?.(payload.enabled === true, payload.bots);
        }
        break;
      case 'bot-chats':
        if (Array.isArray(payload.chats)) this.events.onBotChats?.(payload.chats);
        break;
      case 'group-timeline':
        if (typeof payload.chatId === 'string' && Array.isArray(payload.entries)) {
          this.events.onGroupTimeline?.(payload);
        }
        break;
      case 'bot-event':
        if (typeof payload.event === 'object' && payload.event !== null) {
          this.events.onBotEvent?.(payload.event);
        }
        break;
      case 'bot-chat-state':
        if (typeof payload.chatId === 'string') this.events.onBotChatState?.(payload);
        break;
      case 'bot-send-result':
        if (typeof payload.deliveryId === 'string') this.events.onBotSendResult?.(payload);
        break;
      case 'bot-retry-result':
        if (typeof payload.chatId === 'string' && typeof payload.entryId === 'string')
          this.events.onBotRetryResult?.(payload);
        break;
      case 'bot-inbox':
        if (Array.isArray(payload.items)) this.events.onBotInbox?.(payload.items);
        break;
      case 'bot-activity':
        if (Array.isArray(payload.items) && typeof payload.now === 'number')
          this.events.onBotActivity?.(payload.items, Date.now() - payload.now);
        break;
      case 'bot-artifacts':
        if (typeof payload.target === 'object' && payload.target !== null)
          this.events.onBotArtifacts?.(payload);
        break;
      case 'bot-artifact-image':
        if (typeof payload.requestId === 'string') this.events.onBotArtifactImage?.(payload);
        break;
      case 'command-rejected':
        if (typeof payload.command === 'string')
          this.events.onCommandRejected?.(payload.command, payload.error);
        break;
      default:
        // 新桌面新增的帧：旧逻辑不认识就忽略，不能影响后续帧
        break;
    }
  }

  private applySessionSync(response: PairSessionSync): void {
    if (
      this.pendingSync?.requestId !== response.requestId ||
      this.pendingSync.sessionId !== response.sessionId
    )
      return;
    const id = response.sessionId;
    this.stopSyncRetry();
    let view = this.sessions.get(id);
    if (response.mode === 'snapshot') {
      // epoch 变化可能是重启、回退或快照替换，旧前缀不能再视为同一段历史。
      const sessions =
        this.cursors.get(id)?.epoch === response.cursor.epoch
          ? this.sessions
          : new Map<string, SessionView>();
      view = applyGuestSnapshot(sessions, response.snapshot as { sessions?: unknown[] })[0]?.view;
      if (view) view = this.keepCachedMessages(id, view);
    } else {
      const current = this.cursors.get(id);
      if (!view || current?.epoch !== response.cursor.epoch || current.seq !== response.fromSeq) {
        this.cursors.delete(id);
        this.subscribe(id);
        return;
      }
      for (const value of response.events) {
        const event = value as Record<string, unknown>;
        if (this.truncatesBeforeCache(view, event)) {
          this.cursors.delete(id);
          this.subscribe(id);
          return;
        }
        view = applyGuestEvent(view, event).view;
      }
    }
    if (!view) return;
    this.sessions.set(id, view);
    this.baselines.add(id);
    this.cursors.set(id, response.cursor);
    const observed = this.pendingSync.observed;
    this.pendingSync = null;
    // 中继与直连切换可乱序：提前到达但不在本次应答内的事件，再从已落地游标补齐。
    if (
      observed &&
      (observed === 'mixed' ||
        observed.epoch !== response.cursor.epoch ||
        observed.seq > response.cursor.seq)
    )
      this.subscribe(id);
    else this.setSync({ ...this.sync, state: 'synced' });
    this.events.onSession(id, { ...view, messages: new Map(view.messages) });
    this.scheduleCache();
  }

  private acceptAgentEvent(event: Record<string, unknown>, cursor?: PairSyncCursor): void {
    const id = typeof event.sessionId === 'string' ? event.sessionId : undefined;
    if (cursor !== undefined) {
      if (!id || !isPairSyncCursor(cursor)) return;
      if (this.pendingSync?.sessionId === id) {
        const observed = this.pendingSync.observed;
        this.pendingSync.observed = !observed
          ? cursor
          : observed === 'mixed' || observed.epoch !== cursor.epoch
            ? 'mixed'
            : { epoch: cursor.epoch, seq: Math.max(observed.seq, cursor.seq) };
        return;
      }
      const current = this.cursors.get(id);
      if (current?.epoch === cursor.epoch && cursor.seq <= current.seq) return;
      if (!current || cursor.epoch !== current.epoch || cursor.seq !== current.seq + 1) {
        if (id === this.subscribedId) {
          if (this.freshSessionId === id) this.freshSessionId = null;
          this.subscribe(id);
        } else this.cursors.delete(id);
        return;
      }
      const view = this.sessions.get(id);
      if (view && this.truncatesBeforeCache(view, event)) {
        this.cursors.delete(id);
        if (id === this.subscribedId) this.subscribe(id);
        return;
      }
      this.applyAgentEvent(event);
      this.cursors.set(id, cursor);
    } else {
      // 旧 host 没有事件版本；内容仍可缓存展示，但不能携旧 epoch 请求增量。
      if (id) this.cursors.delete(id);
      this.applyAgentEvent(event);
    }
    this.scheduleCache();
  }

  private truncatesBeforeCache(view: SessionView, event: Record<string, unknown>): boolean {
    return (
      event.type === 'messages-truncated' &&
      typeof event.length === 'number' &&
      event.length > 0 &&
      (view.messages.size === 0 || Math.min(...view.messages.keys()) >= event.length)
    );
  }

  /** resume 空尾窗尚未就绪：保留本地正文，避免时间线被打成「正在读取历史」。 */
  private keepCachedMessages(id: string, view: SessionView): SessionView {
    if (view.messages.size > 0) return view;
    const local = this.sessions.get(id);
    if (!local || local.messages.size === 0) return view;
    return { ...view, messages: new Map(local.messages) };
  }

  /** 把 agent 事件投影进本地会话视图（纯函数在 @shared/pair/guestProjection） */
  private applyAgentEvent(event: Record<string, unknown>): void {
    const sessionId = event.sessionId as string | undefined;
    const type = event.type as string;

    if (type === 'worker-exited') {
      this.cursors.clear();
      this.sessions = markAllFailed(this.sessions);
      for (const [id, view] of this.sessions) {
        this.events.onSession(id, { ...view, messages: new Map(view.messages) });
      }
      return;
    }
    if (type === 'snapshot') {
      // 与投影同规则：扁平 sessionId 优先，identity 兑底防旧桌面版
      const snapshotIds = (
        (event.sessions ?? []) as { sessionId?: string; identity?: { sessionId?: string } }[]
      )
        .map((s) => s.sessionId ?? s.identity?.sessionId)
        .filter((id): id is string => typeof id === 'string');
      this.setSync(applySnapshot(this.sync, this.subscribedId, snapshotIds));
      for (const { id, view } of applyGuestSnapshot(
        this.sessions,
        event as { sessions?: unknown[] }
      )) {
        const next = this.keepCachedMessages(id, view);
        this.cursors.delete(id);
        this.baselines.add(id);
        if (id === this.pendingSync?.sessionId) {
          this.pendingSync = null;
          this.stopSyncRetry();
        }
        this.sessions.set(id, next);
        this.events.onSession(id, { ...next, messages: new Map(next.messages) });
      }
      return;
    }
    if (!sessionId) return;
    const { view } = applyGuestEvent(this.sessions.get(sessionId) ?? emptyGuestView(), event);
    this.sessions.set(sessionId, view);
    this.events.onSession(sessionId, { ...view, messages: new Map(view.messages) });
  }

  getSession(sessionId: string): SessionView | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 边录边传 16kHz 单声道 PCM，满一块立即发，首字不多等。
   * finish 时恰好没有余量就补 10ms 静音作 last 块（空块会被判为坏音频）。
   */
  startVoice(onPartial: (text: string, correcting: boolean) => void): VoiceSession {
    const requestId = crypto.randomUUID();
    const maxSamples = SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS;
    let buffer = new Float32Array(VOICE_CHUNK_SAMPLES);
    let filled = 0;
    let index = 0;
    let total = 0;
    let overflow = false;
    let finishing: Promise<SpeechTranscribeResult> | null = null;
    let outcome: SpeechTranscribeResult | null = null;
    let resolveFinish: ((result: SpeechTranscribeResult) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: SpeechTranscribeResult): void => {
      if (outcome) return;
      outcome = result;
      clearTimeout(timer);
      this.voices.delete(requestId);
      resolveFinish?.(result);
    };
    const emit = (samples: Float32Array, last: boolean): void => {
      // 漏发一块桌面就永远凑不齐：发不出去立即判失败
      if (!this.canSend()) {
        settle({ ok: false, error: 'failed' });
        return;
      }
      const [data] = encodeVoiceChunks(samples, samples.length);
      this.send({
        type: 'voice-chunk',
        requestId,
        index: index++,
        data,
        ...(last ? { last: true as const } : {}),
      });
    };
    const abandon = (result: SpeechTranscribeResult): void => {
      if (index > 0 && !outcome) this.send({ type: 'voice-cancel', requestId });
      settle(result);
    };
    this.voices.set(requestId, { onPartial, settle });
    return {
      push: (samples) => {
        if (outcome || finishing || overflow) return;
        if (total + samples.length > maxSamples) {
          overflow = true;
          return;
        }
        total += samples.length;
        let offset = 0;
        while (offset < samples.length && !outcome) {
          const n = Math.min(samples.length - offset, VOICE_CHUNK_SAMPLES - filled);
          buffer.set(samples.subarray(offset, offset + n), filled);
          filled += n;
          offset += n;
          if (filled < VOICE_CHUNK_SAMPLES) continue;
          emit(buffer, false);
          buffer = new Float32Array(VOICE_CHUNK_SAMPLES);
          filled = 0;
        }
      },
      finish: () => {
        if (finishing) return finishing;
        finishing = outcome
          ? Promise.resolve(outcome)
          : new Promise<SpeechTranscribeResult>((resolve) => {
              resolveFinish = resolve;
            });
        if (outcome) return finishing;
        if (overflow) abandon({ ok: false, error: 'invalid-audio' });
        else if (total === 0) settle({ ok: false, error: 'invalid-audio' });
        else {
          emit(
            filled > 0 ? buffer.subarray(0, filled) : new Float32Array(SPEECH_SAMPLE_RATE / 100),
            true
          );
          if (!outcome) {
            timer = setTimeout(() => settle({ ok: false, error: 'failed' }), VOICE_TIMEOUT_MS);
          }
        }
        return finishing;
      },
      cancel: () => abandon({ ok: false, error: 'failed' }),
    };
  }

  private setVoiceInput(available: boolean): void {
    if (this.voiceInput === available) return;
    this.voiceInput = available;
    this.events.onVoiceInput?.(available);
  }

  /** 断线后 host 侧缓冲随连接清掉，结果不会再来：在途请求立即失败 */
  private dropVoice(): void {
    this.setVoiceInput(false);
    for (const voice of [...this.voices.values()]) voice.settle({ ok: false, error: 'failed' });
  }

  private canSend(): boolean {
    return (
      !this.closed &&
      !this.revoked &&
      (this.direct.transport() === 'direct' || this.ws?.readyState === 1)
    );
  }

  send(command: PhoneToHost): void {
    if (!this.canSend()) return;
    this.sendQueue = this.sendQueue
      .then(async () => {
        if (this.closed || this.revoked) return;
        const frame = await sealFrame(this.contentKey, command);
        if (this.closed || this.revoked) return;
        // 直连优先；背压/刚好断掉时无缝退回中继
        if (this.direct.send(frame)) return;
        this.sendFrameViaRelay(frame);
      })
      .catch(() => {});
  }

  private sendFrameViaRelay(frame: Uint8Array): void {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(frame.slice().buffer as ArrayBuffer);
  }

  private sendRelayProbe(): void {
    this.probeNonce = (this.probeNonce + 1) >>> 0;
    this.probeSentAt = Date.now();
    this.sendViaRelay({ type: 'probe', nonce: this.probeNonce });
  }

  private sendViaRelay(command: PhoneToHost): void {
    this.sendQueue = this.sendQueue
      .then(async () => {
        if (this.closed || this.revoked) return;
        const frame = await sealFrame(this.contentKey, command);
        if (!this.closed && !this.revoked) this.sendFrameViaRelay(frame);
      })
      .catch(() => {});
  }

  private setSync(next: SyncTracking): void {
    const changed = next.state !== this.sync.state;
    this.sync = next;
    if (changed) this.events.onSync?.(next.state);
  }

  /** onopen 与紧随其后的 host-online 只进房一次；host 掉线后再上线才重拉。 */
  private primeRoom(): void {
    if (this.closed || this.revoked || this.roomPrimed) return;
    if (this.ws?.readyState !== 1) return;
    this.roomPrimed = true;
    this.send({ type: 'snapshot' });
    if (this.subscribedId) this.subscribe(this.subscribedId);
  }

  /** 订阅会话：带上本地游标，只补断线期间的增量。fresh = 手机刚 spawn 的全新会话，不进 syncing */
  subscribe(sessionId: string | null, opts?: { fresh?: boolean }): void {
    if (this.closed || this.revoked) return;
    this.stopSyncRetry();
    this.subscribedId = sessionId;
    if (opts?.fresh) this.freshSessionId = sessionId;
    else if (sessionId !== this.freshSessionId || (sessionId && this.baselines.has(sessionId)))
      this.freshSessionId = null;
    // 缓存未上墙前不要进 syncing：否则时间线会先盖「正在读取历史」。
    if (!this.cacheReady) return;
    // spawn 在途可能根本没有快照；拿到首次基线之前沿用旧实时订阅，不能门控首轮事件。
    const fresh = sessionId !== null && sessionId === this.freshSessionId;
    this.pendingSync = sessionId && !fresh ? { sessionId, requestId: crypto.randomUUID() } : null;
    if (this.historyPending.size > 0) {
      const pending = [...this.historyPending];
      this.historyPending.clear();
      for (const id of pending) this.events.onHistoryPending?.(id, false);
    }
    this.setSync(applySubscribe(this.sync, sessionId, { fresh }));
    if (!sessionId) {
      this.send({ type: 'subscribe', sessionId: null });
      return;
    }
    const view = this.sessions.get(sessionId);
    const sinceIndex =
      this.baselines.has(sessionId) && view
        ? view.messages.size
          ? Math.max(...view.messages.keys())
          : -1
        : undefined;
    // 最近打开的会话排末尾，后台事件不改变缓存 LRU 次序。
    if (view) {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, view);
    }
    const command: Extract<PhoneToHost, { type: 'subscribe' }> = {
      type: 'subscribe',
      sessionId,
      ...(this.pendingSync
        ? {
            sync: { requestId: this.pendingSync.requestId, cursor: this.cursors.get(sessionId) },
          }
        : typeof sinceIndex === 'number'
          ? { sinceIndex }
          : {}),
    };
    this.send(command);
    if (this.pendingSync) this.armSyncRetry(command, this.pendingSync.requestId);
  }

  private armSyncRetry(command: PhoneToHost, requestId: string): void {
    this.syncTimer = setTimeout(() => {
      if (this.closed || this.revoked || this.pendingSync?.requestId !== requestId) return;
      // 重试沿用 requestId：慢快照仍可兑现，不被不断换号的重试饿死。
      this.send(command);
      this.armSyncRetry(command, requestId);
    }, 10_000);
  }

  private stopSyncRetry(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  private scheduleCache(): void {
    if (this.closed || this.revoked) return;
    this.cacheDirty = true;
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => this.flushCache(), 500);
  }

  /** 页面隐藏前尽早提交事务；缓存失败不阻塞网络或输入。 */
  flushCache(): void {
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    if (!this.cacheReady || !this.cacheDirty || this.closed || this.revoked) return;
    this.cacheDirty = false;
    const sessions = [...this.sessions]
      .filter(([id]) => this.baselines.has(id))
      .map(([id, view]) => ({
        id,
        view,
        cursor: this.cursors.get(id),
      }));
    void this.cache.save(this.device.pairId, { ...this.metadata, sessions }).catch(() => {});
  }

  private revoke(): void {
    this.revoked = true;
    this.pendingDirectRestart = false;
    this.stopSyncRetry();
    if (this.timer) clearTimeout(this.timer);
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    this.direct.close();
    this.heartbeat?.stop();
    this.sessions.clear();
    this.cursors.clear();
    this.baselines.clear();
    void this.cache.clear(this.device.pairId).catch(() => {});
    this.dropVoice();
    this.events.onState('unauthorized');
  }

  /** 是否还有更早的历史可拉（已加载区间起点 > 0） */
  hasOlder(sessionId: string): boolean {
    const view = this.sessions.get(sessionId);
    if (!view || view.messages.size === 0) return false;
    return Math.min(...view.messages.keys()) > 0;
  }

  /** 上滑加载上一页；无更早内容或已在途时静默忽略 */
  requestHistory(sessionId: string): void {
    if (
      this.pendingSync ||
      this.subscribedId !== sessionId ||
      this.historyPending.has(sessionId) ||
      !this.hasOlder(sessionId)
    ) {
      return;
    }
    const view = this.sessions.get(sessionId);
    if (!view) return;
    this.historyPending.add(sessionId);
    this.events.onHistoryPending?.(sessionId, true);
    this.send({ type: 'history', sessionId, beforeIndex: Math.min(...view.messages.keys()) });
  }
}

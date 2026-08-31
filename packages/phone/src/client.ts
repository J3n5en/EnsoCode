import {
  attachHeartbeat,
  backoffDelay,
  type CatalogEntry,
  fromBase64Url,
  type Heartbeat,
  type HostToPhone,
  openFrame,
  type PairedDevice,
  type PhoneToHost,
  type ProjectEntry,
  type ProviderEntry,
  sealFrame,
  toWebSocketUrl,
} from '@enso/pair';
import type {
  ApprovalRequestInfo,
  AskRequestInfo,
  BackgroundTaskInfo,
  ProjectedMessage,
  SessionSnapshot,
  SubagentInfo,
} from '@shared/types/agent';
import { loadCursors, saveCursor } from './storage';
import { setTerminalAppearance } from './stubs/settings-store';
import {
  applyCatalog,
  applySnapshot,
  applySubscribe,
  initialSync,
  type SyncState,
  type SyncTracking,
} from './syncProjection';
import { applyRetryEvent, applyTaskEvent, type RetryInfo } from './taskProjection';
import { setHostTheme } from './theme';

/**
 * 与中继的长连接：自动重连（指数退避 + 抖动）、加解密、
 * 重连后按游标增量续传（游标失配则回落全量 snapshot）。
 */

export type ConnState = 'connecting' | 'online' | 'host-offline' | 'unauthorized' | 'offline';

export interface SessionView {
  /** key = 消息 index，与桌面同为按 index 幂等写入 */
  messages: Map<number, ProjectedMessage>;
  status: string;
  approvals: ApprovalRequestInfo[];
  asks: AskRequestInfo[];
  /** 后台任务 / subagent 状态（TaskBar 胶囊用，与桌面同源事件投影） */
  tasks: BackgroundTaskInfo[];
  subagents: SubagentInfo[];
  /** 自动重试中（非终态）：与桌面 SessionProjection.retry 同规则 */
  retry?: RetryInfo;
}

export interface ClientEvents {
  onState(state: ConnState): void;
  onCatalog(entries: CatalogEntry[], pinnedOrder?: string[]): void;
  onProjects(projects: ProjectEntry[]): void;
  onProviders(providers: ProviderEntry[]): void;
  onSession(sessionId: string, view: SessionView): void;
  /** 桌面下发 VAPID 公钥：有它才能 pushManager.subscribe */
  onPushConfig?(vapidPublicKey: string): void;
  /** 订阅会话的同步状态：subscribe 发出 → snapshot 回包之间为 syncing */
  onSync?(state: SyncState): void;
  /** 订阅的会话已被桌面删除（曾在目录、现在消失）：上层应跳离该会话 */
  onGhostSession?(sessionId: string): void;
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

  constructor(
    private device: PairedDevice,
    private events: ClientEvents
  ) {
    this.contentKey = fromBase64Url(device.contentKey);
  }

  connect(): void {
    if (this.closed) return;
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

    // 半开死链的 close 事件可能永不到达：心跳判死后直接走关闭路径，幂等防双跑
    let settled = false;
    const closed = (code: number | null): void => {
      if (settled) return;
      settled = true;
      this.heartbeat?.stop();
      this.heartbeat = null;
      this.ws = null;
      // 1008 = 中继明确告知凭据已失效（解绑时下发，或带失效凭据重连时下发）
      if (code === 1008 || this.revoked) {
        this.revoked = true;
        this.events.onState('unauthorized');
        return;
      }
      this.events.onState('offline');
      this.scheduleReconnect();
    };
    this.heartbeat = attachHeartbeat(ws, () => {
      try {
        ws.close();
      } catch {}
      closed(null);
    });

    ws.onopen = () => {
      this.attempt = 0;
      // 进房后立即要目录；有订阅则带游标续传
      this.send({ type: 'snapshot' });
      if (this.subscribedId) this.subscribe(this.subscribedId);
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const control = JSON.parse(event.data) as { type?: string };
          if (control.type === 'host-online') {
            this.events.onState('online');
            this.send({ type: 'snapshot' });
            if (this.subscribedId) this.subscribe(this.subscribedId);
          } else if (control.type === 'host-offline') {
            this.events.onState('host-offline');
          } else if (control.type === 'revoked') {
            // 桌面端解除了配对：立即停手，别再重连
            this.revoked = true;
            this.events.onState('unauthorized');
          }
        } catch {}
        return;
      }
      void this.handleFrame(new Uint8Array(event.data as ArrayBuffer));
    };

    ws.onclose = (event) => closed(event.code);

    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  /** 回前台/网络恢复时调用：死链立即重连（跳过退避），活链立即探测 */
  nudge(): void {
    if (this.closed || this.revoked) return;
    if (this.ws) {
      this.heartbeat?.probe();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.heartbeat?.stop();
    this.heartbeat = null;
    try {
      this.ws?.close();
    } catch {}
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), backoffDelay(this.attempt++));
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    let payload: HostToPhone;
    try {
      payload = (await openFrame(this.contentKey, frame)) as HostToPhone;
    } catch {
      return;
    }
    switch (payload.type) {
      case 'catalog': {
        // 幽灵会话判定要在 onCatalog 前：上层可能据 ghost 立即切走
        const { tracking, ghost } = applyCatalog(
          this.sync,
          this.subscribedId,
          payload.entries.map((e) => e.id)
        );
        const ghostId = ghost ? this.subscribedId : null;
        this.setSync(tracking);
        if (ghostId) this.events.onGhostSession?.(ghostId);
        this.events.onCatalog(payload.entries, payload.pinnedOrder);
        break;
      }
      case 'projects':
        this.events.onProjects(payload.projects);
        break;
      case 'providers':
        this.events.onProviders(payload.providers);
        break;
      case 'appearance':
        // 先写调色板再算主题：sync-terminal 要用它推导整套 UI 变量
        setTerminalAppearance(payload.terminal, payload.terminalFontFamily);
        setHostTheme(payload.theme);
        break;
      case 'agent-event':
        this.applyAgentEvent(payload.event as Record<string, unknown>);
        break;
      case 'push-config':
        this.events.onPushConfig?.(payload.vapidPublicKey);
        break;
      case 'history': {
        // 上滑分页应答：只并入消息，不动 status/审批（那些以尾窗快照为准）
        this.historyPending.delete(payload.sessionId);
        const view = this.sessions.get(payload.sessionId);
        if (!view || payload.messages.length === 0) break;
        const messages = new Map(view.messages);
        for (const [i, message] of payload.messages.entries()) {
          messages.set(payload.baseIndex + i, message as ProjectedMessage);
        }
        const next = { ...view, messages };
        this.sessions.set(payload.sessionId, next);
        this.events.onSession(payload.sessionId, { ...next, messages: new Map(messages) });
        break;
      }
    }
  }

  /** 把 agent 事件投影进本地会话视图（与桌面同为 index 幂等写入） */
  private applyAgentEvent(event: Record<string, unknown>): void {
    const sessionId = event.sessionId as string | undefined;
    const type = event.type as string;

    if (type === 'worker-exited') {
      for (const [id, view] of this.sessions) {
        view.status = 'failed';
        this.events.onSession(id, { ...view, messages: new Map(view.messages) });
      }
      return;
    }
    // 尾窗快照：批事件，按 baseIndex 偏移合并进已有投影。
    // 不能整张 Map 替换——用户可能已上滑加载了更早的分页，替换会把它们抹掉。
    if (type === 'snapshot') {
      // 与下方合并逻辑同规则：扁平 sessionId 优先，identity 兑底防旧桌面版
      const snapshotIds = (
        (event.sessions ?? []) as { sessionId?: string; identity?: { sessionId?: string } }[]
      )
        .map((s) => s.sessionId ?? s.identity?.sessionId)
        .filter((id): id is string => typeof id === 'string');
      this.setSync(applySnapshot(this.sync, this.subscribedId, snapshotIds));
      for (const snap of (event.sessions ?? []) as (SessionSnapshot & {
        sessionId?: string;
        identity?: { sessionId?: string };
      })[]) {
        // host 归一化后有扁平 sessionId；identity 兜底防旧桌面版
        const id = snap.sessionId ?? snap.identity?.sessionId;
        if (!id) continue;
        const base = snap.baseIndex ?? 0;
        const existing = this.sessions.get(id)?.messages;
        const prevMax = existing?.size ? Math.max(...existing.keys()) : -1;
        // 离线太久、尾窗与已有内容接不上：丢弃旧段保持时间线连续，上滑可重新拉回
        const messages =
          existing && base <= prevMax + 1 ? new Map(existing) : new Map<number, ProjectedMessage>();
        for (const [i, message] of (snap.messages ?? []).entries()) {
          messages.set(base + i, message);
          saveCursor(this.device.pairId, id, base + i);
        }
        const view: SessionView = {
          messages,
          status: snap.status ?? 'idle',
          approvals: snap.pendingApprovals ?? [],
          asks: snap.pendingAsks ?? [],
          tasks: snap.backgroundTasks ?? [],
          subagents: snap.subagents ?? [],
        };
        this.sessions.set(id, view);
        this.events.onSession(id, { ...view, messages: new Map(messages) });
      }
      return;
    }
    if (!sessionId) return;
    const view = this.sessions.get(sessionId) ?? {
      messages: new Map<number, ProjectedMessage>(),
      status: 'idle',
      approvals: [],
      asks: [],
      tasks: [],
      subagents: [],
    };

    // 自动重试横幅：turn-retry 设置，status/turn-* 清除（与桌面 reducer 同规则）
    view.retry = applyRetryEvent(view.retry, event);

    // 后台任务 / subagent 事件：纯函数投影，命中则直接推视图
    const taskNext = applyTaskEvent({ tasks: view.tasks, subagents: view.subagents }, event);
    if (taskNext) {
      const next = { ...view, ...taskNext };
      this.sessions.set(sessionId, next);
      this.events.onSession(sessionId, { ...next, messages: new Map(next.messages) });
      return;
    }

    switch (type) {
      case 'message-upsert': {
        const index = event.index as number;
        view.messages.set(index, event.message as ProjectedMessage);
        saveCursor(this.device.pairId, sessionId, index);
        break;
      }
      case 'status':
        view.status = event.status as string;
        break;
      case 'turn-completed':
        view.status = 'idle';
        break;
      case 'turn-failed':
        view.status = 'failed';
        break;
      case 'approval-request': {
        // worker 新格式载荷嵌在 request 里；旧格式平铺在事件上，两者都兼容
        const approval = (event.request ?? event) as unknown as ApprovalRequestInfo;
        view.approvals = [...view.approvals, approval];
        break;
      }
      case 'approval-resolved':
        view.approvals = view.approvals.filter((a) => a.requestId !== event.requestId);
        break;
      case 'ask-request': {
        const ask = (event.ask ?? event) as unknown as AskRequestInfo;
        view.asks = [...view.asks, ask];
        break;
      }
      case 'ask-resolved':
        view.asks = view.asks.filter((a) => a.requestId !== event.requestId);
        break;
    }
    this.sessions.set(sessionId, view);
    this.events.onSession(sessionId, { ...view, messages: new Map(view.messages) });
  }

  getSession(sessionId: string): SessionView | undefined {
    return this.sessions.get(sessionId);
  }

  send(command: PhoneToHost): void {
    if (this.ws?.readyState !== 1) return;
    void sealFrame(this.contentKey, command).then((frame) => {
      this.ws?.send(frame.slice().buffer as ArrayBuffer);
    });
  }

  private setSync(next: SyncTracking): void {
    const changed = next.state !== this.sync.state;
    this.sync = next;
    if (changed) this.events.onSync?.(next.state);
  }

  /** 订阅会话：带上本地游标，只补断线期间的增量。fresh = 手机刚 spawn 的全新会话，不进 syncing */
  subscribe(sessionId: string | null, opts?: { fresh?: boolean }): void {
    this.subscribedId = sessionId;
    this.historyPending.clear();
    this.setSync(applySubscribe(this.sync, sessionId, opts));
    if (!sessionId) {
      this.send({ type: 'subscribe', sessionId: null });
      return;
    }
    const sinceIndex = loadCursors(this.device.pairId)[sessionId];
    this.send({
      type: 'subscribe',
      sessionId,
      ...(typeof sinceIndex === 'number' ? { sinceIndex } : {}),
    });
  }

  /** 是否还有更早的历史可拉（已加载区间起点 > 0） */
  hasOlder(sessionId: string): boolean {
    const view = this.sessions.get(sessionId);
    if (!view || view.messages.size === 0) return false;
    return Math.min(...view.messages.keys()) > 0;
  }

  /** 上滑加载上一页；无更早内容或已在途时静默忽略 */
  requestHistory(sessionId: string): void {
    if (this.historyPending.has(sessionId) || !this.hasOlder(sessionId)) return;
    const view = this.sessions.get(sessionId);
    if (!view) return;
    this.historyPending.add(sessionId);
    this.send({ type: 'history', sessionId, beforeIndex: Math.min(...view.messages.keys()) });
  }
}

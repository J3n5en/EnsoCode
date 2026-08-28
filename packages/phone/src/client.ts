import {
  backoffDelay,
  type CatalogEntry,
  fromBase64Url,
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
  ProjectedMessage,
  SessionSnapshot,
} from '@shared/types/agent';
import { loadCursors, saveCursor } from './storage';
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
}

export interface ClientEvents {
  onState(state: ConnState): void;
  onCatalog(entries: CatalogEntry[]): void;
  onProjects(projects: ProjectEntry[]): void;
  onProviders(providers: ProviderEntry[]): void;
  onSession(sessionId: string, view: SessionView): void;
}

export class PairClient {
  private ws: WebSocket | null = null;
  private contentKey: Uint8Array;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private subscribedId: string | null = null;
  private sessions = new Map<string, SessionView>();

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
          }
        } catch {}
        return;
      }
      void this.handleFrame(new Uint8Array(event.data as ArrayBuffer));
    };

    ws.onclose = (event) => {
      this.ws = null;
      // 1008/1006 + 401 场景：凭据已解绑
      if (event.code === 1008) {
        this.events.onState('unauthorized');
        return;
      }
      this.events.onState('offline');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
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
      case 'catalog':
        this.events.onCatalog(payload.entries);
        break;
      case 'projects':
        this.events.onProjects(payload.projects);
        break;
      case 'providers':
        this.events.onProviders(payload.providers);
        break;
      case 'appearance':
        setHostTheme(payload.theme);
        break;
      case 'agent-event':
        this.applyAgentEvent(payload.event as Record<string, unknown>);
        break;
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
    // 全量快照：批事件，直接铺开会话投影（进会话时补历史消息）
    if (type === 'snapshot') {
      for (const snap of (event.sessions ?? []) as SessionSnapshot[]) {
        const id = snap.sessionId;
        if (!id) continue;
        const messages = new Map<number, ProjectedMessage>();
        for (const [index, message] of (snap.messages ?? []).entries()) {
          messages.set(index, message);
          saveCursor(id, index);
        }
        const view: SessionView = {
          messages,
          status: snap.status ?? 'idle',
          approvals: snap.pendingApprovals ?? [],
          asks: snap.pendingAsks ?? [],
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
    };

    switch (type) {
      case 'message-upsert': {
        const index = event.index as number;
        view.messages.set(index, event.message as ProjectedMessage);
        saveCursor(sessionId, index);
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
      case 'approval-request':
        view.approvals = [...view.approvals, event as unknown as ApprovalRequestInfo];
        break;
      case 'approval-resolved':
        view.approvals = view.approvals.filter((a) => a.requestId !== event.requestId);
        break;
      case 'ask-request':
        view.asks = [...view.asks, event as unknown as AskRequestInfo];
        break;
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

  /** 订阅会话：带上本地游标，只补断线期间的增量 */
  subscribe(sessionId: string | null): void {
    this.subscribedId = sessionId;
    if (!sessionId) {
      this.send({ type: 'subscribe', sessionId: null });
      return;
    }
    const sinceIndex = loadCursors()[sessionId];
    this.send({
      type: 'subscribe',
      sessionId,
      ...(typeof sinceIndex === 'number' ? { sinceIndex } : {}),
    });
  }
}

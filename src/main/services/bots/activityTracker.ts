import { type LiveActivity, liveActivity } from '@shared/bots/liveActivity';
import type { ProjectedMessage, RendererAgentEvent } from '@shared/types/agent';

interface Tracked {
  runStartedAt: number;
  retry?: true;
  toolStartedAt: Record<string, number>;
  /** 只留本轮（最后一条 user 起）的消息，按绝对 index */
  messages: Map<number, ProjectedMessage>;
}

/** 由 agent 事件流维护 Bot 会话的本轮运行态（给手机下发，不存整段历史） */
export class BotActivityTracker {
  private readonly sessions = new Map<string, Tracked>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly accept: (sessionId: string) => boolean = () => true
  ) {}

  apply(event: RendererAgentEvent): void {
    if (event.type === 'snapshot') {
      for (const session of event.sessions) {
        const id = session.identity.sessionId;
        if (!this.accept(id)) continue;
        if (session.status !== 'running') {
          this.sessions.delete(id);
          continue;
        }
        const tracked = this.ensure(id);
        const base = session.baseIndex ?? 0;
        tracked.messages.clear();
        session.messages.forEach((message, offset) => {
          this.upsert(tracked, base + offset, message);
        });
      }
      return;
    }
    if (event.type === 'worker-exited') {
      this.sessions.clear();
      return;
    }
    if (!('identity' in event) || !event.identity) return;
    const id = event.identity.sessionId;
    if (!this.accept(id)) return;
    switch (event.type) {
      case 'status':
        if (event.status !== 'running') this.sessions.delete(id);
        else delete this.ensure(id).retry;
        return;
      case 'turn-completed':
      case 'turn-failed':
        this.sessions.delete(id);
        return;
      case 'turn-retry': {
        const tracked = this.sessions.get(id);
        if (tracked) tracked.retry = true;
        return;
      }
      case 'message-upsert': {
        // 只跟进已在跑的会话：轮次结束后的迟到消息不复活
        const tracked = this.sessions.get(id);
        if (tracked) this.upsert(tracked, event.index, event.message);
        return;
      }
      case 'tool-output': {
        const tracked = this.sessions.get(id);
        if (tracked && event.startedAt !== undefined)
          tracked.toolStartedAt[event.toolCallId] ??= event.startedAt;
        return;
      }
    }
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  list(): Array<{ conversationId: string; activity: LiveActivity }> {
    return [...this.sessions].flatMap(([conversationId, tracked]) => {
      const activity = liveActivity(
        {
          status: 'running',
          runStartedAt: tracked.runStartedAt,
          retry: tracked.retry,
          toolStartedAt: tracked.toolStartedAt,
          messages: [...tracked.messages].sort(([a], [b]) => a - b).map(([, message]) => message),
        },
        false
      );
      return activity ? [{ conversationId, activity }] : [];
    });
  }

  private ensure(id: string): Tracked {
    let tracked = this.sessions.get(id);
    if (!tracked) {
      tracked = { runStartedAt: this.now(), toolStartedAt: {}, messages: new Map() };
      this.sessions.set(id, tracked);
    }
    return tracked;
  }

  private upsert(tracked: Tracked, index: number, message: ProjectedMessage): void {
    if (message.role === 'user')
      for (const key of tracked.messages.keys()) if (key < index) tracked.messages.delete(key);
    tracked.messages.set(index, message);
  }
}

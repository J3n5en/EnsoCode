import { HUMAN_REQUEST_TIMEOUT_MS } from '@shared/humanRequestTimeout';
import type { AgentWorkerEvent, SessionIdentity } from '@shared/types/agent';

type Kind = 'approval' | 'ask';

interface Entry {
  identity: SessionIdentity;
  kind: Kind;
  requestId: string;
  deadline: number;
}

/**
 * 审批卡 / 提问卡的等人时限：Main 用墙钟判定到期（休眠醒来已过期的直接到期，不重新计时），
 * 只追踪 worker 标了 expiresAt 的请求；截止时间不晚于 Main 首次看到它后 10 分钟。
 */
export class HumanRequestTimeouts {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly deps: {
      now(): number;
      expire(identity: SessionIdentity, kind: Kind, requestId: string): void;
    }
  ) {}

  observe(event: AgentWorkerEvent | { type: 'worker-exited' }): void {
    switch (event.type) {
      case 'approval-request':
        if (event.request.phase !== 'reviewing')
          this.track(event.identity, 'approval', event.request.requestId, event.request.expiresAt);
        return;
      case 'ask-request':
        this.track(event.identity, 'ask', event.ask.requestId, event.ask.expiresAt);
        return;
      case 'approval-resolved':
        this.entries.delete(keyOf(event.identity, 'approval', event.requestId));
        return;
      case 'ask-resolved':
        this.entries.delete(keyOf(event.identity, 'ask', event.requestId));
        return;
      case 'worker-exited':
        this.entries.clear();
        return;
    }
  }

  check(): void {
    const now = this.deps.now();
    for (const [key, entry] of [...this.entries]) {
      if (entry.deadline > now) continue;
      this.entries.delete(key);
      try {
        this.deps.expire(entry.identity, entry.kind, entry.requestId);
      } catch {
        // 会话已不在：卡片随会话一起消失
      }
    }
  }

  private track(
    identity: SessionIdentity,
    kind: Kind,
    requestId: string,
    expiresAt: number | undefined
  ): void {
    const key = keyOf(identity, kind, requestId);
    if (expiresAt === undefined || this.entries.has(key)) return;
    const deadline = Math.min(expiresAt, this.deps.now() + HUMAN_REQUEST_TIMEOUT_MS);
    this.entries.set(key, { identity, kind, requestId, deadline });
  }
}

const keyOf = (identity: SessionIdentity, kind: Kind, requestId: string) =>
  `${identity.sessionId}\n${kind}\n${requestId}`;

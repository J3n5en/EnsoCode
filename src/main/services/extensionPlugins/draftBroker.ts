import { randomUUID } from 'node:crypto';
import type { ComposerOp, SessionUiOp } from './gate';
import { pluginError } from './process';

export interface DraftSink {
  id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

interface Pending {
  origin: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Main → 发起窗口的草稿请求；回包必须来自同一窗口，否则忽略 */
export class DraftBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly deps: {
      channel: string;
      find(id: number): DraftSink | null;
      timeoutMs?: number;
    }
  ) {}

  request(
    origin: number | null,
    sessionId: string,
    op: ComposerOp | SessionUiOp,
    payload: Record<string, unknown>,
    timeoutMs = this.deps.timeoutMs ?? 5000
  ): Promise<unknown> {
    const sink = origin === null ? null : this.deps.find(origin);
    if (origin === null || !sink || sink.isDestroyed())
      return Promise.reject(pluginError('NO_COMPOSER', '发起调用的窗口不可用'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(pluginError('TIMEOUT', '输入框没有响应'));
      }, timeoutMs);
      this.pending.set(requestId, { origin, resolve, reject, timer });
      sink.send(this.deps.channel, { requestId, sessionId, op, payload });
    });
  }

  respond(senderId: number, raw: unknown): void {
    if (!isRecord(raw) || typeof raw.requestId !== 'string') return;
    const entry = this.pending.get(raw.requestId);
    if (!entry || entry.origin !== senderId) return;
    this.pending.delete(raw.requestId);
    clearTimeout(entry.timer);
    if (raw.ok === true) entry.resolve(raw.value ?? null);
    else
      entry.reject(
        pluginError(
          typeof raw.code === 'string' ? raw.code.slice(0, 64) : 'DRAFT_FAILED',
          typeof raw.error === 'string' ? raw.error.slice(0, 500) : '草稿操作失败'
        )
      );
  }
}

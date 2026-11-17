import type { SecretaryContactPollState } from '@shared/types/secretary';
import {
  type TelegramApi,
  TelegramApiError,
  type TelegramFailureKind,
  type TelegramUpdate,
} from './client';

/** 出错后按这个节奏退避：网络断了不刷屏，恢复后自己接上 */
export const POLL_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
export const POLL_LONG_TIMEOUT_SEC = 25;

export interface ContactPollerPorts {
  /** 每次轮询现取：token 换了、解绑了都立即生效 */
  api(): TelegramApi | null;
  offset(): number;
  setOffset(offset: number): void;
  /** 一条更新处理完才轮询下一批；抛错只记日志，不打断轮询 */
  onUpdate(update: TelegramUpdate): Promise<void>;
  onStatus(state: SecretaryContactPollState, error?: string): void;
  onError(error: unknown): void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

function kindOf(error: unknown): TelegramFailureKind {
  return error instanceof TelegramApiError ? error.kind : 'api';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 长轮询：单实例、可停可重启，offset 由调用方落盘 */
export class ContactPoller {
  private loop: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private runId = 0;
  private state: SecretaryContactPollState = 'stopped';
  private lastError: string | undefined;
  private failKind: TelegramFailureKind | null = null;
  /** 每次请求成功加一：请求发出时记下，失败时它已变过，说明之后连上过，这次失败不再算数 */
  private okSeq = 0;

  constructor(private readonly ports: ContactPollerPorts) {}

  status(): { state: SecretaryContactPollState; lastError?: string } {
    return { state: this.state, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  /**
   * 轮询以外的请求（发消息、改按钮…）也是连通性信号：连不上就挂 backoff，
   * 成功就撤掉连不上的 backoff。轮询没在跑时不动状态，否则没人来撤。
   */
  async track<T>(request: () => Promise<T>): Promise<T> {
    const since = this.okSeq;
    try {
      const result = await request();
      this.okSeq += 1;
      if (this.loop && this.state === 'backoff' && this.failKind === 'network') {
        this.setStatus('running');
      }
      return result;
    } catch (error) {
      if (
        this.loop &&
        since === this.okSeq &&
        kindOf(error) === 'network' &&
        (this.state === 'running' || this.state === 'starting')
      ) {
        this.setStatus('backoff', messageOf(error), 'network');
      }
      throw error;
    }
  }

  start(): void {
    if (this.loop) return;
    const runId = ++this.runId;
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus('starting');
    this.loop = this.run(runId, controller.signal).finally(() => {
      if (this.runId === runId) this.loop = null;
    });
  }

  async stop(): Promise<void> {
    this.runId += 1;
    this.controller?.abort();
    this.controller = null;
    const loop = this.loop;
    this.loop = null;
    await loop;
    this.setStatus('stopped');
  }

  private async run(runId: number, signal: AbortSignal): Promise<void> {
    let backoff = 0;
    while (this.runId === runId && !signal.aborted) {
      const api = this.ports.api();
      if (!api) break;
      const since = this.okSeq;
      let updates: TelegramUpdate[];
      try {
        updates = await api.getUpdates({
          offset: this.ports.offset() || undefined,
          // 刚失败过先短轮询：连上了立刻知道，不用等长轮询挂满才撤提示
          timeout: backoff > 0 ? 0 : POLL_LONG_TIMEOUT_SEC,
          signal,
        });
        backoff = 0;
        this.okSeq += 1;
        if (this.state !== 'running') this.setStatus('running');
      } catch (error) {
        if (this.runId !== runId || signal.aborted) break;
        this.ports.onError(error);
        const kind = kindOf(error);
        const message = messageOf(error);
        // token 被吊销/写错：轮询没有意义，停下来等用户改
        if (kind === 'unauthorized') {
          this.setStatus('error', message);
          return;
        }
        // 发出之后别的请求成功过：这次失败是旧消息，不盖掉成功；照样退避重试
        if (since === this.okSeq) this.setStatus('backoff', message, kind);
        await this.ports.sleep(
          POLL_BACKOFF_MS[Math.min(backoff, POLL_BACKOFF_MS.length - 1)],
          signal
        );
        backoff += 1;
        continue;
      }

      for (const update of updates) {
        if (this.runId !== runId) return;
        // 先落 offset 再处理：宁可漏一条，也不重放已经产生过副作用的更新
        this.ports.setOffset(update.update_id + 1);
        try {
          await this.ports.onUpdate(update);
        } catch (error) {
          this.ports.onError(error);
        }
      }
    }
  }

  private setStatus(
    state: SecretaryContactPollState,
    error?: string,
    kind: TelegramFailureKind | null = null
  ): void {
    this.state = state;
    this.lastError = error;
    this.failKind = kind;
    this.ports.onStatus(state, error);
  }
}

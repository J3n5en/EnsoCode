import type { SecretaryContactPollState } from '@shared/types/secretary';
import { type TelegramApi, TelegramApiError, type TelegramUpdate } from './client';

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

/** 长轮询：单实例、可停可重启，offset 由调用方落盘 */
export class ContactPoller {
  private loop: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private runId = 0;
  private state: SecretaryContactPollState = 'stopped';
  private lastError: string | undefined;

  constructor(private readonly ports: ContactPollerPorts) {}

  status(): { state: SecretaryContactPollState; lastError?: string } {
    return { state: this.state, ...(this.lastError ? { lastError: this.lastError } : {}) };
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
      let updates: TelegramUpdate[];
      try {
        updates = await api.getUpdates({
          offset: this.ports.offset() || undefined,
          timeout: POLL_LONG_TIMEOUT_SEC,
          signal,
        });
        backoff = 0;
        if (this.state !== 'running') this.setStatus('running');
      } catch (error) {
        if (this.runId !== runId || signal.aborted) break;
        this.ports.onError(error);
        const kind = error instanceof TelegramApiError ? error.kind : 'api';
        const message = error instanceof Error ? error.message : String(error);
        // token 被吊销/写错：轮询没有意义，停下来等用户改
        if (kind === 'unauthorized') {
          this.setStatus('error', message);
          return;
        }
        this.setStatus('backoff', message);
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

  private setStatus(state: SecretaryContactPollState, error?: string): void {
    this.state = state;
    this.lastError = error;
    this.ports.onStatus(state, error);
  }
}

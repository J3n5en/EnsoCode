/**
 * 记忆服务子进程（utilityProcess）的 Main 侧客户端。
 *
 * 背景：memory.db 的同步 SQLite 调用（实体 instr 全扫、KNN、社区扩展、
 * 开库迁移与 VACUUM）以及 GGUF embedding/chat 的同步加载，曾在 Main 主线程执行，
 * 一次 memory_search 能把事件循环卡到秒级。全部搬到一个 utilityProcess 后，
 * Main 只转发 op 并代发远程 LLM 补全。
 *
 * 崩溃 / 超时：op 超时或进程退出即丢弃该代，在途 op 全部拒绝；
 * 下一个 op 重新 fork（后台 LLM 任务有持久化 job 表，重启续跑）。
 * 退出：shutdown() 先让服务 graceful 关库关模型，超时 SIGKILL，配合退出看门狗。
 */

import { memoryWorkerPath, utilityProcess } from '@platform';
import type { Complete, CompleteOptions } from './memory/distill';

export interface MemoryServiceTransport {
  readonly pid?: number;
  postMessage(message: unknown): void;
  kill(): void;
  once(event: 'spawn' | 'exit', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
}

/** 服务探测远程补全是否可用；返回 null 时任务保留 pending 等下次机会 */
export type MemoryServiceLlmResolver = () => Promise<Complete | null>;

export interface MemoryServiceClientOptions {
  fork?: () => MemoryServiceTransport;
  memoryRoot: () => string;
  sessionDir: () => string;
  /** op 超时；超时杀进程、拒绝全部在途 op，下个 op 自动重起 */
  opTimeoutMs?: number;
  /** 'changed' 通知防抖（批量写入合并） */
  onChanged?: () => void;
  /** embedding/chat 模型下载进度转发给渲染层 */
  onDownloadProgress?: (progress: unknown) => void;
  /** 远程补全入口（ipc/agent 注入 distillCompletion 链） */
  llmResolver?: MemoryServiceLlmResolver;
  /** 会话转录代读：服务蒸馏要读 jsonl，走 Main 侧 SessionManager */
  transcriptReader?: (sessionFile: string) => Promise<unknown>;
  log?: (message: string) => void;
}

const DEFAULT_OP_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;
const CHANGE_DEBOUNCE_MS = 150;

interface PendingOp {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingLlm {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

export class MemoryServiceClient {
  private child: MemoryServiceTransport | null = null;
  private ready = false;
  private spawnWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private pendingOps = new Map<number, PendingOp>();
  private pendingLlm = new Map<number, PendingLlm>();
  private seq = 0;
  private configMessage: Record<string, unknown> = {};
  private changeTimer: NodeJS.Timeout | null = null;
  private llmControllers = new Map<number, AbortController>();

  constructor(private readonly opts: MemoryServiceClientOptions) {}

  private log(message: string): void {
    try {
      this.opts.log?.(`[memory-service] ${message}`);
    } catch {}
  }

  private defaultFork(): MemoryServiceTransport {
    const child = utilityProcess.fork(memoryWorkerPath, [], {
      serviceName: 'enso-memory-service',
      stdio: 'pipe',
      env: {
        ...process.env,
        ENSO_MEMORY_ROOT: this.opts.memoryRoot(),
        ENSO_MEMORY_SESSION_DIR: this.opts.sessionDir(),
        // llama GPU 后端下载目录由服务进程自己推导（utilityProcess 里没有 app）
        ENSO_LLAMA_GPU_ROOT: `${this.opts.memoryRoot()}/../llama-gpu-backends`,
      },
    });
    return child as unknown as MemoryServiceTransport;
  }

  /** 确保服务在跑：没在跑就 fork（首个 op 懒启动，不给应用启动加负担） */
  private ensureStarted(): void {
    if (this.child) return;
    const child = (this.opts.fork ?? (() => this.defaultFork()))();
    this.child = child;
    this.ready = false;
    child.once('spawn', () => {
      this.log(`spawned pid=${child.pid ?? '?'}`);
    });
    child.once('exit', () => {
      this.onExit();
    });
    child.on('message', (raw) => this.onMessage(raw));
  }

  private onExit(): void {
    const wasReady = this.ready;
    this.child = null;
    this.ready = false;
    const error = new Error(
      `memory service exited${wasReady ? '' : ' before ready'}; in-flight ops rejected`
    );
    this.log(error.message);
    for (const [, pending] of this.pendingOps) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingOps.clear();
    for (const [, llm] of this.pendingLlm) llm.reject(error);
    this.pendingLlm.clear();
    this.llmControllers.clear();
    for (const waiter of this.spawnWaiters.splice(0)) waiter.reject(error);
  }

  private onMessage(raw: unknown): void {
    const message = raw as Record<string, unknown> | null;
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.pushConfig();
        for (const waiter of this.spawnWaiters.splice(0)) waiter.resolve();
        return;
      case 'op-result': {
        const pending = this.pendingOps.get(message.requestId as number);
        if (!pending) return;
        this.pendingOps.delete(message.requestId as number);
        clearTimeout(pending.timer);
        if (message.error !== undefined) pending.reject(new Error(String(message.error)));
        else pending.resolve(message.result);
        return;
      }
      case 'changed':
        this.notifyChanged();
        return;
      case 'download-progress':
        this.opts.onDownloadProgress?.(message.progress);
        return;
      case 'transcript-request':
        void (async () => {
          let messages: unknown = [];
          try {
            messages = (await this.opts.transcriptReader?.(String(message.sessionFile))) ?? [];
          } catch {}
          try {
            this.child?.postMessage({
              type: 'transcript-result',
              requestId: message.requestId,
              messages,
            });
          } catch {}
        })();
        return;
      case 'llm-request':
        void this.handleLlmRequest(message);
        return;
      case 'llm-cancel':
        this.llmControllers.get(message.requestId as number)?.abort();
        return;
    }
  }

  private notifyChanged(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      try {
        this.opts.onChanged?.();
      } catch {}
    }, CHANGE_DEBOUNCE_MS);
    this.changeTimer.unref?.();
  }

  /** 服务的远程补全：probe 由 resolver 判断，执行走同一个 Complete */
  private async handleLlmRequest(message: Record<string, unknown>): Promise<void> {
    const requestId = message.requestId as number;
    const reply = (type: 'llm-result' | 'llm-error', payload: Record<string, unknown>) => {
      try {
        this.child?.postMessage({ type, requestId, ...payload });
      } catch {}
    };
    try {
      const resolver = this.opts.llmResolver;
      const complete = resolver ? await resolver() : null;
      if (!complete) {
        reply('llm-error', { error: 'no completion available' });
        return;
      }
      const controller = new AbortController();
      this.llmControllers.set(requestId, controller);
      const options: CompleteOptions = {
        signal: controller.signal,
        ...(typeof message.maxTokens === 'number' ? { maxTokens: message.maxTokens } : {}),
        ...(message.stage === 'extract' || message.stage === 'consolidate'
          ? { stage: message.stage }
          : {}),
      };
      const text = await complete(
        String(message.system ?? ''),
        String(message.user ?? ''),
        options
      );
      reply('llm-result', { text });
    } catch (error) {
      reply('llm-error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.llmControllers.delete(requestId);
    }
  }

  /** 配置快照推给服务（幂等覆盖）；服务未启动只缓存 */
  configure(config: Record<string, unknown>): void {
    this.configMessage = { ...this.configMessage, ...config };
    if (this.child && this.ready) this.pushConfig();
  }

  private pushConfig(): void {
    if (!this.child || !this.ready) return;
    const entries = Object.entries(this.configMessage);
    if (entries.length === 0) return;
    for (const [key, value] of entries) {
      this.sendFireAndForget({
        type: 'op',
        requestId: ++this.seq,
        op: 'config',
        args: { key, value },
      });
    }
  }

  private sendFireAndForget(message: unknown): void {
    try {
      this.child?.postMessage(message);
    } catch {}
  }

  /** 一次 op RPC：服务懒起，等待 ready 后再投递；超时从调用时起算，起不来也不会无限挂起 */
  async invoke<T = unknown>(op: string, args?: unknown): Promise<T> {
    this.ensureStarted();
    const requestId = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOps.delete(requestId);
        reject(new Error(`memory op '${op}' timed out after ${this.timeoutMs()}ms`));
        this.killChild(`op '${op}' timed out`);
      }, this.timeoutMs());
      timer.unref?.();
      this.pendingOps.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      const post = () => {
        if (!this.pendingOps.has(requestId)) return;
        try {
          this.child?.postMessage({ type: 'op', requestId, op, args });
        } catch (error) {
          this.pendingOps.delete(requestId);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      // 退出前未 ready 的情况由 onExit 统一拒绝 pendingOps
      if (this.ready) post();
      else this.spawnWaiters.push({ resolve: post, reject: () => {} });
    });
  }

  protected timeoutMs(): number {
    return this.opts.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
  }

  private killChild(reason: string): void {
    const child = this.child;
    if (!child) return;
    this.log(`kill: ${reason}`);
    try {
      child.kill();
    } catch {}
    // 'exit' 事件负责清理；若事件丢失（极端平台差异），兜底清一次
    setTimeout(() => {
      if (this.child === child) this.onExit();
    }, 2_000).unref?.();
  }

  /** 服务进程活着（含尚未 ready 的 fork 窗口） */
  alive(): boolean {
    return this.child !== null;
  }

  /** 优雅停：让服务先关库与模型，超时 SIGKILL；不在跑立即返回 */
  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await Promise.race([
        this.invoke('shutdown').catch(() => {}),
        new Promise<void>((resolve) => {
          const exit = () => resolve();
          child.once('exit', exit);
          setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref?.();
        }),
      ]);
    } finally {
      if (this.child) {
        try {
          this.child.kill();
        } catch {}
      }
    }
  }
}

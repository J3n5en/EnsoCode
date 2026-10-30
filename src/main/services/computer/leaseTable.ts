import { ComputerError } from '@shared/computer/errors';

interface Held {
  owner: string;
  released: Promise<void>;
  release: () => void;
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.name.startsWith('Computer')
    ? reason
    : new Error('Computer action aborted');
}

/**
 * 桌面租约：key 为 `app:<pid>`（后台目标）或 `fg`（真实键鼠只有一套）。
 * 同 key 串行、不同 key 并行；owner 是一次 run，run 结束统一释放。
 */
export class LeaseTable {
  private readonly held = new Map<string, Held>();
  /** owner → 正在等待的 key，用于检测环形等待 */
  private readonly waiting = new Map<string, string>();
  private readonly waitMs: number;

  constructor(options: { waitMs?: number } = {}) {
    this.waitMs = options.waitMs ?? 20_000;
  }

  holder(key: string): string | undefined {
    return this.held.get(key)?.owner;
  }

  async acquire(
    owner: string,
    keys: readonly string[],
    signal: AbortSignal,
    labels: Record<string, string> = {}
  ): Promise<void> {
    const fresh: string[] = [];
    try {
      // 固定顺序申请，减少两个多 key 申请互相卡住
      for (const key of [...new Set(keys)].sort()) {
        if (this.held.get(key)?.owner === owner) continue;
        await this.acquireOne(owner, key, signal, labels[key] ?? key);
        fresh.push(key);
      }
    } catch (error) {
      for (const key of fresh) this.releaseKey(key, owner);
      throw error;
    }
  }

  private deadlocked(owner: string, key: string): boolean {
    const seen = new Set<string>();
    let current = this.held.get(key)?.owner;
    while (current && !seen.has(current)) {
      if (current === owner) return true;
      seen.add(current);
      const next = this.waiting.get(current);
      current = next ? this.held.get(next)?.owner : undefined;
    }
    return false;
  }

  private async acquireOne(
    owner: string,
    key: string,
    signal: AbortSignal,
    label: string
  ): Promise<void> {
    const deadline = Date.now() + this.waitMs;
    while (true) {
      if (signal.aborted) throw abortError(signal);
      const current = this.held.get(key);
      if (!current) break;
      if (this.deadlocked(owner, key)) {
        throw new ComputerError(
          'lease-deadlock',
          `Another session is using ${label} and waiting for an app this run holds; retry this step after the other session finishes.`
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ComputerError(
          'lease-busy',
          `Another session is using ${label} right now. Wait for it to finish, then try again.`
        );
      }
      this.waiting.set(owner, key);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([
          current.released,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
          new Promise<void>((resolve) => {
            onAbort = () => resolve();
            signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      } finally {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
        this.waiting.delete(owner);
      }
    }
    const { promise: released, resolve } = Promise.withResolvers<void>();
    this.held.set(key, { owner, released, release: resolve });
  }

  private releaseKey(key: string, owner: string): void {
    const entry = this.held.get(key);
    if (!entry || entry.owner !== owner) return;
    this.held.delete(key);
    entry.release();
  }

  releaseOwner(owner: string): void {
    for (const [key, entry] of [...this.held]) {
      if (entry.owner === owner) this.releaseKey(key, owner);
    }
    this.waiting.delete(owner);
  }
}

import { closeSync, openSync, readSync, renameSync, statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginLogLevel } from './process';

export const MAX_LOG_BYTES = 1024 * 1024;
export const DEFAULT_LOG_TAIL_BYTES = 64 * 1024;
export const LOG_RATE_PER_SECOND = 100;
const RATE_WINDOW_MS = 1000;

interface Bucket {
  windowStart: number;
  count: number;
  dropped: number;
}

interface Pending {
  lines: string[];
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
}

export class PluginLogger {
  private readonly buckets = new Map<string, Bucket>();
  private readonly pending = new Map<string, Pending>();
  private readonly generation = new Map<string, number>();

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now
  ) {}

  append(id: string, level: PluginLogLevel, message: string): void {
    const at = this.now();
    let bucket = this.buckets.get(id);
    if (!bucket || at - bucket.windowStart >= RATE_WINDOW_MS) {
      if (bucket && bucket.dropped > 0) {
        this.enqueue(id, this.line(at, 'warn', `已丢弃 ${bucket.dropped} 行`));
        bucket.dropped = 0;
      }
      bucket = { windowStart: at, count: 0, dropped: 0 };
      this.buckets.set(id, bucket);
    }
    if (bucket.count >= LOG_RATE_PER_SECOND) {
      bucket.dropped += 1;
      this.ensure(id);
      this.schedule(id);
      return;
    }
    bucket.count += 1;
    this.enqueue(id, this.line(at, level, message));
  }

  async read(id: string, maxBytes = DEFAULT_LOG_TAIL_BYTES): Promise<string> {
    await this.flush(id);
    return readTail(this.path(id), maxBytes);
  }

  discard(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pending.delete(id);
    this.buckets.delete(id);
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    return pending?.chain ?? Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.all([...this.pending.keys()].map((id) => this.flush(id))).then(() => undefined);
  }

  private line(at: number, level: PluginLogLevel, message: string): string {
    return `${new Date(at).toISOString()} [${level}] ${message}\n`;
  }

  private path(id: string): string {
    return join(this.root, 'logs', `${id}.log`);
  }

  private ensure(id: string): Pending {
    let pending = this.pending.get(id);
    if (!pending) {
      pending = { lines: [], timer: null, chain: Promise.resolve() };
      this.pending.set(id, pending);
    }
    return pending;
  }

  private enqueue(id: string, line: string): void {
    this.ensure(id).lines.push(line);
    this.schedule(id);
  }

  private schedule(id: string): void {
    const pending = this.ensure(id);
    if (pending.timer) return;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      void this.flush(id);
    }, 0);
    pending.timer.unref?.();
  }

  private flush(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending?.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const lines = pending?.lines.splice(0) ?? [];
    const bucket = this.buckets.get(id);
    if (bucket && bucket.dropped > 0) {
      lines.push(this.line(this.now(), 'warn', `已丢弃 ${bucket.dropped} 行`));
      bucket.dropped = 0;
    }
    const prev = pending?.chain ?? Promise.resolve();
    const gen = this.generation.get(id) ?? 0;
    const next =
      lines.length === 0
        ? prev
        : prev.then(
            () => this.write(id, lines, gen),
            () => this.write(id, lines, gen)
          );
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    if (pending) pending.chain = settled;
    return settled;
  }

  private async write(id: string, lines: string[], gen: number): Promise<void> {
    if (lines.length === 0 || (this.generation.get(id) ?? 0) !== gen) return;
    const path = this.path(id);
    try {
      await mkdir(join(this.root, 'logs'), { recursive: true });
      try {
        if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
      } catch {
        // 还没有日志文件
      }
      if ((this.generation.get(id) ?? 0) !== gen) return;
      await appendFile(path, lines.join(''), { mode: 0o600 });
    } catch {
      // 日志写失败不影响插件调用
    }
  }
}

function readTail(path: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

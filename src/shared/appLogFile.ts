import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { type AppLogLevel, type AppLogSource, formatAppLogLine, inferLogSource } from './appLog';

export const APP_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const APP_LOG_KEEP = 3;

/** 单写者的滚动日志：main.log 超过上限依次挪成 main.1.log … main.<keep>.log，最老的丢弃。写失败静默 */
export class RotatingLogFile {
  private size: number | null = null;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(
    readonly file: string,
    options: { maxBytes?: number; keep?: number } = {}
  ) {
    this.maxBytes = options.maxBytes ?? APP_LOG_MAX_BYTES;
    this.keep = options.keep ?? APP_LOG_KEEP;
  }

  append(text: string): void {
    try {
      if (this.size === null) {
        mkdirSync(path.dirname(this.file), { recursive: true });
        try {
          this.size = statSync(this.file).size;
        } catch {
          this.size = 0;
        }
      }
      const bytes = Buffer.byteLength(text);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.file, text, { encoding: 'utf8', mode: 0o600 });
      this.size += bytes;
    } catch {
      this.size = null;
    }
  }

  private rotated(index: number): string {
    const ext = path.extname(this.file);
    return `${this.file.slice(0, this.file.length - ext.length)}.${index}${ext}`;
  }

  private rotate(): void {
    rmSync(this.rotated(this.keep), { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      try {
        renameSync(this.rotated(i), this.rotated(i + 1));
      } catch {
        // 这一份还不存在
      }
    }
    if (this.keep > 0) renameSync(this.file, this.rotated(1));
    else rmSync(this.file, { force: true });
    this.size = 0;
  }
}

const CONSOLE_LEVELS: [keyof Console & ('log' | 'info' | 'warn' | 'error'), AppLogLevel][] = [
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
];

/**
 * 把 console 输出同时写进结构化滚动日志（原输出照旧）。打包版 Main 与 worker 的 stdout 没人看，
 * 这是它们唯一的落盘渠道。返回卸载函数。
 */
export function installConsoleLog(
  file: string,
  source: AppLogSource,
  options: { console?: Console; maxBytes?: number; keep?: number } = {}
): () => void {
  const target = options.console ?? console;
  const log = new RotatingLogFile(file, options);
  const originals = CONSOLE_LEVELS.map(([method]) => [method, target[method]] as const);
  let writing = false;
  for (const [method, level] of CONSOLE_LEVELS) {
    const original = target[method];
    target[method] = (...args: unknown[]) => {
      original.apply(target, args);
      if (writing) return;
      writing = true;
      try {
        const text = format(...args);
        log.append(
          formatAppLogLine({ time: Date.now(), level, source: inferLogSource(text, source), text })
        );
      } catch {
        // 日志失败不能影响调用方
      } finally {
        writing = false;
      }
    };
  }
  return () => {
    for (const [method, original] of originals) target[method] = original;
  };
}

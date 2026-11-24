import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AGENT_WORKER_ABORT_LOG, AGENT_WORKER_CRASH_FILE } from '@shared/agentWorkerExit';
import { setAppLoggingEnabled } from '@shared/appLogFile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCrashRecord, isAbortLike } from './crashRecord';

let dir: string;
beforeEach(() => {
  setAppLoggingEnabled(true);
  dir = mkdtempSync(path.join(tmpdir(), 'crash-record-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** Node 内部的 AbortError（fs 流 addAbortSignal、timers/promises 等同一类）：name=AbortError、code=ABORT_ERR */
async function abortError(): Promise<Error> {
  return sleep(1, undefined, { signal: AbortSignal.abort() }).then(
    () => {
      throw new Error('expected abort');
    },
    (error: Error) => error
  );
}

/** 按 Node 的顺序投递一次致命异常：先 monitor，再 uncaughtException 监听 */
function crash(target: EventEmitter, error: unknown, origin = 'uncaughtException'): void {
  target.emit('uncaughtExceptionMonitor', error, origin);
  target.emit('uncaughtException', error, origin);
}

describe('isAbortLike', () => {
  it('识别 Node 与 AbortSignal 产生的取消 / 超时', async () => {
    expect(isAbortLike(await abortError())).toBe(true);
    expect(isAbortLike(AbortSignal.abort().reason)).toBe(true);
    expect(isAbortLike(new DOMException('This operation was aborted', 'AbortError'))).toBe(true);
    expect(isAbortLike(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(true);
  });

  it('其余错误与非 Error 值不算取消', () => {
    expect(isAbortLike(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isAbortLike(new Error('Operation aborted by tool'))).toBe(false);
    expect(isAbortLike('The operation was aborted')).toBe(false);
    expect(isAbortLike(undefined)).toBe(false);
    expect(isAbortLike(null)).toBe(false);
  });

  it('只是名字或文案像取消的自定义错误不算，照旧让 worker 退出', () => {
    class TimeoutError extends Error {
      override name = 'TimeoutError';
    }
    expect(isAbortLike(new TimeoutError('pool exhausted'))).toBe(false);
    expect(isAbortLike(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
    expect(isAbortLike(Object.assign(new Error('x'), { code: 'ABORT_ERR' }))).toBe(false);
    expect(isAbortLike(new Error('The operation was aborted'))).toBe(false);
    expect(isAbortLike(new Error('This operation was aborted'))).toBe(false);
  });
});

describe('installCrashRecord', () => {
  it('取消类异常：不退出、不写 crash record，记入 aborts 日志', async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    installCrashRecord(dir, { target, exit });
    crash(target, await abortError());
    crash(target, await abortError(), 'unhandledRejection');
    expect(exit).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, AGENT_WORKER_CRASH_FILE))).toBe(false);
    const log = readFileSync(path.join(dir, AGENT_WORKER_ABORT_LOG), 'utf8');
    expect(log).toContain('origin=uncaughtException');
    expect(log).toContain('origin=unhandledRejection');
    expect(log).toContain('AbortError: The operation was aborted');
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('非取消类异常：照旧落 crash record 并以 1 退出', () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    installCrashRecord(dir, { target, exit });
    crash(target, new TypeError('boom'), 'unhandledRejection');
    expect(exit).toHaveBeenCalledWith(1);
    const record = JSON.parse(readFileSync(path.join(dir, AGENT_WORKER_CRASH_FILE), 'utf8'));
    expect(record).toMatchObject({
      pid: process.pid,
      origin: 'unhandledRejection',
      message: 'TypeError: boom',
    });
    expect(existsSync(path.join(dir, AGENT_WORKER_ABORT_LOG))).toBe(false);
  });

  it('非取消类异常写到 stderr 的内容和 Node 默认一样带上 code 与 cause', () => {
    const target = new EventEmitter();
    installCrashRecord(dir, { target, exit: vi.fn() });
    const error = Object.assign(new Error('outer', { cause: new Error('inner reason') }), {
      code: 'E_OUTER',
    });
    crash(target, error);
    const written = vi
      .mocked(process.stderr.write)
      .mock.calls.map(([chunk]) => String(chunk))
      .join('');
    expect(written).toContain('origin=uncaughtException');
    expect(written).toContain("code: 'E_OUTER'");
    expect(written).toContain('inner reason');
  });

  it('应用日志关闭时取消类异常不写 aborts 日志，进程照样不退出', async () => {
    setAppLoggingEnabled(false);
    const target = new EventEmitter();
    const exit = vi.fn();
    installCrashRecord(dir, { target, exit });
    crash(target, await abortError());
    expect(exit).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, AGENT_WORKER_ABORT_LOG))).toBe(false);
  });
});

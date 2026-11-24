import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

function abortError(): Error {
  // 与 fs 流 addAbortSignal 抛出的同形：name=AbortError、code=ABORT_ERR
  return Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

/** 按 Node 的顺序投递一次致命异常：先 monitor，再 uncaughtException 监听 */
function crash(target: EventEmitter, error: unknown, origin = 'uncaughtException'): void {
  target.emit('uncaughtExceptionMonitor', error, origin);
  target.emit('uncaughtException', error, origin);
}

describe('isAbortLike', () => {
  it('识别取消类异常', () => {
    expect(isAbortLike(abortError())).toBe(true);
    expect(isAbortLike(new DOMException('This operation was aborted', 'AbortError'))).toBe(true);
    expect(isAbortLike(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(true);
    expect(isAbortLike(Object.assign(new Error('x'), { code: 'ABORT_ERR' }))).toBe(true);
    expect(isAbortLike(new Error('This operation was aborted'))).toBe(true);
  });

  it('其余错误与非 Error 值不算取消', () => {
    expect(isAbortLike(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isAbortLike(new Error('Operation aborted by tool'))).toBe(false);
    expect(isAbortLike('The operation was aborted')).toBe(false);
    expect(isAbortLike(undefined)).toBe(false);
    expect(isAbortLike(null)).toBe(false);
  });
});

describe('installCrashRecord', () => {
  it('取消类异常：不退出、不写 crash record，记入 aborts 日志', () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    installCrashRecord(dir, { target, exit });
    crash(target, abortError());
    crash(target, abortError(), 'unhandledRejection');
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
});

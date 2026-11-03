import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginChildTracking,
  failHostProcess,
  installChildProcessHooks,
  killTrackedChildren,
} from './children';

const require = createRequire(import.meta.url);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('插件宿主异常退出', () => {
  afterEach(() => {
    killTrackedChildren();
  });

  it('未捕获异常退出前先结束已跟踪的子进程', async () => {
    installChildProcessHooks();
    beginChildTracking();
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid;
    expect(typeof pid).toBe('number');
    expect(alive(pid ?? -1)).toBe(true);
    const logs: string[] = [];
    let code: number | undefined;
    failHostProcess(
      new Error('boom'),
      (message) => logs.push(message),
      (exitCode) => {
        expect(child.killed).toBe(true);
        code = exitCode;
      }
    );
    expect(logs[0]).toContain('boom');
    expect(code).toBe(1);
    for (let i = 0; i < 100 && pid !== undefined && alive(pid); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(alive(pid ?? -1)).toBe(false);
  });

  it('日志上报抛错时仍然杀掉子进程并退出', () => {
    installChildProcessHooks();
    beginChildTracking();
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    let code: number | undefined;
    expect(() =>
      failHostProcess(
        new Error('boom'),
        () => {
          throw new Error('log down');
        },
        (exitCode) => {
          code = exitCode;
        }
      )
    ).not.toThrow();
    expect(code).toBe(1);
    expect(child.killed).toBe(true);
  });
});

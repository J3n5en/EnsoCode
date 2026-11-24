import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_WORKER_EXIT_LOG } from '@shared/agentWorkerExit';
import { classifyWorkerExitLevel, parseStampedLog } from '@shared/appLog';
import { setAppLoggingEnabled } from '@shared/appLogFile';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fork = vi.hoisted(() => ({
  userData: '',
  children: [] as Array<{ emit(event: string, ...args: unknown[]): void }>,
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => fork.userData,
    getAppPath: () => fork.userData,
    isPackaged: false,
    getVersion: () => '0.0.0',
    on: () => {},
  },
  notification: { isSupported: () => false },
  clipboard: { writeText: () => {} },
  shell: { openExternal: () => Promise.resolve() },
  utilityProcess: {
    fork: () => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const child = {
        pid: 100 + fork.children.length,
        postMessage: () => {},
        once: (event: string, handler: (...args: unknown[]) => void) =>
          handlers.set(event, handler),
        on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
        kill() {},
        emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
      };
      fork.children.push(child);
      return child;
    },
  },
}));
vi.mock('./processExit', () => ({ killAndWaitExit: vi.fn(async () => {}) }));

import { startAgentWorker, stopAgentWorker, stopAgentWorkerForQuit } from './agentHost';

fork.userData = mkdtempSync(path.join(tmpdir(), 'enso-exitlog-'));
mkdirSync(path.join(fork.userData, 'agent'));
setAppLoggingEnabled(true);
afterAll(() => rmSync(fork.userData, { recursive: true, force: true }));

let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  stopAgentWorker();
});

const exitEntries = () =>
  parseStampedLog(
    readFileSync(path.join(fork.userData, 'agent', AGENT_WORKER_EXIT_LOG), 'utf8'),
    'agent',
    classifyWorkerExitLevel
  ).filter((entry) => entry.message.startsWith('exit pid='));

it('worker code=0 退出不打 console.error，退出日志判 info', () => {
  startAgentWorker();
  fork.children.at(-1)?.emit('exit', 0);
  expect(error).not.toHaveBeenCalled();
  expect(exitEntries().at(-1)?.level).toBe('info');
});

it('worker 非 0 退出照旧打 console.error，退出日志判 error', () => {
  startAgentWorker();
  fork.children.at(-1)?.emit('exit', 1);
  expect(error.mock.calls.flat().join(' ')).toContain('worker exited');
  expect(exitEntries().at(-1)?.level).toBe('error');
});

it('退出应用 / 安装更新时终止 worker 的非 0 退出不算错误', async () => {
  startAgentWorker();
  const child = fork.children.at(-1);
  await stopAgentWorkerForQuit(1_000);
  child?.emit('exit', 15);
  expect(error).not.toHaveBeenCalled();
  expect(exitEntries().at(-1)?.level).toBe('info');
});

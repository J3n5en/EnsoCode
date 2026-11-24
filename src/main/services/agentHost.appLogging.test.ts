import { tmpdir } from 'node:os';
import { APP_LOGGING_ENV, setAppLoggingEnabled } from '@shared/appLogFile';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fork = vi.hoisted(() => ({
  envs: [] as Array<Record<string, string | undefined>>,
  posted: [] as unknown[],
  spawn: undefined as (() => void) | undefined,
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir(),
    isPackaged: false,
    getVersion: () => '0.0.0',
    on: () => {},
  },
  notification: { isSupported: () => false },
  clipboard: { writeText: () => {} },
  shell: { openExternal: () => Promise.resolve() },
  utilityProcess: {
    fork: (_path: string, _args: string[], options: { env: Record<string, string> }) => {
      fork.envs.push(options.env);
      return {
        postMessage: (message: unknown) => fork.posted.push(message),
        once: (event: string, listener: () => void) => {
          if (event === 'spawn') fork.spawn = listener;
        },
        on: () => {},
        kill: () => {},
      };
    },
  },
}));

import { pushAppLogging, startAgentWorker, stopAgentWorker } from './agentHost';

afterEach(() => {
  stopAgentWorker();
  setAppLoggingEnabled(false);
});

const appLoggingCommands = () =>
  fork.posted.filter((message) => (message as { type?: unknown }).type === 'set-app-logging');

it('worker 启动时经 env 拿到 Main 当前的应用日志开关，缺省关', () => {
  startAgentWorker();
  expect(fork.envs.at(-1)?.[APP_LOGGING_ENV]).toBe('0');
  stopAgentWorker();
  setAppLoggingEnabled(true);
  startAgentWorker();
  expect(fork.envs.at(-1)?.[APP_LOGGING_ENV]).toBe('1');
});

it('切换后推给运行中的 worker，无需重启', () => {
  startAgentWorker();
  fork.spawn?.();
  const forks = fork.envs.length;
  setAppLoggingEnabled(true);
  pushAppLogging();
  setAppLoggingEnabled(false);
  pushAppLogging();
  expect(appLoggingCommands()).toEqual([
    { type: 'set-app-logging', enabled: true },
    { type: 'set-app-logging', enabled: false },
  ]);
  expect(fork.envs).toHaveLength(forks);
});

import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fork = vi.hoisted(() => ({
  envs: [] as Array<Record<string, string | undefined>>,
  posted: [] as unknown[],
  spawn: undefined as (() => void) | undefined,
  state: {} as Record<string, unknown>,
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
vi.mock('../ipc/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/settings')>()),
  readSettings: () => ({ 'enso-settings': { state: fork.state } }),
}));

import { pushLongCacheRetention, startAgentWorker, stopAgentWorker } from './agentHost';

afterEach(() => stopAgentWorker());

const spawnWorker = (state: Record<string, unknown>) => {
  fork.state = state;
  fork.posted = [];
  startAgentWorker();
  fork.spawn?.();
  return fork.envs.at(-1) ?? {};
};
const longCacheCommands = () =>
  fork.posted.filter(
    (message) => (message as { type?: unknown }).type === 'set-long-cache-retention'
  );

it('worker 就绪后按设置下发长缓存开关，env 不注入进程级 PI_CACHE_RETENTION', () => {
  const prev = process.env.PI_CACHE_RETENTION;
  delete process.env.PI_CACHE_RETENTION;
  try {
    expect(spawnWorker({ longCacheRetention: true })).not.toHaveProperty('PI_CACHE_RETENTION');
    expect(longCacheCommands()).toEqual([{ type: 'set-long-cache-retention', enabled: true }]);
    stopAgentWorker();
    for (const state of [{ longCacheRetention: false }, {}, { longCacheRetention: 'true' }]) {
      spawnWorker(state);
      expect(longCacheCommands()).toEqual([{ type: 'set-long-cache-retention', enabled: false }]);
      stopAgentWorker();
    }
  } finally {
    if (prev !== undefined) process.env.PI_CACHE_RETENTION = prev;
  }
});

it('设置变更后推送新值，无需重启 worker', () => {
  spawnWorker({});
  const forks = fork.envs.length;
  fork.state = { longCacheRetention: true };
  pushLongCacheRetention();
  expect(longCacheCommands().at(-1)).toEqual({ type: 'set-long-cache-retention', enabled: true });
  expect(fork.envs).toHaveLength(forks);
});

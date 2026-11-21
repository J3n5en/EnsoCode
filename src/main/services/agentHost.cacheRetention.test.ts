import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fork = vi.hoisted(() => ({
  envs: [] as Array<Record<string, string | undefined>>,
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
      return { postMessage: () => {}, once: () => {}, on: () => {}, kill: () => {} };
    },
  },
}));
vi.mock('../ipc/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/settings')>()),
  readSettings: () => ({ 'enso-settings': { state: fork.state } }),
}));

import { startAgentWorker, stopAgentWorker } from './agentHost';

afterEach(() => stopAgentWorker());

const spawnEnv = (state: Record<string, unknown>) => {
  fork.state = state;
  startAgentWorker();
  return fork.envs.at(-1) ?? {};
};

it('开启长缓存时 worker env 带 PI_CACHE_RETENTION=long', () => {
  expect(spawnEnv({ longCacheRetention: true }).PI_CACHE_RETENTION).toBe('long');
});

it('关闭或缺省时不注入 PI_CACHE_RETENTION', () => {
  const prev = process.env.PI_CACHE_RETENTION;
  delete process.env.PI_CACHE_RETENTION;
  try {
    expect(spawnEnv({ longCacheRetention: false })).not.toHaveProperty('PI_CACHE_RETENTION');
    expect(spawnEnv({})).not.toHaveProperty('PI_CACHE_RETENTION');
    expect(spawnEnv({ longCacheRetention: 'true' })).not.toHaveProperty('PI_CACHE_RETENTION');
  } finally {
    if (prev !== undefined) process.env.PI_CACHE_RETENTION = prev;
  }
});

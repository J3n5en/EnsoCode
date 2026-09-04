import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const undiciMocks = vi.hoisted(() => ({
  Agent: vi.fn(function Agent() {
    return {};
  }),
  EnvHttpProxyAgent: vi.fn(function EnvHttpProxyAgent() {
    return {};
  }),
  setGlobalDispatcher: vi.fn(),
}));

vi.mock('undici', () => undiciMocks);

import { bootstrapWorkerProxyFromEnv } from './proxyEnv';

const KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];

describe('bootstrapWorkerProxyFromEnv', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('worker 启动时继承到 HTTP_PROXY → 安装 EnvHttpProxyAgent（不等 main 下发命令）', () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890';
    process.env.NO_PROXY = 'localhost';
    bootstrapWorkerProxyFromEnv();
    expect(undiciMocks.EnvHttpProxyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        httpProxy: 'http://127.0.0.1:7890',
        httpsProxy: 'http://127.0.0.1:7890',
        noProxy: 'localhost',
      })
    );
    expect(undiciMocks.setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it('未继承到代理 env → 安装普通 Agent', () => {
    bootstrapWorkerProxyFromEnv();
    expect(undiciMocks.EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(undiciMocks.Agent).toHaveBeenCalledTimes(1);
    expect(undiciMocks.setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });
});

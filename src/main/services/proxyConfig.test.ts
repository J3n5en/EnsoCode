import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  setProxy: vi.fn(),
  resolveProxy: vi.fn(),
}));

const undiciMocks = vi.hoisted(() => ({
  Agent: vi.fn(function Agent() {
    return {};
  }),
  EnvHttpProxyAgent: vi.fn(function EnvHttpProxyAgent() {
    return {};
  }),
  setGlobalDispatcher: vi.fn(),
}));

const sendAgentCommand = vi.hoisted(() => vi.fn(() => ({ ok: true })));

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      setProxy: electronMocks.setProxy,
      resolveProxy: electronMocks.resolveProxy,
    },
  },
}));

vi.mock('undici', () => undiciMocks);
vi.mock('./agentHost', () => ({ sendAgentCommand }));

import { ProxyConfig } from './proxyConfig';

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'GRPC_PROXY',
  'grpc_proxy',
  'no_proxy',
  'NO_PROXY',
] as const;

describe('ProxyConfig', () => {
  const previousEnv: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) previousEnv[key] = process.env[key];
    vi.clearAllMocks();
    electronMocks.setProxy.mockResolvedValue(undefined);
    electronMocks.resolveProxy.mockResolvedValue('DIRECT');
  });

  afterEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  it('writes HTTP_PROXY when system resolution returns PROXY', async () => {
    electronMocks.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890');
    const config = new ProxyConfig({
      setProxy: electronMocks.setProxy,
      resolveProxy: electronMocks.resolveProxy,
    } as never);
    await expect(config.resolveProxy()).resolves.toBe(true);
    expect(process.env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(undiciMocks.EnvHttpProxyAgent).toHaveBeenCalled();
    expect(sendAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set-proxy-env' })
    );
  });

  it('clears env when mode is none', async () => {
    const config = new ProxyConfig({
      setProxy: electronMocks.setProxy,
      resolveProxy: electronMocks.resolveProxy,
    } as never);
    config.setProxyMode('none');
    await config.resolveProxy();
    expect(electronMocks.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it('keeps the last proxy when a later resolve fails', async () => {
    electronMocks.resolveProxy
      .mockResolvedValueOnce('PROXY 127.0.0.1:7890')
      .mockRejectedValueOnce(new Error('resolve failed'));
    const config = new ProxyConfig({
      setProxy: electronMocks.setProxy,
      resolveProxy: electronMocks.resolveProxy,
    } as never);
    await config.resolveProxy();
    await expect(config.resolveProxy()).resolves.toBe(false);
    expect(config.getProxyUrl()).toBe('http://127.0.0.1:7890');
  });
});

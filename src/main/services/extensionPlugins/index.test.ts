import { describe, expect, it, vi } from 'vitest';
import { pluginHostCapabilities, pluginHostEnv, wakePluginSession } from './index';

describe('wakePluginSession', () => {
  it('窗口能拉起会话就不走 Main 恢复', async () => {
    const resume = vi.fn(async () => ({ ok: true }));
    await wakePluginSession({ ensure: async () => null, resume });
    expect(resume).not.toHaveBeenCalled();
  });

  it('窗口里没有这个会话（如没打开的秘书）时回退到 Main 恢复', async () => {
    const resume = vi.fn(async () => ({ ok: true }));
    await wakePluginSession({
      ensure: () => Promise.reject(new Error('会话不在本窗口')),
      resume,
    });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('Main 也恢复不了就报 Main 的原因；没有回退时报窗口的原因', async () => {
    await expect(
      wakePluginSession({
        ensure: () => Promise.reject(new Error('会话不在本窗口')),
        resume: async () => ({ ok: false, error: 'unknown session' }),
      })
    ).rejects.toThrow('unknown session');
    await expect(
      wakePluginSession({ ensure: () => Promise.reject(new Error('会话不在本窗口')) })
    ).rejects.toThrow('会话不在本窗口');
    // 不归 Main 恢复的会话（普通会话）：仍报窗口的原因
    await expect(
      wakePluginSession({
        ensure: () => Promise.reject(new Error('会话不在本窗口')),
        resume: async () => null,
      })
    ).rejects.toThrow('会话不在本窗口');
  });
});

describe('pluginHostEnv', () => {
  it('只传白名单变量，包括代理设置', () => {
    const env = pluginHostEnv({
      PATH: '/bin',
      HTTP_PROXY: 'http://p:1',
      https_proxy: 'http://p:2',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      OPENAI_API_KEY: 'sk-secret',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HTTP_PROXY: 'http://p:1',
      https_proxy: 'http://p:2',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
    });
  });

  it('服务端不报告剪贴板和外链，即使平台函数存在', () => {
    expect(
      pluginHostCapabilities({
        host: 'server',
        hostVersion: '1.2.3',
        notify: false,
        clipboard: true,
        openExternal: true,
      })
    ).toEqual({
      host: 'server',
      hostVersion: '1.2.3',
      notify: false,
      mcp: true,
      clipboard: false,
      openExternal: false,
      composer: true,
    });
  });
});

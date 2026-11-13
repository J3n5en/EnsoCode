import { describe, expect, it } from 'vitest';
import { pluginHostCapabilities, pluginHostEnv } from './index';

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

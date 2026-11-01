import { describe, expect, it } from 'vitest';
import { pluginHostEnv } from './index';

describe('pluginHostEnv', () => {
  it('只传白名单变量，包括代理设置', () => {
    const env = pluginHostEnv({
      PATH: '/bin',
      HTTP_PROXY: 'http://p:1',
      https_proxy: 'http://p:2',
      NO_PROXY: 'localhost',
      OPENAI_API_KEY: 'sk-secret',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HTTP_PROXY: 'http://p:1',
      https_proxy: 'http://p:2',
      NO_PROXY: 'localhost',
    });
  });
});

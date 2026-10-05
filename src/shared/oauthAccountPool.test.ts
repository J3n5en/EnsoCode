import { describe, expect, it } from 'vitest';
import { modelUsability } from './defaultModel';
import {
  classifyCodexPoolFailure,
  eligibleOauthPoolAccountKeys,
  parseOauthAccountPool,
  parseOauthPoolFailure,
} from './oauthAccountPool';
import type { ModelProvider } from './types/llm';

const account = (key: string, enabled = true): ModelProvider => ({
  id: key,
  name: key,
  api: 'openai-responses',
  apiKey: '',
  baseUrl: '',
  enabled,
  oauthAccountKey: key,
  models: [{ id: 'gpt-fixture' }],
});

describe('ChatGPT 顺序账号池可用性', () => {
  it('failure只接收opaque UUID票据，保留无票旧协议但拒绝坏票和身份凭据', () => {
    const legacy = { accountKey: 'openai-codex', reason: 'login-invalid' };
    const receipt = '11111111-1111-4111-8111-111111111111';
    expect(parseOauthPoolFailure(legacy)).toEqual(legacy);
    expect(parseOauthPoolFailure({ ...legacy, selectionReceipt: receipt })).toEqual({
      ...legacy,
      selectionReceipt: receipt,
    });
    for (const selectionReceipt of [null, '', 1, {}, 'access-token', 'a'.repeat(36)]) {
      expect(parseOauthPoolFailure({ ...legacy, selectionReceipt })).toBeNull();
    }
    for (const field of ['auth', 'identity', 'credentialGeneration', 'digest']) {
      expect(
        parseOauthPoolFailure({ ...legacy, selectionReceipt: receipt, [field]: 'secret' })
      ).toBeNull();
    }
  });
  it('普通429、限速文案和服务器错误不是硬额度证据', () => {
    for (const body of [
      { error: { code: 'rate_limit_exceeded' } },
      { error: { message: 'You have hit your ChatGPT usage limit' } },
      'usage_limit_reached',
    ]) {
      expect(classifyCodexPoolFailure(429, body, 'openai-codex')).toBeNull();
    }
    expect(
      classifyCodexPoolFailure(503, { error: { code: 'usage_limit_reached' } }, 'openai-codex')
    ).toBeNull();
  });
  it('结构化额度码携带reset窗口，鉴权失效可接替；其他厂商不启用', () => {
    expect(
      classifyCodexPoolFailure(
        429,
        { error: { code: 'usage_limit_reached', resets_at: 1234 } },
        'openai-codex#2'
      )
    ).toEqual({ accountKey: 'openai-codex#2', reason: 'quota-exhausted', resetAt: 1234000 });
    expect(classifyCodexPoolFailure(401, {}, 'openai-codex')).toEqual({
      accountKey: 'openai-codex',
      reason: 'login-invalid',
    });
    expect(classifyCodexPoolFailure(401, {}, 'anthropic')).toBeNull();
  });
  it('脏配置、重复成员、其他厂商和空池拒绝', () => {
    for (const value of [
      null,
      {},
      { accountKeys: [] },
      { accountKeys: ['anthropic'] },
      { accountKeys: ['openai-codex', 'openai-codex'] },
      { accountKeys: ['openai-codex#01'] },
    ]) {
      expect(parseOauthAccountPool(value)).toBeNull();
    }
  });
  it('坏固定来源不能为池背书，极端reset输入不能传出非有限时间', () => {
    const source = {
      ...account('openai-codex'),
      oauthAccountPool: null,
    } as unknown as ModelProvider;
    const pool = {
      ...account('openai-codex'),
      id: 'pool',
      oauthAccountPool: { accountKeys: ['openai-codex'] },
    };
    expect(
      eligibleOauthPoolAccountKeys(pool, 'gpt-fixture', [pool, source], new Set(['openai-codex']))
    ).toEqual([]);
    expect(
      classifyCodexPoolFailure(
        429,
        { error: { code: 'usage_limit_reached', resets_at: Number.MAX_VALUE } },
        'openai-codex'
      )
    ).toEqual({ accountKey: 'openai-codex', reason: 'quota-exhausted' });
  });
  it('坏池字段不得降级成锚定固定账号', () => {
    const invalid = { ...account('openai-codex'), oauthAccountPool: { accountKeys: [] } };
    expect(
      modelUsability({ providerId: invalid.id, modelId: 'gpt-fixture' }, [invalid], {
        oauthCredentials: { status: 'ready', authenticatedAccountKeys: new Set(['openai-codex']) },
      })
    ).toBe('oauth-account-missing');
  });
  it('锚定账号退出后仍能使用真实登录且启用的其他成员', () => {
    const pool = {
      ...account('openai-codex'),
      id: 'pool',
      oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
    };
    expect(
      modelUsability(
        { providerId: 'pool', modelId: 'gpt-fixture' },
        [pool, account('openai-codex'), account('openai-codex#2')],
        {
          oauthCredentials: {
            status: 'ready',
            authenticatedAccountKeys: new Set(['openai-codex#2']),
          },
        }
      )
    ).toBe('usable');
  });

  it('池条目不能把自己当成启用的固定账号来源', () => {
    const pool = {
      ...account('openai-codex'),
      id: 'pool',
      oauthAccountPool: { accountKeys: ['openai-codex'] },
    };
    expect(
      modelUsability({ providerId: 'pool', modelId: 'gpt-fixture' }, [pool], {
        oauthCredentials: { status: 'ready', authenticatedAccountKeys: new Set(['openai-codex']) },
      })
    ).toBe('oauth-account-missing');
  });

  it('成员模型被停用不可接替，固定账号不受池影响', () => {
    const fixed = account('openai-codex#2');
    const pool = {
      ...account('openai-codex'),
      id: 'pool',
      oauthAccountPool: { accountKeys: ['openai-codex#2'] },
    };
    const credentials = {
      oauthCredentials: {
        status: 'ready' as const,
        authenticatedAccountKeys: new Set(['openai-codex#2']),
      },
    };
    expect(
      modelUsability({ providerId: fixed.id, modelId: 'gpt-fixture' }, [fixed], credentials)
    ).toBe('usable');
    fixed.models[0].enabled = false;
    expect(
      modelUsability({ providerId: pool.id, modelId: 'gpt-fixture' }, [pool, fixed], credentials)
    ).toBe('oauth-account-missing');
  });
});

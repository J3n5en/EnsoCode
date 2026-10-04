import type { ModelProvider } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { chatgptPoolSources, createChatgptPoolProvider, providerDisplayName } from './chatgptPool';

const source = (key: string, enabled = true): ModelProvider => ({
  id: key,
  name: `Account ${key}`,
  api: 'openai-completions',
  apiKey: '',
  baseUrl: '',
  enabled,
  oauthAccountKey: key,
  models: [{ id: 'gpt-model', enabled: true }],
});

describe('ChatGPT 自动接替设置', () => {
  it('成员按源条目顺序去重，只包含固定 ChatGPT 账号，保留停用成员用于显式编辑', () => {
    const first = source('openai-codex#2', false);
    const second = source('openai-codex');
    expect(chatgptPoolSources([first, source('anthropic'), second, second])).toEqual([
      first,
      second,
    ]);
  });

  it('显式创建独立池，不修改原账号，不复制密钥，聚合模型且保持推理设置', () => {
    const first = source('openai-codex#2');
    first.models[0].thinkingLevel = 'high';
    const second = source('openai-codex');
    second.models.push({ id: 'another', enabled: true });
    const pool = createChatgptPoolProvider([first, second], 'pool');
    expect(pool).toMatchObject({
      id: 'pool',
      apiKey: '',
      oauthAccountKey: first.oauthAccountKey,
      oauthAccountPool: { accountKeys: [first.oauthAccountKey, second.oauthAccountKey] },
      models: [{ id: 'gpt-model', thinkingLevel: 'high' }, { id: 'another' }],
    });
    expect(first).not.toHaveProperty('oauthAccountPool');
    expect(pool?.models[0]).not.toBe(first.models[0]);
  });

  it('池显示独立自动接替名称，固定账号原名称不变', () => {
    const fixed = source('openai-codex');
    const pool = { ...fixed, oauthAccountPool: { accountKeys: ['openai-codex'] } };
    const t = (key: string) => key;
    expect(providerDisplayName(pool, t)).toBe('ChatGPT (automatic failover)');
    expect(providerDisplayName(fixed, t)).toBe(fixed.name);
  });

  it.each([
    { firstEnabled: false, secondEnabled: true, enabled: true },
    { firstEnabled: false, secondEnabled: undefined, enabled: true },
    { firstEnabled: undefined, secondEnabled: false, enabled: true },
    { firstEnabled: false, secondEnabled: false, enabled: false },
  ])(
    '同一模型保留首源配置，任意源模型启用即可选择池：%j',
    ({ firstEnabled, secondEnabled, enabled }) => {
      const first = source('openai-codex');
      first.models = [
        { id: 'gpt-model', enabled: firstEnabled, label: 'First', thinkingLevel: 'high' },
      ];
      const second = source('openai-codex#2');
      second.models = [
        { id: 'gpt-model', enabled: secondEnabled, label: 'Second', thinkingLevel: 'low' },
      ];

      const pool = createChatgptPoolProvider([first, second], 'pool');

      expect(pool?.models).toEqual([
        { id: 'gpt-model', enabled, label: 'First', thinkingLevel: 'high' },
      ]);
      expect(first.models[0].enabled).toBe(firstEnabled);
      expect(second.models[0].enabled).toBe(secondEnabled);
    }
  );

  it('包含 API key 的混合条目不是固定订阅账号来源，也不能成为池锚点', () => {
    const mixed = { ...source('openai-codex'), apiKey: 'test-api-key' };
    const fixed = source('openai-codex#2');
    expect(chatgptPoolSources([mixed, fixed])).toEqual([fixed]);
    expect(createChatgptPoolProvider([mixed], 'pool')).toBeNull();
    expect(createChatgptPoolProvider([mixed, fixed], 'pool')).toMatchObject({
      oauthAccountKey: fixed.oauthAccountKey,
      oauthAccountPool: { accountKeys: [fixed.oauthAccountKey] },
    });
  });

  it.each(['openai-codex#1', 'openai-codex#0', 'openai-codex#abc'])(
    '无效账号 key 不能创建池：%s',
    (key) => {
      expect(createChatgptPoolProvider([source(key)], 'pool')).toBeNull();
    }
  );

  it('没有 ChatGPT 固定账号时不能创建池', () => {
    expect(createChatgptPoolProvider([source('anthropic')], 'pool')).toBeNull();
  });

  it('已有池不能成为另一池的账号来源', () => {
    const pool = { ...source('openai-codex'), oauthAccountPool: { accountKeys: ['openai-codex'] } };
    expect(chatgptPoolSources([pool])).toEqual([]);
  });
});

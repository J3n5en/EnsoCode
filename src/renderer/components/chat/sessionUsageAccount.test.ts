import type { ModelProvider } from '@shared/types';
import type { AgentSessionCustomEntry } from '@shared/types/agent';
import { VIRTUAL_PROVIDER_ID } from '@shared/virtualModels';
import { describe, expect, it } from 'vitest';
import { resolveSessionUsageAccount } from './sessionUsageAccount';

const pool: ModelProvider = {
  id: 'pool',
  name: 'ChatGPT',
  api: 'openai-responses',
  baseUrl: '',
  apiKey: '',
  enabled: true,
  oauthAccountKey: 'openai-codex',
  oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
  models: [{ id: 'model' }],
};
const notice: AgentSessionCustomEntry = {
  kind: 'oauth-account-selected',
  accountKey: 'openai-codex#2',
  settingsProviderId: 'pool',
  modelId: 'model',
  at: 10,
};
const conversation = { lastProviderId: 'pool', lastModelId: 'model', customEntries: [notice] };

describe('会话实际订阅额度账号', () => {
  it('真实池请求与接替按会话最新 scoped 通知解析，不使用锚点', () => {
    expect(resolveSessionUsageAccount([pool], conversation)).toEqual({
      providerId: 'pool',
      modelId: 'model',
      accountKey: 'openai-codex#2',
    });
    expect(
      resolveSessionUsageAccount([pool], {
        ...conversation,
        customEntries: [notice, { ...notice, accountKey: 'openai-codex', at: 20 }],
      })?.accountKey
    ).toBe('openai-codex');
  });
  it('未发请求、不同会话、旧无scope通知均隐藏池额度', () => {
    for (const customEntries of [
      [],
      [{ kind: 'oauth-account-selected' as const, accountKey: 'openai-codex#2', at: 1 }],
    ]) {
      expect(
        resolveSessionUsageAccount([pool], { ...conversation, customEntries })
      ).toBeUndefined();
    }
    expect(resolveSessionUsageAccount([pool], undefined)).toBeUndefined();
  });
  it('换池、换模型和移除实际成员后不沿更旧通知串号', () => {
    const other = { ...pool, id: 'other' };
    expect(
      resolveSessionUsageAccount([pool, other], { ...conversation, lastProviderId: 'other' })
    ).toBeUndefined();
    expect(
      resolveSessionUsageAccount([pool], { ...conversation, lastModelId: 'other' })
    ).toBeUndefined();
    expect(
      resolveSessionUsageAccount(
        [{ ...pool, oauthAccountPool: { accountKeys: ['openai-codex'] } }],
        conversation
      )
    ).toBeUndefined();
    expect(
      resolveSessionUsageAccount([pool], {
        ...conversation,
        customEntries: [notice, { ...notice, settingsProviderId: 'other', at: 20 }],
      })
    ).toBeUndefined();
  });
  it('普通账号保留选择即展示的行为，不受池历史影响', () => {
    expect(
      resolveSessionUsageAccount([{ ...pool, oauthAccountPool: undefined }], conversation)
        ?.accountKey
    ).toBe('openai-codex');
    expect(
      resolveSessionUsageAccount(
        [{ ...pool, oauthAccountKey: undefined, oauthAccountPool: undefined }],
        conversation
      )
    ).toBeUndefined();
  });
  it('虚拟模型不依据历史物理池通知猜测当前实际路由', () => {
    const virtualConversation = {
      ...conversation,
      lastProviderId: VIRTUAL_PROVIDER_ID,
      lastModelId: 'auto',
    };
    expect(resolveSessionUsageAccount([pool], virtualConversation)).toBeUndefined();
  });
});

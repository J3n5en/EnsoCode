import type { ModelProvider } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fixture = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  credentials: [] as Array<{ providerId: string; type: string }>,
  unavailable: new Set<string>(),
}));
vi.mock('../ipc/settings', async (original) => ({
  ...(await original<typeof import('../ipc/settings')>()),
  readSettings: () => fixture.settings,
}));
vi.mock('./oauthProviders', async (original) => ({
  ...(await original<typeof import('./oauthProviders')>()),
  getRuntime: async () => ({
    listCredentials: async () => fixture.credentials,
    getProvider: (key: string) => ({ id: key }),
    getModel: (key: string, modelId: string) =>
      fixture.unavailable.has(key) ? undefined : { provider: key, id: modelId },
  }),
}));

import { selectOauthPoolAccount } from './agentHost';

const a = 'openai-codex';
const b = 'openai-codex#2';
const modelId = 'fixture-model';
let serial = 0;
let providers: ModelProvider[];
let pool: ModelProvider;
const source = (key: string): ModelProvider => ({
  id: key,
  name: key,
  api: 'openai-responses',
  apiKey: '',
  baseUrl: '',
  enabled: true,
  oauthAccountKey: key,
  models: [{ id: modelId }],
});
const select = (excludedAccountKeys?: string[]) =>
  selectOauthPoolAccount({
    type: 'oauth-pool-select',
    requestId: 'fixture-request',
    settingsProviderId: pool.id,
    modelId,
    ...(excludedAccountKeys ? { excludedAccountKeys } : {}),
  });

beforeEach(() => {
  pool = {
    ...source(a),
    id: `pool-fixture-${++serial}`,
    oauthAccountPool: { accountKeys: [a, b] },
  };
  providers = [source(a), source(b), pool];
  fixture.settings = { 'enso-settings': { version: 14, state: { providers } } };
  fixture.credentials = [a, b].map((providerId) => ({ providerId, type: 'oauth' }));
  fixture.unavailable.clear();
});

describe('Main 账号池权威成员校验', () => {
  it('按池顺序选择且锚点退出后仍可使用另一个已登录账号', async () => {
    expect(await select()).toMatchObject({ accountKey: a });
    fixture.credentials = [{ providerId: b, type: 'oauth' }];
    expect(await select()).toMatchObject({ accountKey: b });
  });

  it.each(['disabled', 'model-disabled', 'model-unavailable', 'api-key'])(
    '%s 成员不参与，实时配置变化影响后续选择',
    async (reason) => {
      if (reason === 'disabled') providers[0].enabled = false;
      if (reason === 'model-disabled') providers[0].models[0].enabled = false;
      if (reason === 'model-unavailable') fixture.unavailable.add(a);
      if (reason === 'api-key') fixture.credentials[0].type = 'api_key';
      expect(await select()).toMatchObject({ accountKey: b });
    }
  );

  it('本轮已失败成员即使仍登录也不能重新参与，排除全部时明确结束', async () => {
    expect(await select([a])).toMatchObject({ accountKey: b });
    const result = await select([a, b]);
    expect(result).not.toHaveProperty('accountKey');
    expect(result).toMatchObject({ error: expect.stringContaining('No available ChatGPT') });
  });

  it('池不能靠自己的模型条目背书，源账号条目必须存在', async () => {
    providers.splice(0, 2);
    expect(await select()).toMatchObject({
      error: expect.stringContaining('No available ChatGPT'),
    });
  });

  it('坏池配置不会降级为固定锚点', async () => {
    pool.oauthAccountPool = { accountKeys: [] };
    expect(await select()).not.toHaveProperty('accountKey');
  });
});

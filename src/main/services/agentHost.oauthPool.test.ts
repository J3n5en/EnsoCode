import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelProvider, OauthAccountUsage } from '@shared/types';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OauthQuotaCoordinator } from './oauthQuotaCoordinator';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fixture = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  credentials: [] as Array<{ providerId: string; type: string }>,
  unavailable: new Set<string>(),
  quota: undefined as OauthQuotaCoordinator | undefined,
  usage: new Map<string, OauthAccountUsage>(),
  queries: [] as string[],
  identity: 'a'.repeat(64),
}));
vi.mock('../ipc/settings', async (original) => ({
  ...(await original<typeof import('../ipc/settings')>()),
  readSettings: () => fixture.settings,
}));
vi.mock('./oauthProviders', async (original) => ({
  ...(await original<typeof import('./oauthProviders')>()),
  getOauthQuotaCoordinator: () => fixture.quota,
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
const dir = mkdtempSync(path.join(tmpdir(), 'enso-host-quota-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
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
  fixture.usage.clear();
  fixture.queries = [];
  fixture.identity = 'a'.repeat(64);
  fixture.quota = new OauthQuotaCoordinator({
    file: path.join(dir, `quota-${serial}.json`),
    identity: async (key) =>
      fixture.credentials.some((entry) => entry.providerId === key && entry.type === 'oauth')
        ? fixture.identity
        : undefined,
    query: async (key) => {
      fixture.queries.push(key);
      return (
        fixture.usage.get(key) ?? {
          key,
          windows: [{ label: 'primary', usedPercent: 20, resetsAt: Date.now() + 100_000 }],
        }
      );
    },
  });
});

describe('Main 账号池权威成员校验', () => {
  it.each([2, 3])('前%d个已耗尽在Main直接跳过，不交给worker逐个试探模型', async (count) => {
    const keys = [a, b, 'openai-codex#3', 'openai-codex#4'];
    pool.oauthAccountPool = { accountKeys: keys };
    providers.unshift(...keys.slice(2).map(source));
    fixture.credentials = keys.map((providerId) => ({ providerId, type: 'oauth' }));
    for (const key of keys.slice(0, count))
      fixture.usage.set(key, {
        key,
        windows: [{ label: 'primary', usedPercent: 100, resetsAt: Date.now() + 100_000 }],
      });
    expect(await select()).toMatchObject({ accountKey: keys[count] });
    expect(fixture.queries).toEqual(keys.slice(0, count + 1));
    expect(await select()).toMatchObject({ accountKey: keys[count] });
    expect(fixture.queries).toHaveLength(count + 1);
  });
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
  it('Main返回不透明选号receipt，同key身份更换后的迟到失败不能封锁新账号', async () => {
    const first = await select();
    expect(first).toMatchObject({ accountKey: a, selectionReceipt: expect.any(String) });
    const receipt = 'selectionReceipt' in first ? first.selectionReceipt : undefined;
    fixture.identity = 'b'.repeat(64);
    const event = {
      type: 'oauth-pool-select' as const,
      requestId: 'stale-failure',
      settingsProviderId: pool.id,
      modelId,
      failed: {
        accountKey: a,
        reason: 'quota-exhausted' as const,
        resetAt: Date.now() + 100_000,
        selectionReceipt: receipt,
      },
    };
    expect(await selectOauthPoolAccount(event)).toMatchObject({ accountKey: a });
  });
  it('没有选号receipt的故障不污染Main额度权威', async () => {
    await select();
    expect(
      await selectOauthPoolAccount({
        type: 'oauth-pool-select',
        requestId: 'missing-receipt',
        settingsProviderId: pool.id,
        modelId,
        failed: { accountKey: a, reason: 'quota-exhausted', resetAt: Date.now() + 100_000 },
      })
    ).toMatchObject({ accountKey: a });
  });
  it.each(['disabled', 'logout'])(
    '额度网络等待期间%s最终选号重新核验，不下发陈旧账号',
    async (change) => {
      const pending = Promise.withResolvers<OauthAccountUsage>();
      fixture.quota = new OauthQuotaCoordinator({
        file: path.join(dir, `pending-${serial}.json`),
        identity: async (key) =>
          fixture.credentials.some((entry) => entry.providerId === key)
            ? 'a'.repeat(64)
            : undefined,
        query: async (key) =>
          key === a ? pending.promise : { key, windows: [{ label: 'primary', usedPercent: 20 }] },
      });
      const result = select();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (change === 'disabled') providers[0].enabled = false;
      else fixture.credentials = [{ providerId: b, type: 'oauth' }];
      pending.resolve({ key: a, windows: [{ label: 'primary', usedPercent: 20 }] });
      expect(await result).not.toMatchObject({ accountKey: a });
    }
  );
});

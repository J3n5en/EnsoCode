import { describe, expect, it } from 'vitest';
import { migrateSettings, SETTINGS_VERSION } from './migrate';

/** v0 持久化数据里订阅条目的形状 */
const legacyProvider = {
  id: 'p1',
  name: 'Anthropic',
  api: 'anthropic-messages',
  apiKey: '',
  baseUrl: '',
  enabled: true,
  models: [{ id: 'claude-sonnet-4-5', enabled: true }],
  oauthProviderId: 'anthropic',
};

describe('设置持久化迁移', () => {
  it('旧的 oauthProviderId 搬到 oauthAccountKey，值不变（首个账号 key 即裸 providerId）', () => {
    const migrated = migrateSettings({ providers: [legacyProvider] }, 0) as {
      providers: Record<string, unknown>[];
    };
    expect(migrated.providers[0].oauthAccountKey).toBe('anthropic');
    expect(migrated.providers[0]).not.toHaveProperty('oauthProviderId');
  });

  it('订阅条目的其余字段（含模型开关）原样保留，不让用户重登', () => {
    const migrated = migrateSettings({ providers: [legacyProvider] }, 0) as {
      providers: Record<string, unknown>[];
    };
    expect(migrated.providers[0]).toMatchObject({
      id: 'p1',
      name: 'Anthropic',
      models: [{ id: 'claude-sonnet-4-5', enabled: true }],
    });
  });

  it('v1 → v2 只新增 defaultModel:null，不把数组第一项迁成用户默认', () => {
    const v1 = {
      theme: 'dark',
      providers: [
        {
          id: 'first-provider',
          models: [{ id: 'first-model', enabled: true }],
        },
      ],
      customFutureKey: { kept: true },
    };
    expect(migrateSettings(v1, 1)).toEqual({
      ...v1,
      defaultModel: null,
      titleSummaryEnabled: false,
      titleSummaryModel: null,
      approvalReviewer: null,
      lastApprovalMode: null,
    });
  });

  it('v0 数据连续执行两段迁移，同时保留其它字段', () => {
    const migrated = migrateSettings(
      { providers: [legacyProvider], language: 'zh', keybindings: { x: 'Cmd+X' } },
      0
    ) as Record<string, unknown>;
    expect(migrated).toMatchObject({
      defaultModel: null,
      language: 'zh',
      keybindings: { x: 'Cmd+X' },
      providers: [{ oauthAccountKey: 'anthropic' }],
    });
  });

  it('API key 条目不带 oauth 字段，原对象直接透传', () => {
    const apiKeyProvider = { id: 'p2', apiKey: 'sk-x', baseUrl: 'https://x.test' };
    const migrated = migrateSettings({ providers: [apiKeyProvider] }, 0) as {
      providers: unknown[];
    };
    expect(migrated.providers[0]).toEqual(apiKeyProvider);
  });

  it('v2 → v3 新增标题总结缺省：功能关闭、无独立模型', () => {
    const v2 = { theme: 'dark', defaultModel: { providerId: 'p', modelId: 'm' } };
    expect(migrateSettings(v2, 2)).toEqual({
      ...v2,
      titleSummaryEnabled: false,
      titleSummaryModel: null,
      approvalReviewer: null,
      lastApprovalMode: null,
    });
  });

  it('v3 → v4 新增助手代审模型缺省未选', () => {
    const v3 = {
      theme: 'dark',
      titleSummaryEnabled: false,
      titleSummaryModel: null,
    };
    expect(migrateSettings(v3, 3)).toEqual({
      ...v3,
      approvalReviewer: null,
      lastApprovalMode: null,
    });
  });

  it('v4 → v5 补 lastApprovalMode 缺省未选，不冒充用户上次档', () => {
    const v4 = { theme: 'dark', approvalReviewer: { providerId: 'p', modelId: 'm' } };
    expect(migrateSettings(v4, 4)).toEqual({
      ...v4,
      lastApprovalMode: null,
    });
  });

  it.each([5, 6])('v%s 移除记忆配置，保留模型、审批与其它设置且不修改输入', (version) => {
    const preserved = {
      theme: 'dark',
      providers: [legacyProvider],
      lastApprovalMode: 'full',
      customFutureKey: { kept: true },
    };
    const previous = {
      ...preserved,
      localMemoryEnabled: true,
      memoryModel: { providerId: 'p', modelId: 'm' },
      memoryConcurrency: 4,
    };
    expect(SETTINGS_VERSION).toBeGreaterThan(6);
    expect(migrateSettings(previous, version)).toEqual(preserved);
    expect(previous.localMemoryEnabled).toBe(true);
  });

  it('v0 数据一路迁到当前版本，标题总结字段同样补齐', () => {
    const migrated = migrateSettings({ providers: [legacyProvider] }, 0) as Record<string, unknown>;
    expect(migrated).toMatchObject({
      defaultModel: null,
      titleSummaryEnabled: false,
      titleSummaryModel: null,
      approvalReviewer: null,
      lastApprovalMode: null,
    });
  });

  it('已是当前版本时原样返回，不重复搬运', () => {
    const current = { providers: [{ id: 'p1', oauthAccountKey: 'anthropic#2' }] };
    expect(migrateSettings(current, SETTINGS_VERSION)).toBe(current);
  });

  // 持久化文件是用户机器上的真实文件，可能被手改坏或来自更早的残缺版本
  it('providers 不是数组时不崩，v2 字段仍补齐且其余键保留', () => {
    expect(migrateSettings({ providers: null, theme: 'dark' }, 0)).toEqual({
      providers: null,
      theme: 'dark',
      defaultModel: null,
      titleSummaryEnabled: false,
      titleSummaryModel: null,
      approvalReviewer: null,
      lastApprovalMode: null,
    });
  });

  it('providers 里混入 null / 非对象条目时不崩', () => {
    const migrated = migrateSettings({ providers: [null, 'x', legacyProvider] }, 0) as {
      providers: unknown[];
    };
    expect(migrated.providers[0]).toBeNull();
    expect(migrated.providers[1]).toBe('x');
    expect(migrated.providers[2]).toMatchObject({ oauthAccountKey: 'anthropic' });
  });

  it('整个持久化状态不是对象时原样返回', () => {
    expect(migrateSettings(null, 0)).toBeNull();
    expect(migrateSettings('broken', 0)).toBe('broken');
  });
});

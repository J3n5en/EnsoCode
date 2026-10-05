import { STATUS_LINE_PRESETS, STATUS_LINE_SEGMENT_IDS } from '@shared/statusLine';
import { describe, expect, it } from 'vitest';
import { mergeSettingsState, migrateSettings, SETTINGS_VERSION } from './migrate';

describe('请求体状态栏段位升级', () => {
  const oldDefault = [
    'model',
    'tokens',
    'cache',
    'context',
    'turns',
    'speed',
    'duration',
    'sessionTime',
  ];
  it('新默认开启请求体，并迁移旧默认但不覆盖用户自定义 / 全关', () => {
    expect(STATUS_LINE_PRESETS.default).toContain('requestBody');
    expect(migrateSettings({ statusLineSegments: oldDefault }, 13)).toMatchObject({
      statusLineSegments: STATUS_LINE_PRESETS.default,
    });
    for (const version of [13, 14])
      for (const list of [[], ['model'], [...oldDefault].reverse()])
        expect(migrateSettings({ statusLineSegments: list }, version)).toMatchObject({
          statusLineSegments: list,
        });
  });
  it('旧完整预设补新段，升级幂等', () => {
    const oldFull = STATUS_LINE_SEGMENT_IDS.filter((id) => String(id) !== 'requestBody');
    expect(migrateSettings({ statusLineSegments: oldFull }, 13)).toMatchObject({
      statusLineSegments: STATUS_LINE_PRESETS.full,
    });
    const current = { statusLineSegments: STATUS_LINE_PRESETS.default };
    expect(migrateSettings(current, SETTINGS_VERSION)).toBe(current);
  });
  it('主线 v14 已完成 computer 迁移的默认布局仍补请求体，保留用户的工具配置', () => {
    const disabledBuiltinTools = ['computer', 'browser'];
    const currentMain = { statusLineSegments: oldDefault, disabledBuiltinTools };
    expect(migrateSettings(currentMain, 14)).toMatchObject({
      statusLineSegments: STATUS_LINE_PRESETS.default,
      disabledBuiltinTools,
    });
  });
});

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
      editMode: 'apply_patch',
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
      editMode: 'apply_patch',
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
      editMode: 'apply_patch',
      lastApprovalMode: null,
    });
  });

  it('v4 → v5 补 lastApprovalMode 缺省未选，不冒充用户上次档', () => {
    const v4 = { theme: 'dark', approvalReviewer: { providerId: 'p', modelId: 'm' } };
    expect(migrateSettings(v4, 4)).toEqual({
      ...v4,
      editMode: 'apply_patch',
      lastApprovalMode: null,
    });
  });

  it.each([5, 6])('v%s 移除记忆配置，保留模型、审批与其它设置且不修改输入', (version) => {
    const preserved = {
      theme: 'dark',
      providers: [legacyProvider],
      lastApprovalMode: 'full',
      customFutureKey: { kept: true },
      editMode: 'apply_patch',
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

  it('v7 → v8 把已落盘的空 disabledBuiltinTools 补上 memory 默认关', () => {
    expect(migrateSettings({ theme: 'dark', disabledBuiltinTools: [] }, 7)).toEqual({
      theme: 'dark',
      disabledBuiltinTools: ['memory', 'computer'],
      subagentAllowedModes: ['task', 'coworker'],
      editMode: 'apply_patch',
    });
  });

  it('v7 → v8 已有其它禁用项时只追加 memory，不覆盖用户选择', () => {
    expect(migrateSettings({ disabledBuiltinTools: ['browser'] }, 7)).toEqual({
      disabledBuiltinTools: ['browser', 'memory', 'computer'],
      subagentAllowedModes: ['task', 'coworker'],
      editMode: 'apply_patch',
    });
  });

  it('v7 → v8 已经关掉 memory 则不重复追加', () => {
    const state = { disabledBuiltinTools: ['memory', 'browser'] };
    expect(migrateSettings(state, 7)).toEqual({
      disabledBuiltinTools: ['memory', 'browser', 'computer'],
      subagentAllowedModes: ['task', 'coworker'],
      editMode: 'apply_patch',
    });
  });

  it('v7 没有 disabledBuiltinTools 字段时不捏造（缺字段走 initialState 默认）', () => {
    expect(migrateSettings({ theme: 'dark' }, 7)).toEqual({
      theme: 'dark',
      editMode: 'apply_patch',
    });
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

  it('v8 → v9 旧 smartCompactEnabled=true 迁为 smart 策略，显式策略优先且幂等', () => {
    expect(migrateSettings({ smartCompactEnabled: true }, 8)).toMatchObject({
      compactStrategy: 'smart',
      smartCompactEnabled: true,
    });
    expect(migrateSettings({ smartCompactEnabled: false }, 8)).toMatchObject({
      compactStrategy: 'standard',
    });
    expect(migrateSettings({}, 8)).not.toHaveProperty('compactStrategy');
    const explicit = { compactStrategy: 'continuous-memory', smartCompactEnabled: true };
    expect(migrateSettings(explicit, 8)).toMatchObject(explicit);
    expect(migrateSettings(migrateSettings(explicit, 8), 8)).toMatchObject(explicit);
    expect(
      migrateSettings({ compactStrategy: 'bogus', smartCompactEnabled: true }, 8)
    ).toMatchObject({ compactStrategy: 'smart' });
  });

  it('v9 → v10 把旧 hashline 开关迁为 canonical editMode，合法新枚举优先', () => {
    expect(migrateSettings({ hashlineEditEnabled: true }, 9)).toEqual({ editMode: 'apply_patch' });
    expect(migrateSettings({ hashlineEditEnabled: false }, 9)).toEqual({ editMode: 'apply_patch' });
    expect(migrateSettings({}, 9)).toEqual({ editMode: 'apply_patch' });
    expect(migrateSettings({ editMode: 'apply_patch', hashlineEditEnabled: true }, 9)).toEqual({
      editMode: 'apply_patch',
    });
    expect(migrateSettings({ editMode: 'broken', hashlineEditEnabled: true }, 9)).toEqual({
      editMode: 'apply_patch',
    });
    expect(migrateSettings(migrateSettings({ hashlineEditEnabled: true }, 9), 9)).toEqual({
      editMode: 'apply_patch',
    });
  });

  it('v10 → v11 去掉 bash 拦截并把 hashline 回落，再经 v12 落到 apply_patch', () => {
    expect(migrateSettings({ editMode: 'hashline', bashInterceptEnabled: true }, 10)).toEqual({
      editMode: 'apply_patch',
    });
    expect(migrateSettings({ editMode: 'apply_patch', bashInterceptEnabled: false }, 10)).toEqual({
      editMode: 'apply_patch',
    });
  });

  it.each([
    [[], [], ['task', 'coworker']],
    [['coworker'], [], ['task']],
    [['subagent'], [], ['coworker']],
    [['subagent', 'coworker'], ['subagent'], []],
  ] as const)(
    'v12 → v13 把旧 task/coworker 开关迁为统一 mode 掩码（%j）',
    (legacy, unifiedDisabled, modes) => {
      expect(migrateSettings({ disabledBuiltinTools: [...legacy] }, 12)).toEqual({
        disabledBuiltinTools: [...unifiedDisabled, 'computer'],
        subagentAllowedModes: modes,
      });
    }
  );

  it('v12 → v13 同步迁移项目覆盖并保留项目覆盖', () => {
    expect(
      migrateSettings(
        {
          disabledBuiltinTools: ['browser'],
          projects: [
            { id: 'p1', disabledBuiltinTools: ['coworker'] },
            { id: 'p2', disabledBuiltinTools: ['subagent'] },
            { id: 'p3' },
          ],
        },
        12
      )
    ).toEqual({
      disabledBuiltinTools: ['browser', 'computer'],
      subagentAllowedModes: ['task', 'coworker'],
      projects: [
        {
          id: 'p1',
          disabledBuiltinTools: ['computer'],
          subagentAllowedModes: ['task'],
        },
        {
          id: 'p2',
          disabledBuiltinTools: ['computer'],
          subagentAllowedModes: ['coworker'],
        },
        { id: 'p3' },
      ],
    });
  });

  it('v11 → v12 把已有 replace 一并切到 apply_patch', () => {
    expect(migrateSettings({ editMode: 'replace' }, 11)).toEqual({ editMode: 'apply_patch' });
    expect(migrateSettings({ editMode: 'apply_patch' }, 11)).toEqual({ editMode: 'apply_patch' });
    expect(migrateSettings({ theme: 'dark' }, 11)).toEqual({
      theme: 'dark',
      editMode: 'apply_patch',
    });
  });

  it('hydrate 收窄当前版本坏枚举、移除旧布尔，partial 缺编辑字段时保留内存模式', () => {
    const current = {
      editMode: 'apply_patch' as const,
      accentColor: 'violet' as const,
      theme: 'dark',
    };
    expect(mergeSettingsState({ editMode: 'broken' }, current)).toEqual({
      editMode: 'apply_patch',
      accentColor: 'violet',
      theme: 'dark',
    });
    expect(mergeSettingsState({ hashlineEditEnabled: true }, current)).toEqual({
      editMode: 'apply_patch',
      accentColor: 'violet',
      theme: 'dark',
    });
    expect(mergeSettingsState({ theme: 'light' }, current)).toEqual({
      editMode: 'apply_patch',
      accentColor: 'violet',
      theme: 'light',
    });
  });

  it('hydrate 时已下架的识别模型落回当前值，合法模型照常恢复', () => {
    const current = {
      editMode: 'apply_patch' as const,
      accentColor: 'violet' as const,
      voiceModel: 'qwen3-asr',
    };
    expect(mergeSettingsState({ voiceModel: 'enso-asr' }, current).voiceModel).toBe('qwen3-asr');
    expect(mergeSettingsState({ voiceModel: 'x-asr' }, current).voiceModel).toBe('x-asr');
  });

  it('已是当前版本时原样返回，不重复搬运', () => {
    const current = { providers: [{ id: 'p1', oauthAccountKey: 'anthropic#2' }] };
    expect(migrateSettings(current, SETTINGS_VERSION)).toBe(current);
  });

  it('v13 → v14 把已落盘的 disabledBuiltinTools 补上 computer 默认关', () => {
    expect(migrateSettings({ disabledBuiltinTools: ['memory'] }, 13)).toEqual({
      disabledBuiltinTools: ['memory', 'computer'],
    });
    expect(migrateSettings({ disabledBuiltinTools: ['memory', 'computer'] }, 13)).toEqual({
      disabledBuiltinTools: ['memory', 'computer'],
    });
    expect(migrateSettings({ theme: 'dark' }, 13)).toEqual({ theme: 'dark' });
    expect(
      migrateSettings({ projects: [{ id: 'p1', disabledBuiltinTools: ['browser'] }] }, 13)
    ).toEqual({ projects: [{ id: 'p1', disabledBuiltinTools: ['browser', 'computer'] }] });
  });

  // 持久化文件是用户机器上的真实文件，可能被手改坏或来自更早的残缺版本
  it('providers 不是数组时不崩，v2 字段仍补齐且其余键保留', () => {
    expect(migrateSettings({ providers: null, theme: 'dark' }, 0)).toEqual({
      providers: null,
      theme: 'dark',
      defaultModel: null,
      editMode: 'apply_patch',
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

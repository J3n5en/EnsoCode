import { SMART_COMPACT_MODES } from '@shared/smartCompactMode';
import { describe, expect, it } from 'vitest';
import { validateBundle } from './codec';
import { CONFIG_SYNC_FIELD_POLICY, SYNC_FIELDS } from './index';
import { planImport } from './merge';
import type { ConfigSyncBundle } from './types';

const baseState = (): ConfigSyncBundle['state'] => ({
  providers: [],
  skills: [],
  mcpServers: [],
  instructions: [],
  presets: [],
  agentTypes: [],
  subagentModels: [],
});

const bundle = (state: Partial<ConfigSyncBundle['state']>): ConfigSyncBundle => ({
  format: 'enso-config',
  version: 1,
  createdAt: '2025-09-05T00:00:00.000Z',
  state: { ...baseState(), ...state },
  resources: { skills: [], instructions: [] },
  secretsIncluded: false,
});

describe('config sync portable preference contract', () => {
  it('将安全的通用偏好列为 portable，并明确保留本机背景资源与设备策略', () => {
    const portable = [
      'theme',
      'language',
      'terminalTheme',
      'terminalFontSize',
      'terminalFontFamily',
      'terminalFontWeight',
      'terminalFontWeightBold',
      'favoriteTerminalThemes',
      'statusLineSegments',
      'loadLocalSkills',
      'loadHarnessAssets',
      'exploreFoldEnabled',
      'bashInterceptEnabled',
      'hashlineEditEnabled',
      'smartCompactEnabled',
      'smartCompactModel',
      'smartCompactMode',
      'memoryEmbeddingModel',
      'memoryChatModel',
      'memoryDistillEnabled',
      'memoryKgEnabled',
      'openChangesOnFileEdit',
      'compactReadOnlyTools',
      'expandLiveEdits',
      'chatWide',
      'notifyMainAgentOnly',
      'maxActiveCoworkers',
      'generationStallTimeoutMin',
      'autoArchiveIdleDays',
      'autoArchiveMergedWorktrees',
      'autoDeleteArchivedDays',
      'backgroundRandomInterval',
      'backgroundOpacity',
      'backgroundBlur',
      'backgroundBrightness',
      'backgroundSaturation',
      'backgroundComposerOpacity',
      'backgroundCodeOpacity',
      'backgroundSizeMode',
      'disabledBuiltinTools',
      'keybindings',
      'usageModelPricing',
    ] as const;
    for (const field of portable) {
      expect(CONFIG_SYNC_FIELD_POLICY[field]).toEqual({ mode: 'portable' });
      expect(SYNC_FIELDS).toContain(field);
    }

    expect(CONFIG_SYNC_FIELD_POLICY.backgroundImageEnabled).toEqual({
      mode: 'excluded',
      reason: expect.stringContaining('appearance'),
    });
    expect(CONFIG_SYNC_FIELD_POLICY.backgroundSourceType).toEqual({
      mode: 'excluded',
      reason: expect.stringContaining('appearance'),
    });
    for (const field of [
      'backgroundImageEnabled',
      'backgroundSourceType',
      'backgroundImagePath',
      'backgroundFolderPath',
      'backgroundUrlPath',
      'backgroundRandomEnabled',
      'backgroundRefreshNonce',
    ] as const) {
      expect(CONFIG_SYNC_FIELD_POLICY[field].mode).toBe('excluded');
      expect(SYNC_FIELDS).not.toContain(field);
    }
  });

  it('接受所有可移植偏好的合法域值', () => {
    const input = bundle({
      theme: 'sync-terminal',
      language: 'zh',
      terminalTheme: 'Dracula',
      terminalFontSize: 16,
      terminalFontFamily: 'Iosevka',
      terminalFontWeight: '600',
      terminalFontWeightBold: 'bold',
      favoriteTerminalThemes: ['Dracula', 'Solarized'],
      statusLineSegments: ['model', 'context'],
      loadLocalSkills: false,
      loadHarnessAssets: true,
      exploreFoldEnabled: true,
      openChangesOnFileEdit: true,
      compactReadOnlyTools: false,
      expandLiveEdits: false,
      notifyMainAgentOnly: false,
      maxActiveCoworkers: 8,
      generationStallTimeoutMin: 30,
      autoArchiveIdleDays: 30,
      autoArchiveMergedWorktrees: true,
      autoDeleteArchivedDays: 15,
      backgroundRandomInterval: 600,
      backgroundOpacity: 0.5,
      backgroundBlur: 10,
      backgroundBrightness: 1.2,
      backgroundSaturation: 0.8,
      backgroundComposerOpacity: 0.7,
      backgroundCodeOpacity: 0.6,
      backgroundSizeMode: 'contain',
      disabledBuiltinTools: ['subagent', 'browser'],
      keybindings: { 'open-settings': 'mod+shift+o' },
      usageModelPricing: {
        'model-1': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      },
    });
    expect(validateBundle(input).state).toMatchObject(input.state);
  });

  it('接受 bash 拦截开关和运行时定义的全部智能压缩档位', () => {
    for (const smartCompactMode of SMART_COMPACT_MODES) {
      const input = bundle({ bashInterceptEnabled: true, smartCompactMode });
      expect(validateBundle(input).state).toMatchObject({
        bashInterceptEnabled: true,
        smartCompactMode,
      });
    }
  });

  it('拒绝运行时解析器不接受的智能压缩档位', () => {
    expect(() => validateBundle(bundle({ smartCompactMode: 'aggressive' as never }))).toThrow();
  });

  it('接受运行时可持久化的正数字号和空快捷键覆盖', () => {
    const input = bundle({
      terminalFontSize: 64,
      keybindings: { 'open-settings': '' },
    });
    expect(validateBundle(input).state).toMatchObject(input.state);
  });

  it('拒绝越界、非法枚举和错误结构的可移植偏好', () => {
    const cases: Array<[string, unknown]> = [
      ['theme', 'neon'],
      ['language', 'fr'],
      ['terminalFontSize', 0],
      ['terminalFontWeight', '650'],
      ['favoriteTerminalThemes', [1]],
      ['statusLineSegments', ['not-a-segment']],
      ['maxActiveCoworkers', 0],
      ['generationStallTimeoutMin', 1.5],
      ['autoArchiveIdleDays', 1.5],
      ['autoDeleteArchivedDays', -1],
      ['backgroundRandomInterval', 4],
      ['backgroundOpacity', 1.1],
      ['backgroundBlur', 21],
      ['backgroundBrightness', -0.1],
      ['backgroundSizeMode', 'stretch'],
      ['disabledBuiltinTools', [1]],
      ['keybindings', { action: 1 }],
      ['usageModelPricing', { model: { input: -1 } }],
    ];
    for (const [field, value] of cases) {
      expect(() => validateBundle(bundle({ [field]: value })), field).toThrow();
    }
  });

  it('合并 bash 拦截开关和智能压缩档位并计入设置摘要', () => {
    const result = planImport(
      {
        ...baseState(),
        bashInterceptEnabled: false,
        smartCompactMode: 'auto',
      },
      bundle({ bashInterceptEnabled: true, smartCompactMode: 'thorough' }),
      'merge'
    );

    expect(result.state).toMatchObject({
      bashInterceptEnabled: true,
      smartCompactMode: 'thorough',
    });
    expect(result.summary).toContainEqual(
      expect.objectContaining({
        category: 'settings',
        updated: 2,
        fields: expect.arrayContaining(['bashInterceptEnabled', 'smartCompactMode']),
      })
    );
  });

  it('替换移除本机 provider 或 preset 时清理失效的本机选择', () => {
    const result = planImport(
      {
        ...baseState(),
        providers: [
          {
            id: 'local-provider',
            name: 'Local Provider',
            api: 'openai-completions',
            baseUrl: 'https://local.example.test',
            enabled: true,
            models: [{ id: 'local-model' }],
          },
        ],
        defaultModel: { providerId: 'local-provider', modelId: 'local-model' },
        presets: [{ id: 'local-preset', name: 'Local', skillIds: [], mcpServerIds: [] }],
        defaultPresetId: 'local-preset',
      },
      bundle({}),
      'replace'
    );

    expect(result.state.defaultModel).toBeNull();
    expect(result.state.defaultPresetId).toBe('default');
    expect(result.summary).toContainEqual(
      expect.objectContaining({
        category: 'settings',
        updated: 2,
        fields: expect.arrayContaining(['defaultModel', 'defaultPresetId']),
      })
    );
  });

  it('导入只覆盖包中出现的偏好，缺省字段保留本机值并计入设置摘要', () => {
    const current = {
      ...baseState(),
      theme: 'dark',
      language: 'en',
      keybindings: { 'open-settings': 'mod+,' },
      usageModelPricing: { local: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
      backgroundOpacity: 0.9,
    } as Record<string, unknown>;
    const result = planImport(
      current,
      bundle({ theme: 'light', keybindings: { 'open-settings': 'mod+shift+o' } }),
      'merge'
    );

    expect(result.state).toMatchObject({
      theme: 'light',
      language: 'en',
      keybindings: { 'open-settings': 'mod+shift+o' },
      usageModelPricing: current.usageModelPricing,
      backgroundOpacity: 0.9,
    });
    expect(result.summary).toContainEqual(
      expect.objectContaining({ category: 'settings', updated: 2 })
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  ENSO_SMART_COMPACT_CONFIG,
  formatSmartCompactSummaryModel,
  mergeSmartCompactSettings,
  resolveSmartCompactExtensionPath,
} from './smartCompact';

describe('resolveSmartCompactExtensionPath', () => {
  it('解析到包入口时返回路径', () => {
    expect(resolveSmartCompactExtensionPath(() => '/tmp/pi-smart-compact/dist/index.js')).toBe(
      '/tmp/pi-smart-compact/dist/index.js'
    );
  });

  it('找不到包时返回 undefined', () => {
    expect(
      resolveSmartCompactExtensionPath(() => {
        throw new Error('Cannot find module');
      })
    ).toBeUndefined();
  });

  it('默认解析器能找到 Enso 内置依赖', () => {
    expect(resolveSmartCompactExtensionPath()).toMatch(/pi-smart-compact/);
  });
});

describe('formatSmartCompactSummaryModel', () => {
  it('订阅走 oauthAccountKey/modelId', () => {
    expect(
      formatSmartCompactSummaryModel({
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'k',
        modelId: 'claude-sonnet-4',
        settingsProviderId: 'anthropic-1',
        oauthAccountKey: 'anthropic',
      })
    ).toBe('anthropic/claude-sonnet-4');
  });

  it('自定义 API 走 worker 注册 id', () => {
    expect(
      formatSmartCompactSummaryModel({
        api: 'openai-completions',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        modelId: 'gpt-4.1',
        settingsProviderId: 'openai-entry',
      })
    ).toMatch(/^enso-[0-9a-f]+-[0-9a-f]+\/gpt-4\.1$/);
  });
});

describe('mergeSmartCompactSettings', () => {
  it('只覆盖 smartCompact 安全默认，其它顶层键不动', () => {
    const merged = mergeSmartCompactSettings({
      theme: 'dark',
      smartCompact: { mode: 'thorough', requireApproval: true, extra: 1 },
    });
    expect(merged.theme).toBe('dark');
    expect(merged.smartCompact).toMatchObject({
      ...ENSO_SMART_COMPACT_CONFIG,
      extra: 1,
    });
    expect(merged.smartCompact).toEqual({
      extra: 1,
      ...ENSO_SMART_COMPACT_CONFIG,
    });
  });

  it('根不是对象时仍写出最小 smartCompact', () => {
    expect(mergeSmartCompactSettings(null)).toEqual({
      smartCompact: { ...ENSO_SMART_COMPACT_CONFIG },
    });
  });

  it('传入路由时写 summaryModel，清掉旧路由', () => {
    const withRoute = mergeSmartCompactSettings(
      { smartCompact: { extra: 1 } },
      { summaryModel: 'anthropic/claude-sonnet-4' }
    );
    expect(withRoute.smartCompact).toMatchObject({
      extra: 1,
      ...ENSO_SMART_COMPACT_CONFIG,
      summaryModel: 'anthropic/claude-sonnet-4',
    });
    const cleared = mergeSmartCompactSettings(
      { smartCompact: { extra: 1, summaryModel: 'old/model' } },
      { summaryModel: null }
    );
    expect(cleared.smartCompact).toMatchObject({
      extra: 1,
      ...ENSO_SMART_COMPACT_CONFIG,
    });
    expect((cleared.smartCompact as Record<string, unknown>).summaryModel).toBeUndefined();
  });
});

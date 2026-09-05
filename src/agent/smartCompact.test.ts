import { describe, expect, it } from 'vitest';
import {
  ENSO_SMART_COMPACT_CONFIG,
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
});

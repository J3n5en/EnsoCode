import { describe, expect, it } from 'vitest';
import { getTranslation, normalizeLocale, translate, zhTranslations } from './i18n';

/** 间接映射表里的 t() key。删孤儿时漏看这些会把正在用的词条删掉。 */
const MAPPED_I18N_KEYS = [
  // ModelPicker.LEVEL_LABEL_KEYS + StatsLine.THINKING_LEVEL_SHORT_KEYS
  'Low',
  'Med',
  'High',
  'Max',
  // StatsLine.THINKING_LEVEL_FULL_KEYS（medium 档用 'Medium'，不是 'Med'）
  'Medium',
  // StatsLine.SEGMENT_LABEL_KEYS
  'Model',
  'Approval mode',
  'Working directory',
  'Session name',
  'Coworkers',
  'Tokens',
  'Cache hit rate',
  'Context window',
  'Turns',
  'Speed',
  'Duration',
  'Session time',
  'Subscription usage',
  // StatsLine.APPROVAL_LABEL_KEYS + ApprovalModePicker.MODE_META.labelKey
  'Supervised',
  'Auto-accept edits',
  'Full access',
  // ApprovalModePicker.MODE_META.descKey
  'Approve every command and file change',
  'Edits run freely; commands and MCP still ask',
  'Run everything without asking',
  // StatusLineSettings.PRESET_LABEL_KEYS
  'Minimal',
  'Default',
  'Full',
  // GeneralSettings.ACTION_LABEL_KEYS
  'Toggle sidebar',
  'Open settings',
  'New conversation',
  'Next coworker tab',
  'Previous coworker tab',
] as const;

describe('normalizeLocale', () => {
  it('zh 开头的一律归为中文', () => {
    expect(normalizeLocale('zh')).toBe('zh');
    expect(normalizeLocale('zh-CN')).toBe('zh');
    expect(normalizeLocale('ZH-Hant')).toBe('zh');
  });

  it('其余一律英文', () => {
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('ja')).toBe('en');
    expect(normalizeLocale(undefined)).toBe('en');
    expect(normalizeLocale('')).toBe('en');
  });
});

describe('mapped i18n keys', () => {
  it('间接映射表用到的词条都在字典里，且中文不是原文回退', () => {
    for (const key of MAPPED_I18N_KEYS) {
      expect(zhTranslations[key], `missing mapped key: ${key}`).toBeTypeOf('string');
      expect(getTranslation('zh', key)).not.toBe(key);
    }
  });
});

describe('getTranslation', () => {
  it('中文返回译文', () => {
    expect(getTranslation('zh', 'Settings')).toBe('设置');
  });

  it('英文原样返回 key', () => {
    expect(getTranslation('en', 'Settings')).toBe('Settings');
  });

  it('缺翻译时回退到英文原文而不是报错', () => {
    expect(getTranslation('zh', 'Some Untranslated Text')).toBe('Some Untranslated Text');
  });
});

describe('translate', () => {
  it('替换插值占位符', () => {
    expect(translate('zh', '{{count}} models', { count: 3 })).toBe('3 个模型');
    expect(translate('en', '{{count}} models', { count: 3 })).toBe('3 models');
  });

  it('支持一个模板里多个占位符', () => {
    expect(
      translate('en', 'Saving overwrites {{path}} directly — {{source}} will pick up the change.', {
        path: '/a/b',
        source: 'Factory',
      })
    ).toBe('Saving overwrites /a/b directly — Factory will pick up the change.');
  });

  it('缺少的参数保留原占位符，不会渲染成 undefined', () => {
    expect(translate('en', '{{count}} models', {})).toBe('{{count}} models');
  });

  it('不传参数时原样返回模板', () => {
    expect(translate('zh', 'Settings')).toBe('设置');
  });

  it('数字参数正确转成字符串', () => {
    expect(translate('zh', 'Connected ({{ms}}ms)', { ms: 128 })).toBe('连接成功(128ms)');
  });
});

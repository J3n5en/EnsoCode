import { describe, expect, it } from 'vitest';
import { CAPABILITY_CATALOG } from './capabilities/catalog';
import { getTranslation, normalizeLocale, translate, zhTranslations } from './i18n';
import { BUILTIN_TOOLS } from './types/builtinTools';

/** 间接映射表里的 t() key。删孤儿时漏看这些会把正在用的词条删掉。 */
const MAPPED_I18N_KEYS = [
  // ModelPicker.LEVEL_LABEL_KEYS + StatsLine.THINKING_LEVEL_SHORT_KEYS
  'Min',
  'Low',
  'Med',
  'High',
  'Extra',
  'Max',
  // StatsLine.THINKING_LEVEL_FULL_KEYS（medium 档用 'Medium'，xhigh 用 'Extra High'）
  'Medium',
  'Extra High',
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
  // ProviderModelRow.BADGE_LABEL_KEYS + tri-state / number inherit labels
  'Overridden',
  'Catalog',
  'Inherit',
  'On',
  'Off',
  'Thinking level',
  'Context',
  'Max tokens',
  // GeneralSettings.ACTION_LABEL_KEYS
  'Toggle sidebar',
  'Toggle side panel',
  'Toggle side panel fullscreen',
  'Open settings',
  'Switch model',
  'Focus chat input',
  'Find in conversation',
  'Only when the chat input is focused',
  'New conversation',
  'Next coworker tab',
  'Previous coworker tab',
  'New terminal tab',
  'Close terminal tab',
] as const;

const MODEL_CENTER_ENSO_I18N_KEYS = [
  // Unified provider setup and OAuth hosts
  'Add model or provider',
  'Choose a provider first. You will select subscription or API Key next.',
  'Choose how to connect',
  'Provider subscription',
  'Authorization failed',
  'Authorizing {{provider}}',
  'Enter this code in your browser',
  'Open authorization page again',
  'Cancel authorization',
  'Subscription authorization',
  'No subscription account connected',
  'Connect subscription',
  'Add another account',
  'Resets {{time}}',
  'Could not load subscription providers',
  'Target',
  'Provider',
  'Account',
  'Name',
  'Coworker',
  // Default model
  'Default model',
  'Used for new conversations.',
  'No default model',
  'No usable models',
  'Default model changed: {{previous}} → {{next}}',
  'Subscription credentials could not be loaded: {{error}}',
  // Typed Agent recipient, child TAB, and parent notifications
  'Ask Enso',
  'Type @ to choose a file or Agent',
  'Create or select a project to start a conversation',
  'Agents',
  'Files',
  'System',
  'Built-in',
  'Custom',
  'Locked',
  'Recipient',
  'Remove Agent recipient',
  'Message the selected Agent…',
  'Send only to the selected Agent',
  'Inherits the conversation model and provides product capabilities',
  'This Agent name is reserved',
  'Dispatched to',
  'Completed',
  'Failed',
  // Receipt outcomes
  'succeeded',
  'denied',
  'failed',
  'unavailable',
  'cancelled',
  // Capacity and exact ready handshake failures surfaced in the current TAB
  'Coworker limit reached (5 active or reserved).',
  'Agent worker exited before ready.',
  'Agent session was rejected before ready.',
  'Agent session ready handshake timed out.',
  'Parent ready model did not match the bound model.',
  'Child ready identity mismatch.',
  'Child ready profile or model mismatch.',
  'Locked Enso tool profile mismatch.',
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

describe('model center and Enso i18n keys', () => {
  it('关键向导、Enso 与 ASK key 唯一且都有中文映射', () => {
    MODEL_CENTER_ENSO_I18N_KEYS.forEach((key, index) => {
      expect(MODEL_CENTER_ENSO_I18N_KEYS.indexOf(key), `duplicate feature key: ${key}`).toBe(index);
    });
    for (const key of MODEL_CENTER_ENSO_I18N_KEYS) {
      expect(zhTranslations, `missing feature key: ${key}`).toHaveProperty(key);
      expect(zhTranslations[key], `empty feature translation: ${key}`).not.toBe('');
      expect(getTranslation('zh', key), `untranslated feature key: ${key}`).not.toBe(key);
    }
  });
});

describe('dangerous capability i18n keys', () => {
  it('从 catalog 自动收集的全部危险能力说明都有中文映射', () => {
    const descriptions = Object.values(CAPABILITY_CATALOG)
      .filter((spec) => spec.risk === 'dangerous')
      .map((spec) => spec.description);
    expect(descriptions.length).toBeGreaterThan(0);
    for (const description of descriptions) {
      expect(
        zhTranslations[description],
        `missing dangerous capability: ${description}`
      ).toBeDefined();
      expect(getTranslation('zh', description)).not.toBe(description);
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

describe('模块级常量的 i18n key（#5）', () => {
  const alertLabels = ['Note', 'Tip', 'Important', 'Warning', 'Caution'] as const;
  const taskNoteKeys = ['(log unavailable)', 'Loading…', '(no log available)'] as const;

  it('内置工具说明存英文 key，中文表有对应译文', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.description).not.toMatch(/[\u4e00-\u9fff]/);
      expect(zhTranslations[tool.description]).toBeDefined();
      expect(translate('en', tool.description)).toBe(tool.description);
      expect(translate('zh', tool.description)).not.toBe(tool.description);
    }
  });

  it('GitHub alert 标题与 task-note 占位文案两边 locale 都能解析', () => {
    for (const key of [...alertLabels, ...taskNoteKeys]) {
      expect(translate('en', key)).toBe(key);
      expect(zhTranslations[key]).toBeDefined();
      expect(translate('zh', key)).toBe(zhTranslations[key]);
    }
  });
});

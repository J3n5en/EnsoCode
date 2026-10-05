import { describe, expect, it } from 'vitest';
import type { SettingsCategory } from './constants';
import { isCategoryVisible, resolveActiveCategory, visibleCategories } from './settingsCategories';

const cats = [
  { id: 'general' as SettingsCategory },
  { id: 'tools' as SettingsCategory },
  { id: 'memory' as SettingsCategory },
  { id: 'usage' as SettingsCategory },
];

describe('visibleCategories', () => {
  it('hides the memory page while the memory tool is off', () => {
    expect(visibleCategories(cats, ['memory']).map((c) => c.id)).toEqual([
      'general',
      'tools',
      'usage',
    ]);
  });

  it('shows it once the tool is enabled', () => {
    expect(visibleCategories(cats, []).map((c) => c.id)).toContain('memory');
  });

  it('never hides pages that do not depend on a tool', () => {
    const ids = visibleCategories(cats, ['memory', 'browser', 'isolated_sandbox']).map((c) => c.id);
    expect(ids).toEqual(['general', 'tools', 'usage']);
  });

  it('hides the workflows page while the workflow tool is off', () => {
    const withWorkflows = [...cats, { id: 'workflows' as SettingsCategory }];
    expect(visibleCategories(withWorkflows, ['workflow']).map((c) => c.id)).not.toContain(
      'workflows'
    );
    expect(visibleCategories(withWorkflows, ['memory']).map((c) => c.id)).toContain('workflows');
    expect(resolveActiveCategory('workflows', ['workflow'])).toBe('tools');
  });
});

describe('resolveActiveCategory', () => {
  it('falls back to Built-in tools when the active page just got hidden', () => {
    // 落在能把它重新打开的地方，而不是通用页
    expect(resolveActiveCategory('memory', ['memory'])).toBe('tools');
  });

  it('leaves the active page alone when it is still visible', () => {
    expect(resolveActiveCategory('memory', [])).toBe('memory');
    expect(resolveActiveCategory('usage', ['memory'])).toBe('usage');
  });

  it('also catches a deep link pointing at a disabled feature', () => {
    // deeplink 可能来自通知/外部跳转，指向一个当前没启用的功能
    expect(resolveActiveCategory('memory', ['memory'])).toBe('tools');
  });
});

describe('isCategoryVisible', () => {
  it('treats an unrelated disabled tool as irrelevant', () => {
    expect(isCategoryVisible('memory', ['browser'])).toBe(true);
  });
});

describe('Bot mode page', () => {
  const withBots = [
    ...cats,
    { id: 'experimental' as SettingsCategory },
    { id: 'bots' as SettingsCategory },
    { id: 'botTemplates' as SettingsCategory },
  ];

  it('is hidden until Bot mode is enabled; Experimental always stays', () => {
    expect(visibleCategories(withBots, []).map((c) => c.id)).not.toContain('bots');
    expect(visibleCategories(withBots, []).map((c) => c.id)).not.toContain('botTemplates');
    expect(visibleCategories(withBots, [], false).map((c) => c.id)).toContain('experimental');
    expect(visibleCategories(withBots, [], true).map((c) => c.id)).toContain('bots');
    expect(visibleCategories(withBots, [], true).map((c) => c.id)).toContain('botTemplates');
  });

  it('falls back to Experimental, where the switch lives', () => {
    expect(resolveActiveCategory('bots', [], false)).toBe('experimental');
    expect(resolveActiveCategory('bots', [], true)).toBe('bots');
    expect(resolveActiveCategory('botTemplates', [], false)).toBe('experimental');
    expect(resolveActiveCategory('botTemplates', [], true)).toBe('botTemplates');
  });
});

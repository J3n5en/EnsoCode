import { BUILTIN_TOOLS, DEFAULT_DISABLED_BUILTIN_TOOLS } from '@shared/types/builtinTools';
import { describe, expect, it } from 'vitest';
import type { SettingsCategory } from './constants';
import { resolveActiveCategory, visibleCategories } from './settingsCategories';

/**
 * 侧边栏与内置工具开关的联动契约。
 * 隐藏入口最怕的是「关掉后再也打不开」，这里把那条退路一起锁住。
 */

const ALL: { id: SettingsCategory }[] = [
  { id: 'general' },
  { id: 'tools' },
  { id: 'memory' },
  { id: 'usage' },
];

describe('memory entry visibility', () => {
  it('is hidden on a fresh install, because memory ships disabled', () => {
    const ids = visibleCategories(ALL, [...DEFAULT_DISABLED_BUILTIN_TOOLS]).map((c) => c.id);
    expect(ids).not.toContain('memory');
  });

  it('always leaves a way back: the memory toggle lives in Built-in tools', () => {
    // 入口隐藏后唯一的开启路径。这一条断了就再也打不开记忆功能。
    const ids = visibleCategories(ALL, [...DEFAULT_DISABLED_BUILTIN_TOOLS]).map((c) => c.id);
    expect(ids).toContain('tools');
    expect(BUILTIN_TOOLS.map((tool) => tool.id)).toContain('memory');
  });

  it('lands on Built-in tools when the current page disappears', () => {
    expect(resolveActiveCategory('memory', ['memory'])).toBe('tools');
  });
});

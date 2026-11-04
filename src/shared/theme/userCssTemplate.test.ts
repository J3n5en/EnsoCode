import { describe, expect, it } from 'vitest';
import { THEME_ANCHORS } from './anchors';
import { USER_CSS_TEMPLATE } from './userCssTemplate';

describe('user.css 模板', () => {
  it('列出每个稳定锚点的选择器', () => {
    for (const anchor of THEME_ANCHORS) {
      expect(USER_CSS_TEMPLATE).toContain(`[data-enso="${anchor}"]`);
    }
  });

  it('整份是一个注释块，刚创建时打开开关不改变界面', () => {
    const body = USER_CSS_TEMPLATE.trim();
    expect(body.startsWith('/*')).toBe(true);
    expect(body.endsWith('*/')).toBe(true);
    expect(body.indexOf('*/')).toBe(body.length - 2);
  });

  it('带可直接取消注释的示例规则', () => {
    expect(USER_CSS_TEMPLATE).toMatch(/\[data-enso="composer"\]\s*\{[^}]+\}/);
    expect(USER_CSS_TEMPLATE).toMatch(/:root\s*\{\s*--brand:[^}]+\}/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ACCENT_COLORS,
  ACCENT_PRESETS,
  accentOverride,
  DEFAULT_ACCENT_COLOR,
  parseAccentColor,
  resolveAccentColor,
} from './accentColor';

describe('accentColor', () => {
  it('默认跟随主题，且在合法取值里', () => {
    expect(DEFAULT_ACCENT_COLOR).toBe('theme');
    expect(ACCENT_COLORS).toContain(DEFAULT_ACCENT_COLOR);
  });

  it('接受全部预设取值', () => {
    for (const accent of ACCENT_COLORS) expect(parseAccentColor(accent)).toBe(accent);
  });

  it('非法值 parse 返回 null，resolve 落回默认值', () => {
    for (const bad of ['neon', '', 'VIOLET', 'Theme', null, undefined, 1, {}]) {
      expect(parseAccentColor(bad)).toBeNull();
      expect(resolveAccentColor(bad)).toBe(DEFAULT_ACCENT_COLOR);
    }
  });

  it('跟随主题不覆盖品牌色，预设按模式取浅/深值', () => {
    expect(accentOverride('theme', 'light')).toBeUndefined();
    expect(accentOverride('theme', 'dark')).toBeUndefined();
    for (const accent of ACCENT_COLORS) {
      if (accent === 'theme') continue;
      expect(accentOverride(accent, 'light')).toBe(ACCENT_PRESETS[accent].light);
      expect(accentOverride(accent, 'dark')).toBe(ACCENT_PRESETS[accent].dark);
      expect(ACCENT_PRESETS[accent].light).not.toBe(ACCENT_PRESETS[accent].dark);
    }
  });
});

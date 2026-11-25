import { describe, expect, it } from 'vitest';
import { localImageUrlToPath, projectIconUrl } from './localImage';
import {
  hashProjectKey,
  PROJECT_ICON_COLORS,
  projectIconColor,
  projectIconInitial,
} from './projectIcon';

describe('projectIcon', () => {
  it('哈希稳定，颜色按色板下标取', () => {
    expect(hashProjectKey('')).toBe(0);
    expect(hashProjectKey('a')).toBe(97);
    expect(hashProjectKey('enso')).toBe(3118277);
    expect(projectIconColor('a')).toBe(PROJECT_ICON_COLORS[97 % PROJECT_ICON_COLORS.length]);
    expect(projectIconColor('enso')).toBe(PROJECT_ICON_COLORS[3118277 % 10]);
    expect(projectIconColor('enso')).toBe(projectIconColor('enso'));
  });

  it('不同 key 能铺满 10 色，且颜色都来自色板', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 400; index += 1) seen.add(projectIconColor(`project-${index}`));
    expect(seen.size).toBe(PROJECT_ICON_COLORS.length);
    for (const color of seen) expect(PROJECT_ICON_COLORS).toContain(color);
  });

  it('首字符取 trim 后的首个码点', () => {
    expect(projectIconInitial('alpha')).toBe('A');
    expect(projectIconInitial('  项目 ')).toBe('项');
    expect(projectIconInitial('   ')).toBe('?');
    expect(projectIconInitial('')).toBe('?');
    expect(projectIconInitial('😀beta')).toBe('😀');
  });

  it('项目图标 URL 走保留 host，不会被当成磁盘路径', () => {
    expect(projectIconUrl('p1', 'abc')).toBe('local-image://project-icon/p1?v=abc');
    expect(projectIconUrl('a b', 'x/y')).toBe('local-image://project-icon/a%20b?v=x%2Fy');
    expect(localImageUrlToPath(new URL(projectIconUrl('p1', 'abc')))).toBeNull();
  });
});

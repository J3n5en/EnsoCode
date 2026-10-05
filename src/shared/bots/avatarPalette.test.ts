import { describe, expect, it } from 'vitest';
import { avatarPalette } from './avatarPalette';

describe('avatarPalette', () => {
  it('以成员色为首，共 5 个互不相同的十六进制色，结果稳定', () => {
    const palette = avatarPalette('#7c5cff');
    expect(palette).toHaveLength(5);
    expect(palette[0]).toBe('#7c5cff');
    expect(new Set(palette).size).toBe(5);
    for (const color of palette) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(avatarPalette('#7C5CFF')).toEqual(palette);
  });

  it('坏颜色回退到默认色，不抛错', () => {
    expect(avatarPalette('red')).toEqual(avatarPalette('#64748b'));
    expect(avatarPalette(undefined as unknown as string)).toHaveLength(5);
  });

  it('灰色也能给出 5 个不同颜色', () => {
    expect(new Set(avatarPalette('#808080')).size).toBe(5);
  });
});

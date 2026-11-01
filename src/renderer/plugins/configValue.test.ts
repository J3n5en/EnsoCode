import { describe, expect, it } from 'vitest';
import { coerceConfigValue, formatConfigValue } from './configValue';

describe('插件配置值转换', () => {
  it('字符串化的当前值按类型还原', () => {
    expect(formatConfigValue(12)).toBe('12');
    expect(formatConfigValue(true)).toBe('true');
    expect(formatConfigValue(null)).toBe('');
    expect(coerceConfigValue({ type: 'number', min: 0, max: 10 }, '3')).toEqual({
      ok: true,
      value: 3,
    });
    expect(coerceConfigValue({ type: 'number' }, '12.5')).toEqual({ ok: true, value: 12.5 });
    expect(coerceConfigValue({ type: 'boolean' }, 'true')).toEqual({ ok: true, value: true });
    expect(coerceConfigValue({ type: 'boolean' }, false)).toEqual({ ok: true, value: false });
    expect(coerceConfigValue({ type: 'enum', options: ['a', 'b'] }, 'b')).toEqual({
      ok: true,
      value: 'b',
    });
    expect(coerceConfigValue({ type: 'path' }, '/tmp/a')).toEqual({ ok: true, value: '/tmp/a' });
    expect(coerceConfigValue({ type: 'string' }, 'hello')).toEqual({ ok: true, value: 'hello' });
  });

  it('越界、非数字、枚举外和空值不能写成该类型', () => {
    expect(coerceConfigValue({ type: 'number', min: 1, max: 5 }, '0').ok).toBe(false);
    expect(coerceConfigValue({ type: 'number', max: 5 }, '9').ok).toBe(false);
    expect(coerceConfigValue({ type: 'number' }, 'x').ok).toBe(false);
    expect(coerceConfigValue({ type: 'number' }, '').ok).toBe(false);
    expect(coerceConfigValue({ type: 'boolean' }, 'yes').ok).toBe(false);
    expect(coerceConfigValue({ type: 'enum', options: ['a'] }, 'z').ok).toBe(false);
    expect(coerceConfigValue({ type: 'string' }, false).ok).toBe(false);
  });

  it('null 表示清除，与类型无关', () => {
    for (const type of ['string', 'number', 'boolean', 'enum', 'path'] as const)
      expect(coerceConfigValue({ type }, null)).toEqual({ ok: true, value: null });
  });
});

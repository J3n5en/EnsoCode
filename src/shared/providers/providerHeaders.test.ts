import { describe, expect, it } from 'vitest';
import {
  escapePiConfigValue,
  HEADER_NAME_RE,
  normalizeProviderHeaders,
  parseProviderHeaders,
} from './providerHeaders';

const { resolveConfigValue } = (await import(
  new URL(
    '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js',
    import.meta.url
  ).href
)) as { resolveConfigValue: (value: string) => string };

describe('normalizeProviderHeaders', () => {
  it('丢弃空行，并按名称大小写不敏感去重，后者覆盖前者且保留后者大小写', () => {
    expect(
      normalizeProviderHeaders([
        { name: '  ', value: 'drop' },
        { name: 'Originator', value: '  ' },
        { name: ' X-Trace ', value: ' first ' },
        { name: 'x-trace', value: 'second' },
        { name: 'User-Agent', value: ' custom ' },
      ])
    ).toEqual({
      'x-trace': 'second',
      'User-Agent': 'custom',
    });
  });

  it('结果为空时不产生映射', () => {
    expect(normalizeProviderHeaders([])).toBeUndefined();
    expect(normalizeProviderHeaders([{ name: ' ', value: 'x' }])).toBeUndefined();
  });
});

describe('parseProviderHeaders', () => {
  it('只收下合法名称、字符串值且不含换行的条目', () => {
    expect(
      parseProviderHeaders({
        'X-Ok': 'one',
        'bad name': 'no',
        'X-Num': 1,
        'X-Break': 'a\nb',
        'X-Return': 'a\r',
        '': 'empty',
      })
    ).toEqual({ 'X-Ok': 'one' });
  });

  it('非对象或空结果视为没有请求头', () => {
    expect(parseProviderHeaders(null)).toBeUndefined();
    expect(parseProviderHeaders(['X-A'])).toBeUndefined();
    expect(parseProviderHeaders({ nope: 1 })).toBeUndefined();
  });

  it('名称必须匹配 HTTP token', () => {
    expect(HEADER_NAME_RE.test('X-Custom_1')).toBe(true);
    expect(HEADER_NAME_RE.test('Bad Name')).toBe(false);
  });
});

describe('escapePiConfigValue', () => {
  it.each(['plain', '!rm', '$HOME', '$' + '{X}', '$$', '$!already', '!$$'])(
    '转义后经 pi 模板解析回到原文 %s',
    (value) => {
      expect(resolveConfigValue(escapePiConfigValue(value))).toBe(value);
    }
  );
});

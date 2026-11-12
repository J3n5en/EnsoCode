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

  // 真实场景：设置 `X-Title: Enso 编辑器` 后，该供应商拉模型、测试连接、每次推理都抛
  // `Cannot convert argument to a ByteString`；fetch/undici 只收 \t、0x20-0x7E、0x80-0xFF
  it('值里有 fetch 发不出去的字符（>0xFF、NUL、其它控制字符）时丢弃该条', () => {
    expect(
      parseProviderHeaders({
        'X-Ok': 'Enso\tcafé ~',
        'X-Title': 'Enso 编辑器',
        'X-Zw': 'a\u200bb',
        'X-Nul': 'a\0b',
        'X-Ctl': 'a\x01b',
        'X-Del': 'a\x7fb',
      })
    ).toEqual({ 'X-Ok': 'Enso\tcafé ~' });
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

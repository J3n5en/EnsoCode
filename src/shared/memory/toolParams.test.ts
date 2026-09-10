import { describe, expect, it } from 'vitest';
import { AGENT_CREATE_IMPORTANCE, CRYSTAL_MIN_SOURCES } from './constants';
import {
  normalizeMemoryCaptureParams,
  normalizeMemoryCrystallizeParams,
  normalizeMemorySearchParams,
  parseMemoryCaptureRequest,
  parseMemoryCrystallizeRequest,
  parseMemorySearchRequest,
} from './toolParams';

describe('normalizeMemorySearchParams', () => {
  it('缺省 limit=10、spaceId=all；字符串数字归一成数字', () => {
    expect(normalizeMemorySearchParams({ query: 'pg' })).toEqual({
      query: 'pg',
      limit: 10,
      spaceId: 'all',
      mode: 'fast',
    });
    expect(normalizeMemorySearchParams({ query: 'pg', limit: '3', spaceId: 'global' })).toEqual({
      query: 'pg',
      limit: 3,
      spaceId: 'global',
      mode: 'fast',
    });
  });

  it('缺省 mode=fast；deep 原样保留；非法值回退 fast', () => {
    expect(normalizeMemorySearchParams({ query: 'pg', mode: 'deep' })).toEqual({
      query: 'pg',
      limit: 10,
      spaceId: 'all',
      mode: 'deep',
    });
    expect(normalizeMemorySearchParams({ query: 'pg', mode: 'DEEP' })).toMatchObject({
      mode: 'deep',
    });
    expect(normalizeMemorySearchParams({ query: 'pg', mode: 'hyde' })).toMatchObject({
      mode: 'fast',
    });
  });

  it('非法 limit / spaceId 回退缺省；limit 夹在 [1, 50]', () => {
    expect(normalizeMemorySearchParams({ query: 'x', limit: 'abc', spaceId: 'nope' })).toEqual({
      query: 'x',
      limit: 10,
      spaceId: 'all',
      mode: 'fast',
    });
    expect(normalizeMemorySearchParams({ query: 'x', limit: 999 })).toMatchObject({ limit: 50 });
    expect(normalizeMemorySearchParams({ query: 'x', limit: 0 })).toMatchObject({ limit: 1 });
  });

  it('非对象或 JSON 字符串输入：字符串对象解析后归一，其它原样透传', () => {
    expect(normalizeMemorySearchParams('{"query":"a"}')).toEqual({
      query: 'a',
      limit: 10,
      spaceId: 'all',
      mode: 'fast',
    });
    expect(normalizeMemorySearchParams(null)).toBeNull();
    expect(normalizeMemorySearchParams('plain')).toBe('plain');
  });
});

describe('search 双时间参数', () => {
  it('归一：四个日期键只在有值时产出，空串丢弃；不产出 schema 之外的键', () => {
    expect(
      normalizeMemorySearchParams({
        query: 'x',
        eventDateFrom: ' 2020 ',
        eventDateTo: '',
        recordedDateFrom: '2021-01',
      })
    ).toEqual({
      query: 'x',
      limit: 10,
      spaceId: 'all',
      mode: 'fast',
      eventDateFrom: '2020',
      recordedDateFrom: '2021-01',
    });
    expect(normalizeMemorySearchParams({ query: 'x', eventDateFrom: 2020 })).toEqual({
      query: 'x',
      limit: 10,
      spaceId: 'all',
      mode: 'fast',
    });
  });

  it('收窄：日期键必须是字符串；接受只带 event 或只带 recorded 的形状', () => {
    const base = { query: 'x', limit: 10, spaceId: 'all', mode: 'fast' as const };
    expect(
      parseMemorySearchRequest({
        query: 'x',
        limit: 10,
        spaceId: 'all',
        eventDateFrom: '2020',
        eventDateTo: '2021',
      })
    ).toEqual({ ...base, eventDateFrom: '2020', eventDateTo: '2021' });
    expect(
      parseMemorySearchRequest({ query: 'x', limit: 10, spaceId: 'all', recordedDateTo: '2021-06' })
    ).toEqual({
      ...base,
      recordedDateTo: '2021-06',
    });
    expect(parseMemorySearchRequest({ ...base, eventDateFrom: 2020 })).toBeNull();
    expect(parseMemorySearchRequest({ ...base, eventDateFrom: '' })).toBeNull();
  });
});

describe('normalizeMemoryCaptureParams', () => {
  it('unitType 只做 trim/小写透传，绝不产出 schema 之外的键（unitTypeSource 在 Main 派生）', () => {
    expect(normalizeMemoryCaptureParams({ content: 'c' })).not.toHaveProperty('unitType');
    expect(normalizeMemoryCaptureParams({ content: 'c' })).not.toHaveProperty('unitTypeSource');
    expect(normalizeMemoryCaptureParams({ content: 'c', unitType: 'insight' })).toMatchObject({
      unitType: 'insight',
    });
    expect(normalizeMemoryCaptureParams({ content: 'c', unitType: ' Decision ' })).toMatchObject({
      unitType: 'decision',
    });
  });

  it('importance 缺省 AGENT_CREATE_IMPORTANCE(0.6)，非法/越界回退缺省', () => {
    expect(normalizeMemoryCaptureParams({ content: 'c' })).toMatchObject({
      importance: AGENT_CREATE_IMPORTANCE,
    });
    expect(normalizeMemoryCaptureParams({ content: 'c', importance: '0.9' })).toMatchObject({
      importance: 0.9,
    });
    expect(normalizeMemoryCaptureParams({ content: 'c', importance: 7 })).toMatchObject({
      importance: AGENT_CREATE_IMPORTANCE,
    });
  });

  it('spaceId 缺省 project；空 title/eventEnd 丢弃', () => {
    expect(
      normalizeMemoryCaptureParams({ content: 'c', title: '  ', eventStart: '2020', eventEnd: '' })
    ).toEqual({
      content: 'c',
      importance: AGENT_CREATE_IMPORTANCE,
      spaceId: 'project',
      eventStart: '2020',
    });
  });
});

describe('capture 版本参数（force / evolvesFromId / evolvesRelation）', () => {
  it('归一：force 接受 boolean 或 "true"，关系小写，缺省不产出这三个键', () => {
    expect(normalizeMemoryCaptureParams({ content: 'c' })).not.toHaveProperty('force');
    expect(normalizeMemoryCaptureParams({ content: 'c', force: false })).not.toHaveProperty(
      'force'
    );
    expect(normalizeMemoryCaptureParams({ content: 'c', force: 'true' })).toMatchObject({
      force: true,
    });
    expect(
      normalizeMemoryCaptureParams({
        content: 'c',
        evolvesFromId: ' m1 ',
        evolvesRelation: ' Replaces ',
      })
    ).toMatchObject({ evolvesFromId: 'm1', evolvesRelation: 'replaces' });
  });

  it('收窄：关系必须在闭集，且与 evolvesFromId 成对；force 必须是 boolean', () => {
    const base = normalizeMemoryCaptureParams({ content: 'c' }) as object;
    expect(
      parseMemoryCaptureRequest({
        ...base,
        evolvesFromId: 'm1',
        evolvesRelation: 'challenges',
        force: true,
      })
    ).toMatchObject({ evolvesFromId: 'm1', evolvesRelation: 'challenges', force: true });
    expect(
      parseMemoryCaptureRequest({ ...base, evolvesRelation: 'supersedes', evolvesFromId: 'm1' })
    ).toBeNull();
    expect(parseMemoryCaptureRequest({ ...base, evolvesRelation: 'replaces' })).toBeNull();
    expect(parseMemoryCaptureRequest({ ...base, evolvesFromId: 'm1' })).toBeNull();
    expect(parseMemoryCaptureRequest({ ...base, force: 'true' })).toBeNull();
  });
});

describe('parse*Request（Main 侧 unknown 收窄）', () => {
  it('search：只接受归一后的完整形状', () => {
    expect(parseMemorySearchRequest({ query: 'q', limit: 5, spaceId: 'project' })).toEqual({
      query: 'q',
      limit: 5,
      spaceId: 'project',
      mode: 'fast',
    });
    expect(
      parseMemorySearchRequest({ query: 'q', limit: 5, spaceId: 'all', mode: 'deep' })
    ).toEqual({
      query: 'q',
      limit: 5,
      spaceId: 'all',
      mode: 'deep',
    });
    expect(
      parseMemorySearchRequest({ query: 'q', limit: 5, spaceId: 'all', mode: 'hyde' })
    ).toBeNull();
    expect(parseMemorySearchRequest({ query: '', limit: 5, spaceId: 'all' })).toBeNull();
    expect(parseMemorySearchRequest({ query: 'q', limit: 5 })).toBeNull();
    expect(parseMemorySearchRequest({ query: 'q', limit: 5, spaceId: 'all', x: 1 })).toBeNull();
  });

  it('安全边界：worker 直接指定 proj:<id> / 任意 space 一律拒绝，只认语义枚举', () => {
    expect(parseMemorySearchRequest({ query: 'q', limit: 5, spaceId: 'proj:other' })).toBeNull();
    expect(parseMemorySearchRequest({ query: 'q', limit: 5, spaceId: 'default' })).toBeNull();
    const cap = normalizeMemoryCaptureParams({ content: 'c' }) as Record<string, unknown>;
    expect(parseMemoryCaptureRequest({ ...cap, spaceId: 'proj:other' })).toBeNull();
    expect(parseMemoryCaptureRequest({ ...cap, spaceId: 'all' })).toBeNull();
    // 归一层也不放行：非法 space 回退缺省而不是透传
    expect(normalizeMemorySearchParams({ query: 'q', spaceId: 'proj:other' })).toMatchObject({
      spaceId: 'all',
    });
    expect(normalizeMemoryCaptureParams({ content: 'c', spaceId: 'proj:other' })).toMatchObject({
      spaceId: 'project',
    });
  });

  it('capture：Main 派生 unitTypeSource：缺省 default，非法 fallback→fact，合法 explicit', () => {
    const ok = normalizeMemoryCaptureParams({ content: 'c', title: 't' });
    expect(parseMemoryCaptureRequest(ok)).toEqual({
      ...(ok as object),
      unitType: 'fact',
      unitTypeSource: 'default',
    });
    expect(parseMemoryCaptureRequest({ ...(ok as object), unitType: 'bogus' })).toMatchObject({
      unitType: 'fact',
      unitTypeSource: 'fallback',
    });
    expect(parseMemoryCaptureRequest({ ...(ok as object), unitType: 'Plan' })).toMatchObject({
      unitType: 'plan',
      unitTypeSource: 'explicit',
    });
    // 派生字段不得从桥上透传：worker 无法伪造来源
    expect(
      parseMemoryCaptureRequest({ ...(ok as object), unitTypeSource: 'classifier' })
    ).toBeNull();
    expect(parseMemoryCaptureRequest({ ...(ok as object), content: '  ' })).toBeNull();
    expect(parseMemoryCaptureRequest({ ...(ok as object), importance: 2 })).toBeNull();
  });
});

describe('crystallize params', () => {
  it('normalize：sourceIds 接受数组 / JSON 字串 / 逗号分隔，去空白去重；force 字串化布尔；只产出 schema 内的键', () => {
    expect(
      normalizeMemoryCrystallizeParams({
        content: 'c',
        title: ' t ',
        sourceIds: [' a ', 'b', 'a', ''],
        force: 'true',
        junk: 1,
      })
    ).toEqual({ content: 'c', title: 't', sourceIds: ['a', 'b'], force: true });
    expect(
      normalizeMemoryCrystallizeParams({ content: 'c', title: 't', sourceIds: 'a, b ,c' })
    ).toEqual({ content: 'c', title: 't', sourceIds: ['a', 'b', 'c'] });
    expect(
      normalizeMemoryCrystallizeParams(
        '{"content":"c","title":"t","sourceIds":"[\\"a\\",\\"b\\"]"}'
      )
    ).toEqual({ content: 'c', title: 't', sourceIds: ['a', 'b'] });
    // 解析不出对象原样透传给 schema 报错
    expect(normalizeMemoryCrystallizeParams('nope')).toBe('nope');
  });

  it('parse：content/title 非空、sourceIds ≥ CRYSTAL_MIN_SOURCES 个非空字串，多余键拒绝', () => {
    const ok = { content: 'c', title: 't', sourceIds: ['a', 'b', 'c'] };
    expect(parseMemoryCrystallizeRequest(ok)).toEqual(ok);
    expect(parseMemoryCrystallizeRequest({ ...ok, force: true })).toEqual({ ...ok, force: true });
    for (const bad of [
      { ...ok, sourceIds: ['a', 'b'] },
      { ...ok, sourceIds: ['a', 'b', ''] },
      { ...ok, sourceIds: 'a,b,c' },
      { ...ok, title: ' ' },
      { ...ok, content: '' },
      { ...ok, force: 'true' },
      { ...ok, spaceId: 'global' },
      JSON.stringify(ok),
    ]) {
      expect(parseMemoryCrystallizeRequest(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(CRYSTAL_MIN_SOURCES).toBe(3);
  });
});

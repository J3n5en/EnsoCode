import { describe, expect, it } from 'vitest';
import { mergeStatusItems, parseStatusPatch } from './statusItems';

describe('状态项', () => {
  it('补丁只收已知字段，text 截到 24 字', () => {
    expect(parseStatusPatch({ text: '3 blocked', tone: 'warning', visible: false })).toEqual({
      text: '3 blocked',
      tone: 'warning',
      visible: false,
    });
    expect(parseStatusPatch({ text: 'a'.repeat(30) })).toEqual({ text: 'a'.repeat(24) });
    for (const bad of [null, [], { tone: 'red' }, { visible: 'no' }, { text: 1 }, { foo: 1 }])
      expect(parseStatusPatch(bad)).toBeNull();
  });

  it('清单声明打底，运行期补丁覆盖；没声明的 id 不出现', () => {
    const declared = [
      { id: 'a', text: 'idle', command: 'show' },
      { id: 'b', text: 'b' },
    ];
    expect(
      mergeStatusItems(declared, { a: { text: 'busy', tone: 'accent' }, ghost: { text: 'x' } })
    ).toEqual([
      { id: 'a', text: 'busy', tone: 'accent', visible: true, command: 'show' },
      { id: 'b', text: 'b', tone: 'neutral', visible: true },
    ]);
    expect(mergeStatusItems(declared, { b: { visible: false } })[1]?.visible).toBe(false);
  });
});

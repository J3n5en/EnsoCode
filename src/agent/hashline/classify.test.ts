import { describe, expect, it } from 'vitest';
import { classifyEditArgs } from './classify';

describe('classifyEditArgs', () => {
  it('识别 Hashline 补丁参数', () => {
    expect(classifyEditArgs({ input: 'PUT 1.=1:\n+x' })).toEqual({ kind: 'hashline' });
  });

  it('识别 edits 数组替换参数', () => {
    expect(classifyEditArgs({ path: '/a.ts', edits: [{ oldText: 'a', newText: 'b' }] })).toEqual({
      kind: 'replace',
    });
  });

  it('识别遗留的 oldText 与 newText 替换参数', () => {
    expect(classifyEditArgs({ oldText: 'a', newText: 'b' })).toEqual({ kind: 'replace' });
  });

  it('拒绝同时包含 input 与 edits 的混合参数', () => {
    expect(classifyEditArgs({ input: 'PUT...', edits: [{ oldText: 'a', newText: 'b' }] })).toEqual({
      kind: 'mixed',
    });
  });

  it('拒绝同时包含 input 与遗留替换字段的混合参数', () => {
    expect(classifyEditArgs({ input: 'PUT...', oldText: 'a', newText: 'b' })).toEqual({
      kind: 'mixed',
    });
  });

  it('把缺失或类型错误的形状归为无效参数', () => {
    const invalid = [
      null,
      42,
      {},
      { input: 42 },
      { input: '' },
      { edits: {} },
      { oldText: 'a' },
      { newText: 'b' },
    ];
    for (const value of invalid) expect(classifyEditArgs(value)).toEqual({ kind: 'invalid' });
  });
});

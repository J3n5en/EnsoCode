import { describe, expect, it } from 'vitest';
import { aggregateSessionChanges, reconstructOld } from './sessionChanges';

describe('reconstructOld', () => {
  it('逆序 undo 多块 edit', () => {
    expect(
      reconstructOld('hello world', [
        { oldText: 'hi', newText: 'hello' },
        { oldText: 'there', newText: 'world' },
      ])
    ).toBe('hi there');
  });

  it('当前内容对不上则失败', () => {
    expect(reconstructOld('nope', [{ oldText: 'a', newText: 'b' }])).toBeNull();
  });
});

describe('aggregateSessionChanges', () => {
  it('同一 path 多次 edit 合成一条，留下 old 快照', () => {
    const result = aggregateSessionChanges({
      tools: [
        {
          path: 'a.ts',
          edits: [{ oldText: 'one', newText: 'two' }],
          writeContent: null,
        },
        {
          path: 'a.ts',
          edits: [{ oldText: 'two', newText: 'three' }],
          writeContent: null,
        },
      ],
      snapshots: {},
      currentByPath: { 'a.ts': 'three' },
    });
    expect(result.files).toEqual([{ path: 'a.ts', oldText: 'one', newText: 'three' }]);
    expect(result.snapshots).toEqual({ 'a.ts': 'one' });
  });

  it('已有快照时 commit 后仍用快照作 old', () => {
    const result = aggregateSessionChanges({
      tools: [{ path: 'a.ts', edits: [{ oldText: 'one', newText: 'two' }], writeContent: null }],
      snapshots: { 'a.ts': 'one' },
      currentByPath: { 'a.ts': 'two' },
    });
    expect(result.files[0]).toEqual({ path: 'a.ts', oldText: 'one', newText: 'two' });
  });

  it('write 新文件 old 为空', () => {
    const result = aggregateSessionChanges({
      tools: [{ path: 'n.ts', edits: null, writeContent: 'export {}' }],
      snapshots: {},
      currentByPath: { 'n.ts': 'export {}' },
    });
    expect(result.files).toEqual([{ path: 'n.ts', oldText: '', newText: 'export {}' }]);
    expect(result.snapshots).toEqual({ 'n.ts': '' });
  });

  it('读盘失败且无法还原时跳过该文件', () => {
    const result = aggregateSessionChanges({
      tools: [{ path: 'gone.ts', edits: [{ oldText: 'a', newText: 'b' }], writeContent: null }],
      snapshots: {},
      currentByPath: { 'gone.ts': null },
    });
    expect(result.files).toEqual([]);
  });
});

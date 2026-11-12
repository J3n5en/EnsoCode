import { describe, expect, it } from 'vitest';
import { aggregateSessionChanges, reconstructOld, sameRecord, sameTools } from './sessionChanges';

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

  // 真实场景：newText 为空时 indexOf('') 恒为 0，被删的行会被插回文件开头，
  // Changes「Session」模式再把这份错误的 old 永久落盘。
  it('纯删除的 edit 无法定位删除位置时放弃还原，不把删掉的内容插到文件开头', () => {
    expect(reconstructOld('l1\nl2\nl4\n', [{ oldText: 'DEL\n', newText: '' }])).toBeNull();
  });

  // 删空整个文件时空串只有一个位置，还原结果是确定的，不应一并放弃
  it('删空整个文件的 edit 删除位置唯一，仍可还原', () => {
    expect(reconstructOld('', [{ oldText: 'all\n', newText: '' }])).toBe('all\n');
  });
});

describe('sameTools / sameRecord', () => {
  const edits = [{ oldText: 'a', newText: 'b' }];
  it('逐项 path/edits/writeContent 引用相同则视为未变', () => {
    const prev = [{ path: 'a.ts', edits, writeContent: null }];
    expect(sameTools(prev, [{ path: 'a.ts', edits, writeContent: null }])).toBe(true);
    expect(sameTools(prev, [{ path: 'a.ts', edits: [...edits], writeContent: null }])).toBe(false);
    expect(sameTools(prev, [])).toBe(false);
    expect(sameTools(prev, [{ path: 'b.ts', edits, writeContent: null }])).toBe(false);
  });

  it('sameRecord 比较键集与值', () => {
    expect(sameRecord({ a: 'x', b: null }, { a: 'x', b: null })).toBe(true);
    expect(sameRecord({ a: 'x' }, { a: 'y' })).toBe(false);
    expect(sameRecord({ a: 'x' }, { a: 'x', b: 'y' })).toBe(false);
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

  // 真实场景：纯删除的 edit 被还原到文件开头后，错误快照经 saveSnapshots 永久落盘
  it('纯删除 edit 无法还原时不写入错误的 Session 快照', () => {
    const result = aggregateSessionChanges({
      tools: [{ path: 'a.ts', edits: [{ oldText: 'DEL\n', newText: '' }], writeContent: null }],
      snapshots: {},
      currentByPath: { 'a.ts': 'l1\nl2\nl4\n' },
    });
    expect(result.snapshots).toEqual({});
  });

  it('读盘失败且无法还原时跳过该文件', () => {
    const result = aggregateSessionChanges({
      tools: [{ path: 'gone.ts', edits: [{ oldText: 'a', newText: 'b' }], writeContent: null }],
      snapshots: {},
      currentByPath: { 'gone.ts': null },
    });
    expect(result.files).toEqual([]);
  });

  it('apply_patch 多文件按各自完整历史聚合，不把 blocks 串到同一路径', () => {
    const result = aggregateSessionChanges({
      tools: [
        {
          path: 'a.ts',
          edits: null,
          writeContent: null,
          fileChange: { path: 'a.ts', oldText: 'a0', newText: 'a1', type: 'update' },
        },
        {
          path: 'b.ts',
          edits: null,
          writeContent: null,
          fileChange: { path: 'b.ts', oldText: 'b0', newText: 'b1', type: 'update' },
        },
      ],
      snapshots: {},
      currentByPath: { 'a.ts': 'a1', 'b.ts': 'b1' },
    });
    expect(result.files).toEqual([
      { path: 'a.ts', oldText: 'a0', newText: 'a1' },
      { path: 'b.ts', oldText: 'b0', newText: 'b1' },
    ]);
    expect(result.snapshots).toEqual({ 'a.ts': 'a0', 'b.ts': 'b0' });
  });

  it('move 展开的源 delete 与目标 add 都展示，删除读不到时回退历史 newText', () => {
    const result = aggregateSessionChanges({
      tools: [
        {
          path: 'old.ts',
          edits: null,
          writeContent: null,
          fileChange: { path: 'old.ts', oldText: 'source', newText: '', type: 'delete' },
        },
        {
          path: 'new.ts',
          edits: null,
          writeContent: null,
          fileChange: { path: 'new.ts', oldText: '', newText: 'source', type: 'add' },
        },
      ],
      snapshots: {},
      currentByPath: { 'old.ts': null, 'new.ts': 'source' },
    });
    expect(result.files).toEqual([
      { path: 'old.ts', oldText: 'source', newText: '' },
      { path: 'new.ts', oldText: '', newText: 'source' },
    ]);
  });

  it('move 目标写成但源删除失败时，只聚合实际目标 add', () => {
    const result = aggregateSessionChanges({
      tools: [
        {
          path: 'new.ts',
          edits: null,
          writeContent: null,
          fileChange: { path: 'new.ts', oldText: '', newText: 'source', type: 'add' },
        },
      ],
      snapshots: {},
      currentByPath: { 'new.ts': 'source' },
    });
    expect(result.files).toEqual([{ path: 'new.ts', oldText: '', newText: 'source' }]);
    expect(result.files.some((file) => file.path === 'old.ts')).toBe(false);
  });

  it('空文件 add/delete 仍保留操作事实，不因 oldText===newText 丢弃', () => {
    const result = aggregateSessionChanges({
      tools: [
        {
          path: 'empty-added.ts',
          edits: null,
          writeContent: null,
          fileChange: { path: 'empty-added.ts', oldText: '', newText: '', type: 'add' },
        },
        {
          path: 'empty-deleted.ts',
          edits: null,
          writeContent: null,
          fileChange: { path: 'empty-deleted.ts', oldText: '', newText: '', type: 'delete' },
        },
      ],
      snapshots: {},
      currentByPath: { 'empty-added.ts': '', 'empty-deleted.ts': null },
    });
    expect(result.files.map((file) => file.path)).toEqual(['empty-added.ts', 'empty-deleted.ts']);
  });

  it('truncated 预览不作为完整 snapshot 聚合，也不污染持久快照', () => {
    const result = aggregateSessionChanges({
      tools: [
        {
          path: 'large.ts',
          edits: null,
          writeContent: null,
          fileChange: {
            path: 'large.ts',
            oldText: 'partial-old…',
            newText: 'partial-new…',
            type: 'update',
            truncated: true,
          },
        },
      ],
      snapshots: {},
      currentByPath: { 'large.ts': 'current full text' },
    });
    expect(result).toEqual({
      files: [],
      snapshots: { 'large.ts': null },
      incompletePaths: ['large.ts'],
    });
  });

  it('首次 truncated 后的完整 fileChange 也不能把中途 oldText 冒充会话初始快照', () => {
    const result = aggregateSessionChanges({
      tools: [
        {
          path: 'large.ts',
          edits: null,
          writeContent: null,
          fileChange: { path: 'large.ts', oldText: 'middle', newText: 'final', type: 'update' },
        },
      ],
      snapshots: { 'large.ts': null },
      currentByPath: { 'large.ts': 'final' },
    });
    expect(result).toEqual({
      files: [],
      snapshots: { 'large.ts': null },
      incompletePaths: ['large.ts'],
    });
  });

  it('unknown baseline 后的 legacy edit/write 也不能覆盖 null 或伪造初始快照', () => {
    const result = aggregateSessionChanges({
      tools: [
        {
          path: 'large.ts',
          edits: [{ oldText: 'middle', newText: 'edited' }],
          writeContent: null,
        },
        { path: 'large.ts', edits: null, writeContent: 'written' },
      ],
      snapshots: { 'large.ts': null },
      currentByPath: { 'large.ts': 'written' },
    });
    expect(result).toEqual({
      files: [],
      snapshots: { 'large.ts': null },
      incompletePaths: ['large.ts'],
    });
  });

  it('历史工具被压缩/驱逐后仍从持久 unknown marker 展示不完整路径', () => {
    expect(
      aggregateSessionChanges({
        tools: [],
        snapshots: { 'large.ts': null },
        currentByPath: {},
      })
    ).toEqual({
      files: [],
      snapshots: { 'large.ts': null },
      incompletePaths: ['large.ts'],
    });
  });

  it('已有可靠 snapshot 但末次 truncated 且当前全文不可读时仍显示不完整路径', () => {
    const result = aggregateSessionChanges({
      tools: [
        {
          path: 'a.ts',
          edits: null,
          writeContent: null,
          fileChange: {
            path: 'a.ts',
            oldText: 'old',
            newText: 'new\n…',
            type: 'update',
            truncated: true,
          },
        },
      ],
      snapshots: { 'a.ts': 'old' },
      currentByPath: { 'a.ts': null },
    });
    expect(result).toEqual({
      files: [],
      snapshots: { 'a.ts': 'old' },
      incompletePaths: ['a.ts'],
    });
  });

  it('truncated 路径已有可靠 snapshot 时，只用 snapshot 与当前全文聚合', () => {
    const result = aggregateSessionChanges({
      tools: [
        {
          path: 'large.ts',
          edits: null,
          writeContent: null,
          fileChange: {
            path: 'large.ts',
            oldText: 'partial-old…',
            newText: 'partial-new…',
            type: 'update',
            truncated: true,
          },
        },
      ],
      snapshots: { 'large.ts': 'trusted original' },
      currentByPath: { 'large.ts': 'trusted current' },
    });
    expect(result.files).toEqual([
      { path: 'large.ts', oldText: 'trusted original', newText: 'trusted current' },
    ]);
    expect(result.snapshots).toEqual({ 'large.ts': 'trusted original' });
  });
});

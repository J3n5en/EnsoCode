import { describe, expect, it } from 'vitest';
import { normalizeEditArguments } from './editTool';

const block = { oldText: 'a', newText: 'b' };

describe('normalizeEditArguments', () => {
  it('完整 JSON 字符串 edits 还原为对象数组', () => {
    expect(normalizeEditArguments({ path: 'f.ts', edits: JSON.stringify([block]) })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('双重编码 JSON 字符串递归 unwrap', () => {
    const encoded = JSON.stringify(JSON.stringify([block]));
    expect(normalizeEditArguments({ path: 'f.ts', edits: encoded })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('数组元素是对象 JSON 字符串时逐项 parse', () => {
    expect(normalizeEditArguments({ path: 'f.ts', edits: [JSON.stringify(block)] })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('单个 {oldText,newText} 包成一元素数组', () => {
    expect(normalizeEditArguments({ path: 'f.ts', edits: block })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('截断 JSON 字符串原样留下，不假装成功', () => {
    const truncated = '[{"oldText": "foo"';
    expect(normalizeEditArguments({ path: 'f.ts', edits: truncated })).toEqual({
      path: 'f.ts',
      edits: truncated,
    });
  });

  it('已合法的 edits 数组不改写', () => {
    const input = { path: 'f.ts', edits: [block] };
    expect(normalizeEditArguments(input)).toEqual(input);
  });

  it('非对象入参原样返回', () => {
    expect(normalizeEditArguments(null)).toBeNull();
    expect(normalizeEditArguments('x')).toBe('x');
  });
});

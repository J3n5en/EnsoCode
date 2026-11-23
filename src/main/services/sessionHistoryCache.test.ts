import { describe, expect, it, vi } from 'vitest';
import { createFileMemo } from './sessionHistoryCache';

function setup(options: { maxBytes?: number; maxEntries?: number } = {}) {
  const files = new Map<string, { mtimeMs: number; size: number }>();
  const load = vi.fn((file: string) => `${file}@${files.get(file)?.mtimeMs}`);
  const inner = createFileMemo<string>({
    stat: (file) => files.get(file) ?? null,
    idleMs: 1000,
    ...options,
  });
  const memo = {
    get: (file: string, key: string) => inner.get(file, key, load),
    clear: inner.clear,
  };
  return { files, load, memo };
}

describe('createFileMemo', () => {
  it('文件未变时复用解析结果', () => {
    const { files, load, memo } = setup();
    files.set('a', { mtimeMs: 1, size: 10 });
    expect(memo.get('a', 'k')).toBe('a@1');
    expect(memo.get('a', 'k')).toBe('a@1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('文件追加或改写后重新解析', () => {
    const { files, load, memo } = setup();
    files.set('a', { mtimeMs: 1, size: 10 });
    memo.get('a', 'k');
    files.set('a', { mtimeMs: 2, size: 20 });
    expect(memo.get('a', 'k')).toBe('a@2');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('同一文件不同投影口径分开缓存', () => {
    const { files, load, memo } = setup();
    files.set('a', { mtimeMs: 1, size: 10 });
    memo.get('a', 'plain');
    memo.get('a', 'ids');
    memo.get('a', 'plain');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('超过条数或字节预算时淘汰最久未用的', () => {
    const { files, load, memo } = setup({ maxEntries: 2, maxBytes: 100 });
    for (const f of ['a', 'b', 'c']) files.set(f, { mtimeMs: 1, size: 10 });
    memo.get('a', 'k');
    memo.get('b', 'k');
    memo.get('a', 'k');
    memo.get('c', 'k');
    memo.get('a', 'k');
    expect(load).toHaveBeenCalledTimes(3);
    memo.get('b', 'k');
    expect(load).toHaveBeenCalledTimes(4);

    files.set('big', { mtimeMs: 1, size: 80 });
    memo.get('big', 'k');
    memo.get('b', 'k');
    expect(load).toHaveBeenCalledTimes(5);
    memo.get('a', 'k');
    expect(load).toHaveBeenCalledTimes(6);
  });

  it('单个文件超出预算不缓存；文件读不到不缓存', () => {
    const { files, load, memo } = setup({ maxBytes: 50 });
    files.set('huge', { mtimeMs: 1, size: 60 });
    memo.get('huge', 'k');
    memo.get('huge', 'k');
    expect(load).toHaveBeenCalledTimes(2);
    memo.get('gone', 'k');
    memo.get('gone', 'k');
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('解析失败不缓存，异常照常抛给调用方', () => {
    const { files, load, memo } = setup();
    files.set('a', { mtimeMs: 1, size: 10 });
    load.mockImplementationOnce(() => {
      throw new Error('bad');
    });
    expect(() => memo.get('a', 'k')).toThrow('bad');
    expect(memo.get('a', 'k')).toBe('a@1');
  });

  it('空闲一段时间后自动释放', () => {
    vi.useFakeTimers();
    try {
      const { files, load, memo } = setup();
      files.set('a', { mtimeMs: 1, size: 10 });
      memo.get('a', 'k');
      vi.advanceTimersByTime(900);
      memo.get('a', 'k');
      vi.advanceTimersByTime(900);
      memo.get('a', 'k');
      expect(load).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1001);
      memo.get('a', 'k');
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear 释放全部缓存', () => {
    const { files, load, memo } = setup();
    files.set('a', { mtimeMs: 1, size: 10 });
    memo.get('a', 'k');
    memo.clear();
    memo.get('a', 'k');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

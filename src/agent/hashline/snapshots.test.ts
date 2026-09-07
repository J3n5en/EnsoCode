import { describe, expect, it } from 'vitest';
import { computeFileHash } from './format';
import { InMemorySnapshotStore } from './snapshots';

describe('InMemorySnapshotStore', () => {
  it('record 返回文件内容对应的 4 位哈希标签', () => {
    const store = new InMemorySnapshotStore();
    expect(store.record('/tmp/a.ts', 'alpha\n')).toBe(computeFileHash('alpha\n'));
  });

  it('可按路径和标签取回记录时的文本', () => {
    const store = new InMemorySnapshotStore();
    const tag = store.record('/tmp/a.ts', 'alpha\n');
    expect(store.get('/tmp/a.ts', tag)).toBe('alpha\n');
  });

  it('同一路径的归一化内容相同时合并为同一标签', () => {
    const store = new InMemorySnapshotStore();
    const first = store.record('/tmp/a.ts', 'alpha \t\r\nbeta\r');
    expect(store.record('/tmp/a.ts', 'alpha\nbeta')).toBe(first);
  });

  it('同一路径内容变化时保留新旧两个快照', () => {
    const store = new InMemorySnapshotStore();
    const first = store.record('/tmp/a.ts', 'alpha\n');
    const second = store.record('/tmp/a.ts', 'beta\n');
    expect(second).not.toBe(first);
    expect(store.get('/tmp/a.ts', first)).toBe('alpha\n');
    expect(store.get('/tmp/a.ts', second)).toBe('beta\n');
  });

  it('未知标签没有对应快照', () => {
    expect(new InMemorySnapshotStore().get('/tmp/a.ts', 'FFFF')).toBeUndefined();
  });
});

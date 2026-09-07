import { describe, expect, it } from 'vitest';
import { applyHashlineToText } from './apply';
import { computeFileHash } from './format';
import { assertFreshSnapshot } from './guard';
import { InMemorySnapshotStore } from './snapshots';

describe('assertFreshSnapshot', () => {
  it('标签未在该路径记录时拒绝写入', () => {
    const store = new InMemorySnapshotStore();
    expect(() =>
      assertFreshSnapshot(store, '/tmp/a.ts', computeFileHash('live\n'), 'live\n')
    ).toThrow();
  });

  it('磁盘内容已偏离标签时拒绝写入', () => {
    const store = new InMemorySnapshotStore();
    const tag = store.record('/tmp/a.ts', 'old\n');
    expect(() => assertFreshSnapshot(store, '/tmp/a.ts', tag, 'changed\n')).toThrow();
  });

  it('路径、标签和磁盘内容一致时允许写入', () => {
    const store = new InMemorySnapshotStore();
    const tag = store.record('/tmp/a.ts', 'current\n');
    expect(() => assertFreshSnapshot(store, '/tmp/a.ts', tag, 'current\n')).not.toThrow();
  });
});

describe('无 BlockResolver 的块锚点', () => {
  it('拒绝 N* 块替换而不猜测范围', () => {
    expect(() => applyHashlineToText('fn() {\n  x\n}\n', 'PUT 1*:\n+replaced')).toThrow();
  });
});

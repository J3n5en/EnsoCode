import { describe, expect, it, vi } from 'vitest';
import { applyHashlineToFile } from './applyToFile';
import { computeFileHash, formatHashlineHeader } from './format';
import { InMemorySnapshotStore } from './snapshots';

const inputFor = (path: string, tag: string) =>
  `${formatHashlineHeader(path, tag)}\nPUT 1.=1:\n+hello`;

describe('applyHashlineToFile', () => {
  it('快照与磁盘一致时写入补丁、记录新标签并返回结果', async () => {
    const path = '/tmp/a.ts';
    const original = 'world\nlater\n';
    const next = 'hello\nlater\n';
    const store = new InMemorySnapshotStore();
    const tag = store.record(path, original);
    const writeText = vi.fn(async () => undefined);
    const result = await applyHashlineToFile({
      store,
      readText: async () => original,
      writeText,
      input: inputFor(path, tag),
    });
    expect(writeText).toHaveBeenCalledWith(path, next);
    expect(store.get(path, computeFileHash(next))).toBe(next);
    expect(result).toEqual({ path, text: next, tag: computeFileHash(next) });
  });

  it('缺少文件头时拒绝且不写入', async () => {
    const writeText = vi.fn(async () => undefined);
    await expect(
      applyHashlineToFile({
        store: new InMemorySnapshotStore(),
        readText: async () => 'world\n',
        writeText,
        input: 'PUT 1.=1:\n+hello',
      })
    ).rejects.toThrow();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('标签未记录时拒绝且不写入', async () => {
    const writeText = vi.fn(async () => undefined);
    const live = 'world\n';
    await expect(
      applyHashlineToFile({
        store: new InMemorySnapshotStore(),
        readText: async () => live,
        writeText,
        input: inputFor('/tmp/a.ts', computeFileHash(live)),
      })
    ).rejects.toThrow();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('磁盘内容已偏离已记录标签时拒绝且不写入', async () => {
    const path = '/tmp/a.ts';
    const store = new InMemorySnapshotStore();
    const tag = store.record(path, 'old\n');
    const writeText = vi.fn(async () => undefined);
    await expect(
      applyHashlineToFile({
        store,
        readText: async () => 'changed\n',
        writeText,
        input: inputFor(path, tag),
      })
    ).rejects.toThrow();
    expect(writeText).not.toHaveBeenCalled();
  });
});

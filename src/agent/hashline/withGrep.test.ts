import { describe, expect, it, vi } from 'vitest';
import { computeFileHash, formatHashlineHeader } from './format';
import { InMemorySnapshotStore } from './snapshots';
import { withHashlineGrep } from './withGrep';

const fakeGrep = (text: string) => ({
  name: 'grep',
  async execute(_id: string, _params: unknown) {
    return { content: [{ type: 'text', text }] };
  },
});

describe('withHashlineGrep', () => {
  it('命中文件时记录完整文本并在结果中加入标签文件头', async () => {
    const path = 'src/a.ts';
    const body = 'first\nmatch line\n';
    const store = new InMemorySnapshotStore();
    const readFileText = vi.fn(async () => body);
    const grep = withHashlineGrep(fakeGrep(`${path}:2:match line`), store, readFileText);
    const result = await grep.execute('call-1', { pattern: 'match' });
    const visible = result.content[0]?.text ?? '';
    expect(readFileText).toHaveBeenCalledWith(path);
    expect(store.get(path, computeFileHash(body))).toBe(body);
    expect(visible).toContain(formatHashlineHeader(path, computeFileHash(body)));
  });

  it('空结果与无匹配提示都不读取或记录文件', async () => {
    const store = new InMemorySnapshotStore();
    const record = vi.spyOn(store, 'record');
    const readFileText = vi.fn(async () => 'unused');
    await withHashlineGrep(fakeGrep(''), store, readFileText).execute('call-2', {});
    await withHashlineGrep(fakeGrep('No matches found'), store, readFileText).execute('call-3', {});
    expect(readFileText).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('命中文件不可读时保留无标签结果且不让整个 grep 失败', async () => {
    const path = 'src/missing.ts';
    const output = `${path}:3:match line`;
    const store = new InMemorySnapshotStore();
    const record = vi.spyOn(store, 'record');
    const grep = withHashlineGrep(fakeGrep(output), store, async () => undefined);
    await expect(grep.execute('call-4', {})).resolves.toEqual({
      content: [{ type: 'text', text: output }],
    });
    expect(record).not.toHaveBeenCalled();
  });
});

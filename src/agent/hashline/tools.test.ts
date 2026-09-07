import { describe, expect, it, vi } from 'vitest';
import { computeFileHash } from './format';
import { InMemorySnapshotStore } from './snapshots';
import { selectHashlineTools } from './tools';

const setup = (enabled: boolean) => {
  const store = new InMemorySnapshotStore();
  const read = {
    name: 'read',
    execute: vi.fn(async () => ({ content: [{ type: 'text', text: 'alpha\n' }] })),
  };
  const grep = {
    name: 'grep',
    execute: vi.fn(async () => ({ content: [{ type: 'text', text: '' }] })),
  };
  const edit = { name: 'edit', execute: vi.fn(async () => 'stock-result') };
  const selected = selectHashlineTools({ enabled, store, read, grep, edit });
  return { store, read, grep, edit, selected };
};

describe('selectHashlineTools', () => {
  it('关闭时原样返回三个 stock 工具', () => {
    const { read, grep, edit, selected } = setup(false);
    expect(selected.read).toBe(read);
    expect(selected.grep).toBe(grep);
    expect(selected.edit).toBe(edit);
  });

  it('开启时包装 read；未提供文件读取器时 grep 保持 stock', async () => {
    const { store, read, grep, selected } = setup(true);
    expect(selected.read).not.toBe(read);
    expect(selected.grep).toBe(grep);
    await selected.read.execute('call-1', { path: '/tmp/a.ts' });
    expect(store.get('/tmp/a.ts', computeFileHash('alpha\n'))).toBe('alpha\n');
  });

  it('开启后 replace 参数仍交给 stock edit', async () => {
    const { edit, selected } = setup(true);
    const params = { path: '/tmp/a.ts', edits: [{ oldText: 'a', newText: 'b' }] };
    await expect(selected.edit.execute('call-2', params)).resolves.toBe('stock-result');
    expect(edit.execute).toHaveBeenCalledOnce();
  });

  it('开启后混合参数直接拒绝且不调用 stock edit', async () => {
    const { edit, selected } = setup(true);
    await expect(selected.edit.execute('call-3', { input: 'PUT...', edits: [] })).rejects.toThrow();
    expect(edit.execute).not.toHaveBeenCalled();
  });

  it('开启后无快照文件头的 Hashline 参数拒绝且不调用 stock edit', async () => {
    const { edit, selected } = setup(true);
    await expect(selected.edit.execute('call-4', { input: 'PUT 1.=1:\n+x' })).rejects.toThrow();
    expect(edit.execute).not.toHaveBeenCalled();
  });
});

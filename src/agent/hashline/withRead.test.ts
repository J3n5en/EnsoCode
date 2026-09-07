import { describe, expect, it, vi } from 'vitest';
import { computeFileHash, formatHashlineHeader } from './format';
import { InMemorySnapshotStore } from './snapshots';
import { withHashlineRead } from './withRead';

const fakeRead = (content: Array<{ type: string; text?: string; data?: string }>) => ({
  name: 'read',
  async execute(_id: string, _params: unknown) {
    return { content };
  },
});

describe('withHashlineRead', () => {
  it('文本文件读取成功后记录快照并加入文件头与行号', async () => {
    const path = '/tmp/a.ts';
    const body = 'alpha\nbeta\n';
    const store = new InMemorySnapshotStore();
    const read = withHashlineRead(fakeRead([{ type: 'text', text: body }]), store);
    const result = await read.execute('call-1', { path });
    const visible = result.content[0]?.text ?? '';
    expect(store.get(path, computeFileHash(body))).toBe(body);
    expect(visible).toContain(formatHashlineHeader(path, computeFileHash(body)));
    expect(visible).toContain('1:alpha');
    expect(visible).toContain('2:beta');
  });

  it('不记录 agent 虚拟路径', async () => {
    const store = new InMemorySnapshotStore();
    const record = vi.spyOn(store, 'record');
    await withHashlineRead(fakeRead([{ type: 'text', text: 'yield' }]), store).execute('call-2', {
      path: 'agent://x',
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('不记录图片结果', async () => {
    const store = new InMemorySnapshotStore();
    const record = vi.spyOn(store, 'record');
    await withHashlineRead(fakeRead([{ type: 'image', data: 'base64' }]), store).execute('call-3', {
      path: '/tmp/a.png',
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('结果缺少文本内容时不记录', async () => {
    const store = new InMemorySnapshotStore();
    const record = vi.spyOn(store, 'record');
    await withHashlineRead(fakeRead([]), store).execute('call-4', { path: '/tmp/empty' });
    expect(record).not.toHaveBeenCalled();
  });
});

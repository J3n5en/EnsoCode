import { describe, expect, it, vi } from 'vitest';
import { computeFileHash, formatHashlineHeader } from './format';
import { InMemorySnapshotStore } from './snapshots';
import { withHashlineWrite } from './withWrite';

const stockWrite = (result: object = { content: [{ type: 'text', text: 'Wrote file' }] }) => ({
  name: 'write',
  execute: vi.fn(async (_id: string, _params: unknown) => result),
});

describe('withHashlineWrite', () => {
  it('文本写入成功后按 params.content 记录快照，并把结果改成 `[path#TAG]` + 编号行', async () => {
    const path = '/tmp/a.ts';
    const body = 'alpha\nbeta\n';
    const store = new InMemorySnapshotStore();
    const wrapped = withHashlineWrite(stockWrite(), store);
    const result = await wrapped.execute('call-1', { path, content: body });
    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(store.get(path, computeFileHash(body))).toBe(body);
    expect(text).toContain(formatHashlineHeader(path, computeFileHash(body)));
    expect(text).toMatch(/1:alpha\n2:beta/);
  });

  it('isError 结果不记录', async () => {
    const result = { isError: true, content: [{ type: 'text', text: 'fail' }] };
    const store = new InMemorySnapshotStore();
    const record = vi.spyOn(store, 'record');
    const actual = await withHashlineWrite(stockWrite(result), store).execute('call-2', {
      path: '/tmp/a.ts',
      content: 'x',
    });
    expect(record).not.toHaveBeenCalled();
    expect(actual).toBe(result);
  });

  it('缺少 path 或 content 时不记录', async () => {
    const store = new InMemorySnapshotStore();
    const record = vi.spyOn(store, 'record');
    const wrapped = withHashlineWrite(stockWrite(), store);
    await wrapped.execute('call-3', { content: 'x' });
    await wrapped.execute('call-4', { path: '/tmp/a.ts' });
    expect(record).not.toHaveBeenCalled();
  });

  it('不记录 agent 虚拟路径', async () => {
    const store = new InMemorySnapshotStore();
    const record = vi.spyOn(store, 'record');
    await withHashlineWrite(stockWrite(), store).execute('call-5', {
      path: 'agent://x',
      content: 'yield',
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('追加命名 write 的 Hashline 指南并保留 stock 指南', () => {
    const wrapped = withHashlineWrite(
      { ...stockWrite(), promptGuidelines: ['Write complete files'] },
      new InMemorySnapshotStore()
    );
    expect(wrapped.promptGuidelines).toContain('Write complete files');
    const text = wrapped.promptGuidelines.join('\n');
    expect(text).toMatch(/\bwrite\b/i);
    expect(text).toMatch(/\[path#TAG\]/i);
  });
});

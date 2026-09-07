import { describe, expect, it, vi } from 'vitest';
import type { HashlineIo } from './io';
import { applyHashlineSessionTools } from './sessionTools';
import { InMemorySnapshotStore } from './snapshots';
import { HASHLINE_EDIT_PARAMETERS } from './tools';

const fakeTool = (name: string, text = '') => ({
  name,
  parameters: { type: 'object', properties: {} },
  execute: vi.fn(async (_id: string, _params: unknown) => ({
    content: [{ type: 'text', text }],
  })),
});

const fakeIo = (body = 'world\n'): HashlineIo => ({
  readText: vi.fn(async () => body),
  writeText: vi.fn(async () => undefined),
  readFileText: vi.fn(async () => body),
});

describe('applyHashlineSessionTools', () => {
  it('关闭时仅应用 outer read，grep/edit 保持 stock 身份', () => {
    const read = fakeTool('read');
    const grep = fakeTool('grep');
    const edit = fakeTool('edit');
    const wrapOuterRead = vi.fn((def: typeof read) => ({ ...def, outer: true }));
    const result = applyHashlineSessionTools({
      enabled: false,
      store: new InMemorySnapshotStore(),
      io: fakeIo(),
      read,
      grep,
      edit,
      wrapOuterRead,
    });
    expect((result.read as typeof read & { outer?: boolean }).outer).toBe(true);
    expect(wrapOuterRead).toHaveBeenCalledWith(read);
    expect(result.grep).toBe(grep);
    expect(result.edit).toBe(edit);
  });

  it('开启时按 outer(hashline(read)) 包装并让 Hashline edit 写入 IO', async () => {
    const path = '/tmp/a.ts';
    const body = 'world\n';
    const store = new InMemorySnapshotStore();
    const io = fakeIo(body);
    const read = fakeTool('read', body);
    const grep = fakeTool('grep');
    const edit = fakeTool('edit');
    const wrapOuterRead = vi.fn((def: typeof read) => ({ ...def, outer: true }));
    const result = applyHashlineSessionTools({
      enabled: true,
      store,
      io,
      read,
      grep,
      edit,
      wrapOuterRead,
    });
    expect((result.read as typeof read & { outer?: boolean }).outer).toBe(true);
    expect(wrapOuterRead.mock.calls[0]?.[0]).not.toBe(read);
    expect(result.grep).not.toBe(grep);
    expect(result.edit?.parameters).toBe(HASHLINE_EDIT_PARAMETERS);
    const tag = store.record(path, body);
    await result.edit?.execute('call-edit', { input: `[${path}#${tag}]\nPUT 1.=1:\n+hello` });
    expect(io.writeText).toHaveBeenCalledWith(path, 'hello\n');
    expect(edit.execute).not.toHaveBeenCalled();
  });

  it('开启且无 edit 时保持只读并仍包装 read', () => {
    const read = fakeTool('read');
    const wrapOuterRead = vi.fn((def: typeof read) => ({ ...def, outer: true }));
    const result = applyHashlineSessionTools({
      enabled: true,
      store: new InMemorySnapshotStore(),
      io: fakeIo(),
      read,
      grep: fakeTool('grep'),
      wrapOuterRead,
    });
    expect(result.edit).toBeUndefined();
    expect((result.read as typeof read & { outer?: boolean }).outer).toBe(true);
    expect(wrapOuterRead.mock.calls[0]?.[0]).not.toBe(read);
  });
});

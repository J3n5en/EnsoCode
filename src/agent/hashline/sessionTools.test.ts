import { describe, expect, it, vi } from 'vitest';
import { computeFileHash, formatHashlineHeader } from './format';
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
    const readGuidelines = ['stock read'];
    const grepGuidelines = ['stock grep'];
    const editGuidelines = ['stock edit'];
    const read = { ...fakeTool('read'), promptGuidelines: readGuidelines };
    const grep = { ...fakeTool('grep'), promptGuidelines: grepGuidelines };
    const edit = { ...fakeTool('edit'), promptGuidelines: editGuidelines };
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
    expect(result.read.promptGuidelines).toBe(readGuidelines);
    expect(result.grep.promptGuidelines).toBe(grepGuidelines);
    expect(result.edit?.promptGuidelines).toBe(editGuidelines);
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

  it('关闭时 write 保持 stock 身份', () => {
    const guidelines = ['stock write'];
    const write = { ...fakeTool('write', 'Wrote file'), promptGuidelines: guidelines };
    const result = applyHashlineSessionTools({
      enabled: false,
      store: new InMemorySnapshotStore(),
      io: fakeIo(),
      read: fakeTool('read'),
      grep: fakeTool('grep'),
      write,
    });
    expect(result.write).toBe(write);
    expect((result.write as typeof write | undefined)?.promptGuidelines).toBe(guidelines);
  });

  it('开启时包装 write，按 content 记账并回写 `[path#TAG]`', async () => {
    const path = '/tmp/a.ts';
    const body = 'world\n';
    const store = new InMemorySnapshotStore();
    const write = fakeTool('write', 'Wrote file');
    const result = applyHashlineSessionTools({
      enabled: true,
      store,
      io: fakeIo(),
      read: fakeTool('read'),
      grep: fakeTool('grep'),
      write,
    });
    const writeResult = await result.write?.execute('call-write', { path, content: body });
    expect(store.get(path, computeFileHash(body))).toBe(body);
    expect((writeResult as { content: [{ text: string }] }).content[0].text).toContain(
      formatHashlineHeader(path, computeFileHash(body))
    );
    expect(write.execute).toHaveBeenCalled();
  });

  it('开启且无 write 时保持只读', () => {
    const result = applyHashlineSessionTools({
      enabled: true,
      store: new InMemorySnapshotStore(),
      io: fakeIo(),
      read: fakeTool('read'),
      grep: fakeTool('grep'),
    });
    expect(result.write).toBeUndefined();
    expect(result.edit).toBeUndefined();
  });
});

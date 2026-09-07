import { describe, expect, it, vi } from 'vitest';
import { normalizeEditArguments } from '../editTool';
import { computeFileHash } from './format';
import { InMemorySnapshotStore } from './snapshots';
import { HASHLINE_EDIT_PARAMETERS, selectHashlineTools, wrapHashlineEditDefinition } from './tools';
import { withHashlineGrep } from './withGrep';
import { withHashlineRead } from './withRead';

type FakeTool = {
  name: string;
  execute: (id?: string, params?: unknown) => unknown;
};

const setup = (enabled: boolean) => {
  const store = new InMemorySnapshotStore();
  const read = {
    name: 'read',
    execute: vi.fn(async (_id?: string, _params?: unknown) => ({
      content: [{ type: 'text', text: 'alpha\n' }],
    })),
  };
  const grep = {
    name: 'grep',
    execute: vi.fn(async (_id?: string, _params?: unknown) => ({
      content: [{ type: 'text', text: '' }],
    })),
  };
  const edit = {
    name: 'edit',
    execute: vi.fn(async (_id?: string, _params?: unknown) => 'stock-result'),
  };
  const selected = selectHashlineTools<FakeTool>({ enabled, store, read, grep, edit });
  return { store, read, grep, edit, selected };
};

const wrappedFixture = (body = 'world\n') => {
  const stock = {
    name: 'edit',
    parameters: { type: 'object', properties: {}, required: ['path', 'edits'] },
    prepareArguments: normalizeEditArguments,
    execute: vi.fn(async (_id: string, _params: unknown) => 'stock-result'),
  };
  const store = new InMemorySnapshotStore();
  const writeText = vi.fn(async () => undefined);
  const wrapped = wrapHashlineEditDefinition(stock, {
    store,
    readText: async () => body,
    writeText,
  });
  return { stock, store, writeText, wrapped };
};

describe('wrapHashlineEditDefinition', () => {
  it('使用允许可选 input/path/edits 的宽松对象 schema', () => {
    const { wrapped } = wrappedFixture();
    const schema = HASHLINE_EDIT_PARAMETERS as {
      type?: string;
      properties?: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(schema).toBeDefined();
    expect(schema.type).toBe('object');
    expect(schema.properties?.input?.description).toMatch(/\[path#TAG\].*PUT/i);
    expect(schema.required ?? []).not.toContain('path');
    expect(schema.required ?? []).not.toContain('edits');
    expect(wrapped.parameters).toBe(HASHLINE_EDIT_PARAMETERS);
    expect(wrapped.name).toBe('edit');
  });

  it('追加命名 edit 的 Hashline 首选与 replace 回退指南并保留 stock 指南', () => {
    const fixture = wrappedFixture();
    const stockGuidelines = ['Keep files small'];
    const stock = { ...fixture.stock, promptGuidelines: stockGuidelines };
    const wrapped = wrapHashlineEditDefinition(stock, {
      store: fixture.store,
      readText: async () => 'world\n',
      writeText: fixture.writeText,
    });
    expect(Array.isArray(wrapped.promptGuidelines)).toBe(true);
    expect(wrapped.promptGuidelines).toContain('Keep files small');
    const text = wrapped.promptGuidelines.join('\n');
    expect(text).toMatch(/\bedit\b/i);
    expect(text).toMatch(/\[path#TAG\].*input|input.*\[path#TAG\]/is);
    expect(text).toMatch(/edits.*replace|replace.*edits/is);
    expect(text).toMatch(/(?:do not|never).*(?:invent|fabricat).*tag/is);
  });

  it('replace 的 JSON 字符串 edits 继续经过 stock prepare 归一化', () => {
    const { wrapped } = wrappedFixture();
    const block = { oldText: 'a', newText: 'b' };
    expect(wrapped.prepareArguments({ path: 'f.ts', edits: JSON.stringify([block]) })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('Hashline input 经过 prepare 时保持原对象不变', () => {
    const { wrapped } = wrappedFixture();
    const args = { input: '[/tmp/a.ts#ABCD]\nPUT 1.=1:\n+x' };
    expect(wrapped.prepareArguments(args)).toBe(args);
  });

  it('有效 Hashline 执行写入文件且不调用 stock edit', async () => {
    const path = '/tmp/a.ts';
    const body = 'world\n';
    const { stock, store, writeText, wrapped } = wrappedFixture(body);
    const tag = store.record(path, body);
    await wrapped.execute('call-hashline', {
      input: `[${path}#${tag}]\nPUT 1.=1:\n+hello`,
    });
    expect(writeText).toHaveBeenCalledWith(path, 'hello\n');
    expect(stock.execute).not.toHaveBeenCalled();
  });

  it('Hashline 执行详情携带补丁前后文本与原始 input', async () => {
    const path = '/tmp/a.ts';
    const body = 'world\n';
    const { stock, store, wrapped } = wrappedFixture(body);
    const tag = store.record(path, body);
    const input = `[${path}#${tag}]\nPUT 1.=1:\n+hello`;
    const result = await wrapped.execute('call-details', { input });
    expect((result as unknown as { details: unknown }).details).toEqual({
      oldText: body,
      diff: 'hello\n',
      patch: input,
    });
    expect(stock.execute).not.toHaveBeenCalled();
  });
});

describe('Hashline read/grep promptGuidelines', () => {
  it('read 指南说明标签与编号行并保留 stock 指南', () => {
    const stockGuidelines = ['Read narrowly'];
    const stock = {
      name: 'read',
      promptGuidelines: stockGuidelines,
      execute: vi.fn(async () => ({ content: [{ type: 'text', text: 'body\n' }] })),
    };
    const wrapped = withHashlineRead(stock, new InMemorySnapshotStore());
    expect(wrapped.promptGuidelines).toContain('Read narrowly');
    const text = wrapped.promptGuidelines.join('\n');
    expect(text).toMatch(/\bread\b/i);
    expect(text).toMatch(/\[path#TAG\]/i);
    expect(text).toMatch(/numbered lines|N:/i);
  });

  it('grep 指南说明命中项的标签头锚点并保留 stock 指南', () => {
    const stockGuidelines = ['Search precisely'];
    const stock = {
      name: 'grep',
      promptGuidelines: stockGuidelines,
      execute: vi.fn(async () => ({ content: [{ type: 'text', text: 'a.ts:1:hit' }] })),
    };
    const wrapped = withHashlineGrep(stock, new InMemorySnapshotStore(), async () => 'hit\n');
    expect(wrapped.promptGuidelines).toContain('Search precisely');
    const text = wrapped.promptGuidelines.join('\n');
    expect(text).toMatch(/\bgrep\b/i);
    expect(text).toMatch(/#TAG/i);
    expect(text).toMatch(/(?:header|anchor).*hit|hit.*(?:header|anchor)/is);
  });
});

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

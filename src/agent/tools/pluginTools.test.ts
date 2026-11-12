import { describe, expect, it, vi } from 'vitest';
import { createPluginTools, PluginToolInvoker } from './pluginTools';

const identity = { sessionId: 's1', generation: '11111111-1111-4111-8111-111111111111' };
const descriptor = {
  name: 'plugin_example-demo__lookup',
  description: '查询',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  pluginId: 'example.demo',
};

describe('PluginToolInvoker', () => {
  it('Main 回落结果后 resolve', async () => {
    const emit = vi.fn();
    const invoker = new PluginToolInvoker(identity, emit, { emitCancel: vi.fn() });
    const pending = invoker.invoke('plugin_example-demo__lookup', { q: 'x' });
    const request = emit.mock.calls[0]?.[0];
    expect(request).toMatchObject({ toolName: 'plugin_example-demo__lookup', args: { q: 'x' } });
    invoker.resolve({ requestId: request.requestId, ok: true, result: { content: 'hi' } });
    await expect(pending).resolves.toEqual({ content: 'hi' });
  });

  it('中止时本地失败并通知 Main 取消', async () => {
    const emitCancel = vi.fn();
    const invoker = new PluginToolInvoker(identity, vi.fn(), { emitCancel });
    const controller = new AbortController();
    const pending = invoker.invoke('t', {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(emitCancel).toHaveBeenCalledTimes(1);
  });

  it('超时本地失败并通知取消；晚到结果被忽略', async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const emitCancel = vi.fn();
    const invoker = new PluginToolInvoker(identity, emit, { emitCancel, timeoutMs: 100 });
    const pending = invoker.invoke('t', {});
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    expect(emitCancel).toHaveBeenCalled();
    expect(invoker.resolve({ requestId: emit.mock.calls[0]?.[0].requestId, ok: true })).toBe(false);
    vi.useRealTimers();
  });

  it('cancelAll 让所有挂起调用失败', async () => {
    const invoker = new PluginToolInvoker(identity, vi.fn(), {});
    const a = invoker.invoke('t', {});
    const b = invoker.invoke('t', {});
    invoker.cancelAll();
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
    expect(invoker.pendingCount).toBe(0);
  });

  it('progress 转给对应调用的 onUpdate，结束后忽略', async () => {
    const emit = vi.fn();
    const updates: string[] = [];
    const invoker = new PluginToolInvoker(identity, emit, {});
    const pending = invoker.invoke('t', {}, undefined, {
      onUpdate: (partial) => updates.push(partial.content[0].text),
    });
    const requestId = emit.mock.calls[0]?.[0].requestId as string;
    invoker.progress('missing', 'nope');
    invoker.progress(requestId, 'halfway');
    expect(updates).toEqual(['halfway']);
    invoker.resolve({ requestId, ok: true, result: { content: 'done' } });
    await pending;
    invoker.progress(requestId, 'late');
    expect(updates).toEqual(['halfway']);
  });
});

describe('createPluginTools', () => {
  it('readOnly 描述转成 readOnlyHint 注解，未声明时不带注解', () => {
    const invoker = { invoke: vi.fn() };
    const [ro, plain] = createPluginTools(
      [{ ...descriptor, readOnly: true }, descriptor],
      invoker as never
    );
    expect(ro?.annotations).toEqual({ readOnlyHint: true });
    expect(plain?.annotations).toBeUndefined();
  });

  it('按描述生成工具，执行结果转成文本内容并保留 details', async () => {
    const invoker = { invoke: vi.fn(async () => ({ content: 'hi', details: { n: 1 } })) };
    const [tool] = createPluginTools([descriptor], invoker as never);
    expect(tool).toMatchObject({
      name: descriptor.name,
      description: '查询',
      parameters: descriptor.parameters,
    });
    const result = await tool?.execute(
      'call-1',
      { q: 'x' },
      undefined,
      undefined,
      undefined as never
    );
    expect(invoker.invoke).toHaveBeenCalledWith(
      descriptor.name,
      { q: 'x' },
      undefined,
      expect.objectContaining({ timeoutMs: 70_000 })
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hi' }],
      details: { details: { n: 1 }, artifacts: [] },
    });
  });

  it('按描述符放宽本地超时，进度转给 onUpdate，产出追加到文本', async () => {
    const invoker = {
      invoke: vi.fn(async () => ({
        content: 'hi',
        details: { n: 1 },
        artifacts: [
          {
            id: 'a1',
            pluginId: 'example.demo',
            name: 'report.md',
            mime: 'text/markdown',
            size: 12,
            createdAt: 1,
          },
        ],
      })),
    };
    const updates: unknown[] = [];
    const [tool] = createPluginTools([{ ...descriptor, timeoutMs: 5_000 }], invoker as never);
    const result = await tool?.execute(
      'call-1',
      { q: 'x' },
      undefined,
      (partial) => updates.push(partial),
      undefined as never
    );
    expect(invoker.invoke).toHaveBeenCalledWith(descriptor.name, { q: 'x' }, undefined, {
      timeoutMs: 15_000,
      onUpdate: expect.any(Function),
    });
    const hooks = (invoker.invoke.mock.calls[0] as unknown[] | undefined)?.[3] as
      | { onUpdate?: (partial: unknown) => void }
      | undefined;
    hooks?.onUpdate?.({ content: [{ type: 'text', text: 'halfway' }], details: undefined });
    expect(updates).toEqual([{ content: [{ type: 'text', text: 'halfway' }], details: undefined }]);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hi\n[产出文件] report.md（text/markdown，12）' }],
      details: {
        details: { n: 1 },
        artifacts: [
          {
            id: 'a1',
            pluginId: 'example.demo',
            name: 'report.md',
            mime: 'text/markdown',
            size: 12,
            createdAt: 1,
          },
        ],
      },
    });
  });
});

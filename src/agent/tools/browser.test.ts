import { describe, expect, it, vi } from 'vitest';
import { BrowserInvoker, createBrowserTools, withNavigateApproval } from './browser';

const identity = { sessionId: 's1', generation: '11111111-1111-4111-8111-111111111111' };

describe('BrowserInvoker', () => {
  it('发 browser-invoke 并等 result；成功/失败按 ok 分派', async () => {
    const emit = vi.fn();
    const invoker = new BrowserInvoker(identity, emit);
    const p1 = invoker.invoke('navigate', { url: 'u' });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ identity, op: 'navigate', params: { url: 'u' } })
    );
    const requestId = emit.mock.calls[0]?.[0]?.requestId as string;
    expect(invoker.resolve({ requestId, ok: true, result: { url: 'u' } })).toBe(true);
    await expect(p1).resolves.toEqual({ url: 'u' });

    const p2 = invoker.invoke('click', { ref: 'e1' });
    const id2 = emit.mock.calls[1]?.[0]?.requestId as string;
    invoker.resolve({ requestId: id2, ok: false, error: 'stale-ref' });
    await expect(p2).rejects.toThrow('stale-ref');
    expect(invoker.resolve({ requestId: 'nope', ok: true })).toBe(false);
  });

  it('abort / cancelAll / 超时 都以拒绝收尾', async () => {
    vi.useFakeTimers();
    const invoker = new BrowserInvoker(identity, () => {}, { timeoutMs: 1000 });
    const controller = new AbortController();
    const aborted = invoker.invoke('snapshot', {}, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toThrow(/abort/i);

    const timed = invoker.invoke('snapshot', {});
    vi.advanceTimersByTime(1001);
    await expect(timed).rejects.toThrow(/timed out/i);

    const cancelled = invoker.invoke('snapshot', {});
    invoker.cancelAll();
    await expect(cancelled).rejects.toThrow(/cancel/i);
    expect(invoker.pendingCount).toBe(0);
    vi.useRealTimers();
  });
});

describe('createBrowserTools', () => {
  it('注册第一刀五个工具，click/type 缺 ref 直接抛错不发请求', async () => {
    const emit = vi.fn();
    const tools = createBrowserTools(new BrowserInvoker(identity, emit));
    expect(tools.map((tool) => tool.name)).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_tabs',
      'browser_lock',
      'browser_screenshot',
    ]);
    const click = tools.find((tool) => tool.name === 'browser_click')!;
    await expect(click.execute('c1', {}, undefined, undefined, undefined as never)).rejects.toThrow(
      /ref/
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('screenshot 结果回图片块，其它回文本', async () => {
    const emit = vi.fn();
    const invoker = new BrowserInvoker(identity, emit);
    const tools = createBrowserTools(invoker);
    const shot = tools.find((tool) => tool.name === 'browser_screenshot')!;
    const pending = shot.execute('c1', {}, undefined, undefined, undefined as never);
    const requestId = emit.mock.calls[0]?.[0]?.requestId as string;
    invoker.resolve({ requestId, ok: true, result: { data: 'AAAA', mimeType: 'image/png' } });
    const out = await pending;
    expect(out.content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  });
});

describe('withNavigateApproval', () => {
  const fakeGate = (allow: 'allow' | 'deny') => {
    const ask = vi.fn(async () => allow);
    return { gate: { needsApproval: () => true, ask } as never, ask };
  };
  const passthrough = { name: 'browser_navigate', execute: vi.fn(async () => 'ran') } as never;

  it('localhost 直接放行，外网走审批', async () => {
    const { gate, ask } = fakeGate('allow');
    const tool = withNavigateApproval(gate, passthrough);
    await tool.execute(
      'c',
      { url: 'http://localhost:3000' },
      undefined,
      undefined,
      undefined as never
    );
    expect(ask).not.toHaveBeenCalled();
    await tool.execute(
      'c',
      { url: 'https://example.com' },
      undefined,
      undefined,
      undefined as never
    );
    expect(ask).toHaveBeenCalledWith(
      'browser_navigate',
      'mcp',
      'Open example.com in the built-in browser',
      undefined
    );
  });

  it('拒绝时抛错且不执行', async () => {
    const { gate } = fakeGate('deny');
    const inner = vi.fn(async () => 'ran');
    const tool = withNavigateApproval(gate, { name: 'browser_navigate', execute: inner } as never);
    await expect(
      tool.execute('c', { url: 'https://example.com' }, undefined, undefined, undefined as never)
    ).rejects.toThrow(/denied/);
    expect(inner).not.toHaveBeenCalled();
  });
});

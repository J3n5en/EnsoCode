import type { PluginEventPlan } from '@shared/extensionPlugins/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createPluginEventsExtension,
  PluginEventInvoker,
  type PluginSessionEmit,
} from './pluginEvents';

const plan = (patch: Partial<PluginEventPlan> = {}): PluginEventPlan => ({
  observe: [],
  intercept: [],
  inject: false,
  ...patch,
});

function harness(
  events: PluginEventPlan,
  options?: { interceptTimeoutMs?: number; compactTimeoutMs?: number }
) {
  const emit = vi.fn<(event: PluginSessionEmit) => void>();
  const invoker = new PluginEventInvoker(events, emit, options);
  const handlers = new Map<string, (event: never) => unknown>();
  const sendMessage = vi.fn();
  const extension = createPluginEventsExtension(invoker);
  if (typeof extension === 'function') throw new Error('expected inline extension');
  extension.factory({
    on: (event: string, handler: (event: never) => unknown) => {
      handlers.set(event, handler as (event: never) => unknown);
      return () => {};
    },
    sendMessage,
  } as never);
  return { emit, invoker, handlers, sendMessage };
}

const requestIdOf = (emit: { mock: { calls: unknown[][] } }): string => {
  const event = emit.mock.calls[0]?.[0] as { requestId?: string } | undefined;
  if (!event?.requestId) throw new Error('missing request');
  return event.requestId;
};

const reply = (
  emit: { mock: { calls: unknown[][] } },
  invoker: PluginEventInvoker,
  result: unknown
) => {
  invoker.resolve({ requestId: requestIdOf(emit), ok: true, result });
};

describe('插件事件扩展', () => {
  it('只挂已订阅的事件', () => {
    const { handlers } = harness(
      plan({ observe: ['session_start', 'before_compact'], intercept: [{ event: 'tool_call' }] })
    );
    expect([...handlers.keys()].sort()).toEqual(
      ['session_before_compact', 'session_start', 'tool_call'].sort()
    );
  });

  it('观察型订阅 tool_call / tool_result / input 也会通知，且不等回复', async () => {
    const { emit, handlers } = harness(plan({ observe: ['input', 'tool_call', 'tool_result'] }));
    await handlers.get('tool_call')?.({
      toolCallId: 'c',
      toolName: 'bash',
      input: { a: 1 },
    } as never);
    await handlers.get('tool_result')?.({
      toolCallId: 'c',
      toolName: 'bash',
      input: { a: 1 },
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    } as never);
    await handlers.get('input')?.({ text: 'hi', source: 'interactive' } as never);
    await handlers.get('input')?.({ text: 'skip', source: 'extension' } as never);
    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      {
        type: 'plugin-event',
        event: 'tool_call',
        data: { toolCallId: 'c', toolName: 'bash', input: { a: 1 } },
      },
      {
        type: 'plugin-event',
        event: 'tool_result',
        data: { toolCallId: 'c', toolName: 'bash', input: { a: 1 }, content: 'ok', isError: false },
      },
      { type: 'plugin-event', event: 'input', data: { text: 'hi', source: 'interactive' } },
    ]);
  });

  it('同一事件既有拦截又有观察时，观察者收到拦截后的参数', async () => {
    const { emit, handlers, invoker } = harness(
      plan({ observe: ['tool_call'], intercept: [{ event: 'tool_call' }] })
    );
    const input = { command: 'rm' };
    const pending = handlers.get('tool_call')?.({
      toolCallId: 'c',
      toolName: 'bash',
      input,
    } as never);
    reply(emit, invoker, { input: { command: 'ls' } });
    await pending;
    expect(emit.mock.calls.at(-1)?.[0]).toEqual({
      type: 'plugin-event',
      event: 'tool_call',
      data: { toolCallId: 'c', toolName: 'bash', input: { command: 'ls' } },
    });
  });

  it('工具不在过滤名单里不上报，名单内改写输入', async () => {
    const { emit, handlers, invoker } = harness(
      plan({ intercept: [{ event: 'tool_call', tools: ['bash'] }] })
    );
    const handler = handlers.get('tool_call');
    await handler?.({ toolCallId: 'c', toolName: 'grep', input: { pattern: 'a' } } as never);
    expect(emit).not.toHaveBeenCalled();
    const input = { command: 'rm' };
    const pending = handler?.({ toolCallId: 'c', toolName: 'bash', input } as never);
    reply(emit, invoker, { input: { command: 'ls' } });
    await expect(pending).resolves.toBeUndefined();
    expect(input).toEqual({ command: 'ls' });
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      event: 'tool_call',
      payload: { toolCallId: 'c', toolName: 'bash', input: { command: 'rm' } },
    });
  });

  it('拦截超时放行，晚到结果被忽略', async () => {
    vi.useFakeTimers();
    const { emit, handlers, invoker } = harness(plan({ intercept: [{ event: 'input' }] }), {
      interceptTimeoutMs: 30,
    });
    const pending = handlers.get('input')?.({ text: 'hi', source: 'rpc' } as never);
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toBeUndefined();
    expect(
      invoker.resolve({
        requestId: requestIdOf(emit),
        ok: true,
        result: { action: 'handled' },
      })
    ).toBe(false);
    vi.useRealTimers();
  });

  it('input 来自 extension 时不拦截，改写保留图片', async () => {
    const { emit, handlers, invoker } = harness(plan({ intercept: [{ event: 'input' }] }));
    const handler = handlers.get('input');
    await expect(handler?.({ text: 'x', source: 'extension' } as never)).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    const images = [{ type: 'image', data: 'aa', mimeType: 'image/png' }];
    const pending = handler?.({ text: 'a', source: 'interactive', images } as never);
    reply(emit, invoker, { action: 'transform', text: 'b' });
    await expect(pending).resolves.toEqual({ action: 'transform', text: 'b', images });
  });

  it('tool_result 只拼接文本，改写后换成单个文本块', async () => {
    const { emit, handlers, invoker } = harness(plan({ intercept: [{ event: 'tool_result' }] }));
    const pending = handlers.get('tool_result')?.({
      toolCallId: 'c',
      toolName: 'bash',
      input: {},
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'zz', mimeType: 'image/png' },
        { type: 'text', text: 'b' },
      ],
      isError: false,
    } as never);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      payload: { content: 'ab', isError: false },
    });
    reply(emit, invoker, { content: 'rewritten', isError: true });
    await expect(pending).resolves.toEqual({
      content: [{ type: 'text', text: 'rewritten' }],
      isError: true,
    });
  });

  it('before_compact 等到回复才继续，取消则放行', async () => {
    const { emit, handlers, invoker } = harness(plan({ observe: ['before_compact'] }));
    let settled = false;
    const pending = Promise.resolve(
      handlers.get('session_before_compact')?.({ reason: 'manual' } as never)
    ).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      event: 'before_compact',
      payload: { reason: 'manual' },
    });
    invoker.cancelAll();
    await expect(pending).resolves.toBeUndefined();
    expect(invoker.pendingCount).toBe(0);
  });

  it('上报失败也不抛回工具调用', async () => {
    const { emit, handlers } = harness(plan({ intercept: [{ event: 'tool_call' }] }));
    emit.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(
      handlers.get('tool_call')?.({
        toolCallId: 'c',
        toolName: 'bash',
        input: { command: 'ls' },
      } as never)
    ).resolves.toBeUndefined();
  });

  it('未声明 inject 的会话拒绝注入', () => {
    const { invoker, sendMessage } = harness(plan({ inject: false }));
    expect(
      invoker.deliver({
        pluginId: 'example.demo',
        pluginName: 'Demo',
        text: 'hi',
        deliverAs: 'nextTurn',
        triggerTurn: false,
      })
    ).toEqual({ ok: false, error: '会话未声明注入' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('声明 inject 时用 pi.sendMessage', () => {
    const { invoker, sendMessage } = harness(plan({ inject: true }));
    expect(
      invoker.deliver({
        pluginId: 'example.demo',
        pluginName: 'Demo',
        text: 'hi',
        deliverAs: 'steer',
        triggerTurn: true,
      })
    ).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: 'enso-plugin-message',
        content: 'hi',
        display: true,
        details: { pluginId: 'example.demo', pluginName: 'Demo' },
      },
      { deliverAs: 'steer', triggerTurn: true }
    );
  });
});

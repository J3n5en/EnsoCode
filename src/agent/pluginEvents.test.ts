import type { PluginEventPlan } from '@shared/extensionPlugins/types';
import { describe, expect, it, vi } from 'vitest';
import {
  childPluginEventPlan,
  contextUsagePayload,
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
  options?: { interceptTimeoutMs?: number; compactTimeoutMs?: number; childSession?: boolean }
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

  it('agent_end 带本轮最后一条助手回复的正文；没有文字时为空串', () => {
    const { emit, handlers } = harness(plan({ observe: ['agent_end'] }));
    handlers.get('agent_end')?.({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [{ type: 'text', text: '旧' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'text', text: '答' },
            { type: 'toolCall', id: 't', name: 'bash', arguments: {} },
            { type: 'text', text: '案' },
          ],
        },
        { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] },
      ],
    } as never);
    handlers.get('agent_end')?.({ messages: [] } as never);
    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      { type: 'plugin-event', event: 'agent_end', data: { text: '答\n案' } },
      { type: 'plugin-event', event: 'agent_end', data: { text: '' } },
    ]);
  });

  it('agent_end 正文超长时截断', () => {
    const { emit, handlers } = harness(plan({ observe: ['agent_end'] }));
    handlers.get('agent_end')?.({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(70_000) }] }],
    } as never);
    const event = emit.mock.calls[0]?.[0] as { data: { text: string } } | undefined;
    expect(event?.data.text.length).toBe(64 * 1024);
  });

  it('观察型 tool_result 的 content 超过 64K 字符时截断，拦截载荷不截断', async () => {
    const text = 'a'.repeat(70_000);
    const observed = harness(plan({ observe: ['tool_result'] }));
    await observed.handlers.get('tool_result')?.({
      toolCallId: 'c',
      toolName: 'bash',
      input: {},
      content: [{ type: 'text', text }],
      isError: false,
    } as never);
    const notice = observed.emit.mock.calls[0]?.[0] as { data: { content: string } } | undefined;
    expect(notice?.data.content.length).toBe(64 * 1024);
    expect(notice?.data.content.startsWith('aaa')).toBe(true);

    const both = harness(plan({ observe: ['tool_result'], intercept: [{ event: 'tool_result' }] }));
    const pending = both.handlers.get('tool_result')?.({
      toolCallId: 'c',
      toolName: 'bash',
      input: {},
      content: [{ type: 'text', text }],
      isError: false,
    } as never);
    const intercept = both.emit.mock.calls[0]?.[0] as { payload: { content: string } } | undefined;
    expect(intercept?.payload.content.length).toBe(70_000);
    reply(both.emit, both.invoker, { content: 'b'.repeat(70_000) });
    await pending;
    const after = both.emit.mock.calls.at(-1)?.[0] as { data: { content: string } } | undefined;
    expect(after?.data.content.length).toBe(64 * 1024);
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

  it('主会话即使启动时没有声明 inject 也接收注入', () => {
    const { invoker, sendMessage } = harness(plan({ inject: false }));
    expect(
      invoker.deliver({
        pluginId: 'example.demo',
        pluginName: 'Demo',
        text: 'hi',
        deliverAs: 'nextTurn',
        triggerTurn: false,
      })
    ).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalled();
  });

  it('子会话不接收注入', () => {
    const { invoker, sendMessage } = harness(plan({ inject: true }), { childSession: true });
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

  it('带图片的注入以文字加图片块发送', () => {
    const { invoker, sendMessage } = harness(plan({ inject: true }));
    invoker.deliver({
      pluginId: 'example.demo',
      pluginName: 'Demo',
      text: 'hi',
      images: [{ data: 'AAAA', mimeType: 'image/png' }],
      deliverAs: 'followUp',
      triggerTurn: true,
    });
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    });
  });
});

describe('子会话的插件事件', () => {
  it('子会话计划保留通知型与 tool_call 拦截，去掉其余拦截与注入；什么都没订阅时不下发', () => {
    expect(
      childPluginEventPlan(
        plan({
          observe: ['agent_end', 'before_compact'],
          intercept: [
            { event: 'tool_call', tools: ['bash'] },
            { event: 'tool_result' },
            { event: 'input' },
          ],
          inject: true,
        })
      )
    ).toEqual({
      observe: ['agent_end', 'before_compact'],
      intercept: [{ event: 'tool_call', tools: ['bash'] }],
      inject: false,
    });
    expect(
      childPluginEventPlan(plan({ intercept: [{ event: 'tool_call' }], inject: true }))
    ).toEqual({ observe: [], intercept: [{ event: 'tool_call' }], inject: false });
    expect(
      childPluginEventPlan(plan({ intercept: [{ event: 'input' }, { event: 'tool_result' }] }))
    ).toBeUndefined();
    expect(childPluginEventPlan(undefined)).toBeUndefined();
  });

  it('子会话：before_compact 不等回复；tool_call 拦截生效，可以拦下', async () => {
    const { emit, handlers, invoker } = harness(
      plan({ observe: ['before_compact', 'tool_call'], intercept: [{ event: 'tool_call' }] }),
      { childSession: true }
    );
    await expect(
      handlers.get('session_before_compact')?.({ reason: 'threshold' } as never)
    ).resolves.toBeUndefined();
    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      { type: 'plugin-event', event: 'before_compact', data: { reason: 'threshold' } },
    ]);
    const input = { command: 'rm' };
    const pending = handlers.get('tool_call')?.({
      toolCallId: 'c',
      toolName: 'bash',
      input,
    } as never);
    const request = emit.mock.calls[1]?.[0] as { type: string; requestId: string };
    expect(request).toMatchObject({
      type: 'plugin-intercept',
      event: 'tool_call',
      payload: { toolCallId: 'c', toolName: 'bash', input: { command: 'rm' } },
    });
    invoker.resolve({
      requestId: request.requestId,
      ok: true,
      result: { block: true, reason: 'no' },
    });
    await expect(pending).resolves.toEqual({ block: true, reason: 'no' });
    // 拦下后不再通知观察者
    expect(emit).toHaveBeenCalledTimes(2);
    expect(invoker.pendingCount).toBe(0);
  });

  it('子会话：tool_call 改写参数生效', async () => {
    const { emit, handlers, invoker } = harness(plan({ intercept: [{ event: 'tool_call' }] }), {
      childSession: true,
    });
    const input: Record<string, unknown> = { command: 'rm -rf /' };
    const pending = handlers.get('tool_call')?.({
      toolCallId: 'c',
      toolName: 'bash',
      input,
    } as never);
    reply(emit, invoker, { input: { command: 'ls' } });
    await expect(pending).resolves.toBeUndefined();
    expect(input).toEqual({ command: 'ls' });
  });

  it('子会话：input / tool_result 即使计划里有拦截也只通知，没有观察订阅就不挂处理器', async () => {
    const { handlers } = harness(plan({ intercept: [{ event: 'input' }] }), { childSession: true });
    expect(handlers.has('input')).toBe(false);
    const observed = harness(
      plan({
        observe: ['tool_result'],
        intercept: [{ event: 'tool_result' }, { event: 'input' }],
      }),
      { childSession: true }
    );
    expect(observed.handlers.has('input')).toBe(false);
    await expect(
      observed.handlers.get('tool_result')?.({
        toolCallId: 'c',
        toolName: 'bash',
        input: {},
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      } as never)
    ).resolves.toBeUndefined();
    expect(observed.emit.mock.calls.map((call) => call[0])).toEqual([
      {
        type: 'plugin-event',
        event: 'tool_result',
        data: { toolCallId: 'c', toolName: 'bash', input: {}, content: 'ok', isError: false },
      },
    ]);
  });

  it('子会话拦截的本地兜底短于主会话：Main 不回复时 8 秒内放行', async () => {
    vi.useFakeTimers();
    try {
      const { handlers, invoker } = harness(plan({ intercept: [{ event: 'tool_call' }] }), {
        childSession: true,
      });
      let done = false;
      const pending = Promise.resolve(
        handlers.get('tool_call')?.({ toolCallId: 'c', toolName: 'bash', input: {} } as never)
      ).then((value) => {
        done = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(7_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBeUndefined();
      expect(invoker.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('收敛时按给定结果结束挂起的拦截，不让 turn 挂死', async () => {
    const { handlers, invoker } = harness(plan({ intercept: [{ event: 'tool_call' }] }), {
      childSession: true,
    });
    const pending = handlers.get('tool_call')?.({
      toolCallId: 'c',
      toolName: 'bash',
      input: {},
    } as never);
    expect(invoker.pendingCount).toBe(1);
    invoker.cancelAll({ block: true, reason: 'closed' });
    await expect(pending).resolves.toEqual({ block: true, reason: 'closed' });
    expect(invoker.pendingCount).toBe(0);
    // 中断 / shutdown 不带结果时：子会话也按拦下收敛，主会话照旧放行
    const aborted = handlers.get('tool_call')?.({
      toolCallId: 'd',
      toolName: 'bash',
      input: {},
    } as never);
    invoker.cancelAll();
    await expect(aborted).resolves.toMatchObject({ block: true });
    const parent = harness(plan({ intercept: [{ event: 'tool_call' }] }));
    const released = parent.handlers.get('tool_call')?.({
      toolCallId: 'e',
      toolName: 'bash',
      input: {},
    } as never);
    parent.invoker.cancelAll();
    await expect(released).resolves.toBeUndefined();
  });
});

describe('contextUsagePayload', () => {
  const occupancy = {
    buckets: {
      system: 1,
      instructions: 2,
      skills: 3,
      tools: 4,
      conversation: 5,
      compaction: 6,
      projectMemory: 7,
      reminders: 8,
    },
    used: 36,
    estimated: false,
    compactedMessageCount: 0,
    compactionModelMismatch: false,
    contextWindow: 100,
    percent: 36,
  };

  it('带分桶与最近一次请求的用量，去掉已废弃的 projectMemory', () => {
    const payload = contextUsagePayload(occupancy, [
      { role: 'assistant', usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
      { role: 'user' },
      { role: 'assistant', usage: { input: 10, output: 2, cacheRead: 90, cacheWrite: 3 } },
      { role: 'user' },
    ]);
    expect(payload).toEqual({
      used: 36,
      estimated: false,
      contextWindow: 100,
      percent: 36,
      buckets: {
        system: 1,
        instructions: 2,
        skills: 3,
        tools: 4,
        conversation: 5,
        compaction: 6,
        reminders: 8,
      },
      usage: { input: 10, output: 2, cacheRead: 90, cacheWrite: 3 },
    });
  });

  it('还没有带用量的回复时不带 usage', () => {
    const { contextWindow: _w, percent: _p, ...noWindow } = occupancy;
    const payload = contextUsagePayload({ ...noWindow, estimated: true }, [{ role: 'user' }]);
    expect(payload).not.toHaveProperty('usage');
    expect(payload).not.toHaveProperty('contextWindow');
    expect(payload.estimated).toBe(true);
  });
});

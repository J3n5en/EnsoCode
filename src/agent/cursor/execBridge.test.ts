import { describe, expect, it } from 'vitest';
import { type CursorBridgeTool, dispatchCursorExec } from './execBridge';
import {
  attachCursorBridgeToSession,
  createCursorSessionBridge,
  handlePiCursorExec,
} from './sessionBridge';

function fakeTool(name: string, impl: CursorBridgeTool['execute']): CursorBridgeTool {
  return { name, execute: impl };
}

describe('dispatchCursorExec', () => {
  it('read 帧调用本地 read，回写结果并发出 toolCall/toolResult', async () => {
    const invoked: unknown[] = [];
    const tools = new Map<string, CursorBridgeTool>([
      [
        'read',
        fakeTool('read', async (id, args) => {
          invoked.push(['read', id, args]);
          return { content: [{ type: 'text', text: 'export const x = 1\n' }] };
        }),
      ],
    ]);
    const result = await dispatchCursorExec(
      { type: 'read', toolCallId: 'call-read', path: 'src/app.ts' },
      tools
    );
    expect(invoked).toEqual([['read', 'call-read', { path: 'src/app.ts' }]]);
    expect(result.toolName).toBe('read');
    expect(result.resultText).toContain('export const x');
    expect(result.events.map((event) => event.type)).toEqual(['toolCall', 'toolResult']);
    expect(result.events[0]).toMatchObject({
      type: 'toolCall',
      toolCallId: 'call-read',
      toolName: 'read',
    });
    expect(result.events[1]).toMatchObject({
      type: 'toolResult',
      toolCallId: 'call-read',
      toolName: 'read',
      isError: false,
    });
    expect(result.events[1]?.content?.[0]?.text).toContain('export const x');
  });

  it('write 帧调用本地 write', async () => {
    const invoked: unknown[] = [];
    const tools = new Map<string, CursorBridgeTool>([
      [
        'write',
        fakeTool('write', async (_id, args) => {
          invoked.push(args);
          return { content: [{ type: 'text', text: 'wrote' }] };
        }),
      ],
    ]);
    const result = await dispatchCursorExec(
      { type: 'write', toolCallId: 'call-write', path: 'notes.md', content: 'hello' },
      tools
    );
    expect(invoked).toEqual([{ path: 'notes.md', content: 'hello' }]);
    expect(result.toolName).toBe('write');
    expect(
      result.events.some((event) => event.type === 'toolResult' && event.toolName === 'write')
    ).toBe(true);
  });

  it('edit 帧调用本地 edit', async () => {
    const invoked: unknown[] = [];
    const tools = new Map<string, CursorBridgeTool>([
      [
        'edit',
        fakeTool('edit', async (_id, args) => {
          invoked.push(args);
          return { content: [{ type: 'text', text: 'patched' }] };
        }),
      ],
    ]);
    const result = await dispatchCursorExec(
      {
        type: 'edit',
        toolCallId: 'call-edit',
        path: 'src/app.ts',
        oldText: 'a',
        newText: 'b',
      },
      tools
    );
    expect(invoked).toEqual([{ path: 'src/app.ts', old_string: 'a', new_string: 'b' }]);
    expect(result.toolName).toBe('edit');
  });

  it('grep 帧调用本地 grep', async () => {
    const invoked: unknown[] = [];
    const tools = new Map<string, CursorBridgeTool>([
      [
        'grep',
        fakeTool('grep', async (_id, args) => {
          invoked.push(args);
          return { content: [{ type: 'text', text: 'src/app.ts:1:match' }] };
        }),
      ],
    ]);
    const result = await dispatchCursorExec(
      { type: 'grep', toolCallId: 'call-grep', pattern: 'TODO', path: 'src' },
      tools
    );
    expect(invoked).toEqual([{ pattern: 'TODO', path: 'src' }]);
    expect(result.toolName).toBe('grep');
    expect(result.resultText).toContain('match');
  });

  it('shell 帧调用本地 bash', async () => {
    const invoked: unknown[] = [];
    const tools = new Map<string, CursorBridgeTool>([
      [
        'bash',
        fakeTool('bash', async (_id, args) => {
          invoked.push(args);
          return { content: [{ type: 'text', text: 'ok\n' }] };
        }),
      ],
    ]);
    const result = await dispatchCursorExec(
      { type: 'shell', toolCallId: 'call-shell', command: 'ls', cwd: '/tmp' },
      tools
    );
    expect(invoked).toEqual([{ command: 'ls', cwd: '/tmp' }]);
    expect(result.toolName).toBe('bash');
    expect(result.events[0]?.toolName).toBe('bash');
  });
});

describe('createCursorSessionBridge', () => {
  it('dispatch 真正调用会话工具并把 toolCall/toolResult 交给 subscribe 路径', async () => {
    const seen: Array<{ type: string; toolName?: string }> = [];
    const invoked: unknown[] = [];
    const bridge = createCursorSessionBridge({
      cwd: '/tmp',
      tools: [
        fakeTool('read', async (_id, args) => {
          invoked.push(args);
          return { content: [{ type: 'text', text: 'file-body' }] };
        }),
      ],
      emit: (event) =>
        seen.push({ type: event.type, toolName: event.toolName as string | undefined }),
    });
    const result = await bridge.dispatch({ type: 'read', path: 'a.ts', toolCallId: 't1' });
    expect(invoked).toEqual([{ path: 'a.ts' }]);
    expect(result.resultText).toBe('file-body');
    expect(seen.map((event) => event.type)).toEqual(['tool_execution_start', 'tool_execution_end']);
    expect(seen[0]?.toolName).toBe('read');
  });

  it('attachCursorBridgeToSession 让 session.subscribe 收到工具事件', async () => {
    const received: string[] = [];
    const session = {
      subscribe(listener: (event: { type: string }) => void) {
        listener({ type: 'agent_start' });
        return () => {};
      },
      prompt: async () => {},
      steer: async () => {},
    };
    const bridge = attachCursorBridgeToSession(
      session as never,
      [
        fakeTool('write', async (_id, args) => {
          received.push(`write:${(args as { path?: string }).path}`);
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
      ],
      '/tmp'
    );
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    await bridge.dispatch({ type: 'write', path: 'b.md', content: 'x', toolCallId: 'w1' });
    expect(received).toEqual(['write:b.md']);
    expect(events).toContain('tool_execution_start');
    expect(events).toContain('tool_execution_end');
  });

  it('toolCall/toolResult 写入 session.messages，不会被 reconcile 裁掉', async () => {
    const messages: Array<{ role?: string; content?: unknown[]; toolCallId?: string }> = [
      { role: 'assistant', content: [{ type: 'text', text: '正在读' }] },
    ];
    const inner: Array<(event: { type: string; message?: unknown }) => void> = [];
    const session = {
      messages,
      subscribe(listener: (event: { type: string; message?: unknown }) => void) {
        inner.push(listener);
        return () => {};
      },
      prompt: async () => {},
      steer: async () => {},
    };
    const bridge = attachCursorBridgeToSession(
      session as never,
      [fakeTool('read', async () => ({ content: [{ type: 'text', text: 'file-body' }] }))],
      '/tmp'
    );
    session.subscribe(() => {});
    await bridge.dispatch({ type: 'read', path: 'a.ts', toolCallId: 'keep-1' });
    expect(
      messages[0]?.content?.some((part) => (part as { type?: string }).type === 'toolCall')
    ).toBe(true);
    inner.at(-1)?.({ type: 'message_end', message: messages[0] });
    expect(
      messages.some((message) => message.role === 'toolResult' && message.toolCallId === 'keep-1')
    ).toBe(true);
  });

  it('prompt 期间 native exec 钩子走到本会话工具并写回', async () => {
    const invoked: unknown[] = [];
    const writes: Uint8Array[] = [];
    const session = {
      subscribe() {
        return () => {};
      },
      prompt: async () => {
        await handlePiCursorExec(
          'readArgs',
          { id: 1, execId: 'ex', message: { value: { path: 'hook.ts', toolCallId: 'h1' } } },
          (bytes) => writes.push(bytes)
        );
      },
      steer: async () => {},
    };
    attachCursorBridgeToSession(
      session as never,
      [
        fakeTool('read', async (_id, args) => {
          invoked.push(args);
          return { content: [{ type: 'text', text: 'hooked' }] };
        }),
      ],
      '/tmp'
    );
    await session.prompt();
    expect(invoked).toEqual([{ path: 'hook.ts' }]);
    expect(writes.length).toBe(1);
    expect(writes[0]?.length).toBeGreaterThan(5);
  });
});

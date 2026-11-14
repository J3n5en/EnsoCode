import { SECRETARY_OPS, SECRETARY_TOOL_ALLOWLIST, type SecretaryOp } from '@shared/secretary/tools';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryInvoker } from './memory';
import { createSecretaryTools, normalizeSecretaryParams } from './secretary';

function invoker() {
  const invoke = vi.fn(async () => ({ ok: false, error: 'unavailable' }));
  return { invoke, port: { invoke } as unknown as MemoryInvoker<SecretaryOp> };
}

describe('secretary tools', () => {
  it('每个 op 一个工具，名字与白名单一致', () => {
    const tools = createSecretaryTools(invoker().port);
    expect(tools.map((tool) => tool.name)).toEqual([...SECRETARY_OPS]);
    for (const tool of tools) expect(SECRETARY_TOOL_ALLOWLIST.has(tool.name)).toBe(true);
  });

  it('schema 声明完整类型、必填项在属性里、禁止额外键', () => {
    for (const tool of createSecretaryTools(invoker().port)) {
      const schema = tool.parameters as unknown as {
        type: string;
        properties: Record<string, { type?: unknown; anyOf?: unknown[] }>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(typeof schema.properties).toBe('object');
      for (const [key, property] of Object.entries(schema.properties))
        expect(property.type ?? property.anyOf, `${tool.name}.${key}`).toBeDefined();
      for (const key of schema.required ?? [])
        expect(Object.keys(schema.properties)).toContain(key);
    }
  });

  it('session_send 的 mode 只允许 queue 与 steer，session_stop 的 clearQueue 是布尔', () => {
    const tools = createSecretaryTools(invoker().port);
    const schemaOf = (name: string) =>
      tools.find((tool) => tool.name === name)?.parameters as unknown as {
        properties: Record<string, { type?: string; enum?: string[] }>;
        required?: string[];
      };
    const send = schemaOf('session_send');
    expect(send.properties.mode).toMatchObject({ type: 'string', enum: ['queue', 'steer'] });
    expect(send.required).toEqual(['conversationId', 'message']);
    const stop = schemaOf('session_stop');
    expect(stop.properties.clearQueue).toMatchObject({ type: 'boolean' });
    expect(stop.required).toEqual(['conversationId']);
    expect(schemaOf('session_queue_list').required).toEqual(['conversationId']);
    expect(schemaOf('session_queue_cancel').required).toEqual(['conversationId', 'messageId']);
  });

  it('别名与类型在 schema 校验前归一化', () => {
    expect(
      normalizeSecretaryParams('session_create', {
        project_id: 'p1',
        task: '  fix the build  ',
        worktree: 'true',
        title: '',
      })
    ).toEqual({ projectId: 'p1', prompt: 'fix the build', worktree: true });
    expect(normalizeSecretaryParams('session_read', { conversation_id: 'c1', limit: '5' })).toEqual(
      {
        conversationId: 'c1',
        limit: 5,
      }
    );
    expect(normalizeSecretaryParams('session_send', { conversationId: 'c1', text: 'hi' })).toEqual({
      conversationId: 'c1',
      message: 'hi',
    });
    expect(
      normalizeSecretaryParams('session_send', {
        conversation_id: 'c1',
        content: 'hi',
        mode: ' steer ',
      })
    ).toEqual({ conversationId: 'c1', message: 'hi', mode: 'steer' });
    expect(
      normalizeSecretaryParams('session_stop', { conversationId: 'c1', clear_queue: 'true' })
    ).toEqual({ conversationId: 'c1', clearQueue: true });
    expect(
      normalizeSecretaryParams('schedule_add', { name: 'n', prompt: 'p', cron: null })
    ).toEqual({
      name: 'n',
      prompt: 'p',
    });
    // 非对象原样返回，交给 schema 拒绝
    expect(normalizeSecretaryParams('project_list', 'nope')).toBe('nope');
  });

  it('execute 把归一化后的参数交给 Main，结果原样回给模型', async () => {
    const { invoke, port } = invoker();
    invoke.mockResolvedValueOnce({ ok: false, error: 'unavailable' });
    const tool = createSecretaryTools(port).find((entry) => entry.name === 'project_info')!;
    const result = await tool.execute(
      'call-1',
      { project_id: 'p1' } as never,
      undefined,
      undefined as never,
      undefined as never
    );
    expect(invoke).toHaveBeenCalledWith('project_info', { projectId: 'p1' }, undefined);
    expect(result.content).toEqual([{ type: 'text', text: '{"ok":false,"error":"unavailable"}' }]);
  });

  it('invoker 抛错时标成工具失败，不把错误当结果', async () => {
    const { invoke, port } = invoker();
    invoke.mockRejectedValueOnce(new Error('Main is gone'));
    const tool = createSecretaryTools(port).find((entry) => entry.name === 'session_list')!;
    const result = await tool.execute(
      'call-2',
      {} as never,
      undefined,
      undefined as never,
      undefined as never
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Main is gone' }]);
  });
});

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
        properties: Record<
          string,
          { type?: string; enum?: string[]; maxItems?: number; items?: { type?: string } }
        >;
        required?: string[];
      };
    const send = schemaOf('session_send');
    expect(send.properties.mode).toMatchObject({ type: 'string', enum: ['queue', 'steer'] });
    expect(send.properties.attachments).toMatchObject({
      type: 'array',
      maxItems: 5,
      items: { type: 'string' },
    });
    expect(send.required).toEqual(['conversationId', 'message']);
    expect(send.properties.goal).toMatchObject({ type: 'string', maxLength: 4000 });
    const stop = schemaOf('session_stop');
    expect(stop.properties.clearQueue).toMatchObject({ type: 'boolean' });
    expect(stop.required).toEqual(['conversationId']);
    expect(schemaOf('session_queue_list').required).toEqual(['conversationId']);
    expect(schemaOf('session_queue_cancel').required).toEqual(['conversationId', 'messageId']);
  });

  it('派发类工具都声明基线、依赖与取消等待派发的参数', () => {
    const tools = createSecretaryTools(invoker().port);
    const schemaOf = (name: string) =>
      tools.find((tool) => tool.name === name)?.parameters as unknown as {
        properties: Record<string, { type?: string; items?: { type?: string } }>;
      };
    for (const name of ['session_create', 'todo_item_dispatch']) {
      const schema = schemaOf(name);
      expect(schema.properties.checkout).toMatchObject({ type: 'string' });
      expect(schema.properties.baseRef).toMatchObject({ type: 'string' });
      expect(schema.properties.branch).toMatchObject({ type: 'string' });
      expect(schema.properties.goal).toMatchObject({ type: 'string', maxLength: 4000 });
      expect(schema.properties.after).toMatchObject({ type: 'array' });
      expect(schema.properties.after.items).toMatchObject({ type: 'string' });
      expect(schema.properties.attachments).toMatchObject({
        type: 'array',
        maxItems: 5,
        items: { type: 'string' },
      });
    }
    expect(
      normalizeSecretaryParams('todo_item_dispatch', { todoId: 't1', goal: '修好并合进 main' })
    ).toEqual({ todoId: 't1', goal: '修好并合进 main' });
    for (const name of ['session_create', 'todo_item_dispatch'] as const)
      expect(
        normalizeSecretaryParams(name, { projectId: 'p1', prompt: 'x', images: ' /tmp/a.png ' })
      ).toMatchObject({ attachments: ['/tmp/a.png'] });
  });

  it('secretary_profile_propose 只暴露保留的设置项，派发工具不再提确认卡', () => {
    const tools = createSecretaryTools(invoker().port);
    const tool = (name: string) => tools.find((item) => item.name === name);
    const profile = tool('secretary_profile_propose');
    if (!profile) throw new Error('secretary_profile_propose missing');
    const keys = Object.keys(
      (profile.parameters as unknown as { properties: Record<string, unknown> }).properties
    );
    for (const removed of [
      'model',
      'autonomy',
      'autoApproveProjectIds',
      'dispatchModel',
      'dispatchWorktree',
      'patrolIntervalMinutes',
      'patrolIdleGoalMinutes',
      'orphanTaskPatrol',
      'dispatchMuted',
      'dispatchUnattended',
    ])
      expect(keys, removed).not.toContain(removed);
    for (const kept of ['name', 'avatarColor', 'visibleProjectIds', 'maxRunningDispatches'])
      expect(keys).toContain(kept);
    expect(keys).toContain('patrolEnabled');
    expect(profile.description).not.toMatch(/model|autonomy/);
    for (const name of ['session_create', 'todo_item_dispatch'] as const) {
      expect(tool(name)?.description).not.toMatch(/confirm/i);
      expect(JSON.stringify(tool(name)?.parameters)).not.toMatch(
        /dispatch model from your settings/
      );
    }
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
    // 单张图片写成字符串时包成数组，别名 images / imagePaths 都认
    expect(
      normalizeSecretaryParams('session_send', {
        conversationId: 'c1',
        message: '按图改',
        attachments: ' /tmp/a.png ',
      })
    ).toEqual({ conversationId: 'c1', message: '按图改', attachments: ['/tmp/a.png'] });
    expect(
      normalizeSecretaryParams('session_send', {
        sessionId: 'c1',
        text: '按图改',
        images: ['/tmp/a.png', '/tmp/b.png'],
      })
    ).toEqual({
      conversationId: 'c1',
      message: '按图改',
      attachments: ['/tmp/a.png', '/tmp/b.png'],
    });
    // 空白条目没有语义，schema 校验前丢掉；丢完为空等同没传
    expect(
      normalizeSecretaryParams('session_send', {
        conversationId: 'c1',
        message: '按图改',
        attachments: ['/tmp/a.png', ' ', '', '/tmp/b.png'],
      })
    ).toEqual({
      conversationId: 'c1',
      message: '按图改',
      attachments: ['/tmp/a.png', '/tmp/b.png'],
    });
    expect(
      normalizeSecretaryParams('session_create', { projectId: 'p1', prompt: 'x', images: [''] })
    ).not.toHaveProperty('attachments');
    expect(
      normalizeSecretaryParams('session_send', {
        conversationId: 'c1',
        message: 'hi',
        attachments: [123, ''],
      })
    ).toEqual({ conversationId: 'c1', message: 'hi', attachments: [123] });
    // 图全空只删 attachments，goal / mode 原样保留
    expect(
      normalizeSecretaryParams('session_send', {
        conversationId: 'c1',
        message: 'hi',
        mode: 'steer',
        goal: ' 修好 ',
        attachments: [' '],
      })
    ).toEqual({ conversationId: 'c1', message: 'hi', mode: 'steer', goal: '修好' });
    expect(
      normalizeSecretaryParams('session_create', {
        projectId: 'p1',
        prompt: 'x',
        after: ['', 's1'],
      })
    ).toEqual({ projectId: 'p1', prompt: 'x', after: ['s1'] });
    expect(normalizeSecretaryParams('todo_item_dispatch', { todoId: 't1', after: [' '] })).toEqual({
      todoId: 't1',
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

  it('只读核实工具的别名、snake_case 与数字在 schema 校验前归一化', () => {
    expect(
      normalizeSecretaryParams('repo_status', {
        project_id: 'p1',
        limit: '5',
        base: ' main ',
        sha: '9c23a8058',
      })
    ).toEqual({ projectId: 'p1', limit: 5, base: 'main', contains: '9c23a8058' });
    expect(normalizeSecretaryParams('repo_status', { dir: '/repo/alpha' })).toEqual({
      path: '/repo/alpha',
    });
    expect(
      normalizeSecretaryParams('repo_diff', {
        project_id: 'p1',
        branch: ' feat/x ',
        merge_base: 'false',
      })
    ).toEqual({ projectId: 'p1', ref: 'feat/x', mergeBase: false });
    expect(
      normalizeSecretaryParams('session_read', {
        conversation_id: 'c1',
        message_index: '7',
        offset: '30000',
      })
    ).toEqual({ conversationId: 'c1', index: 7, offset: 30_000 });
    // entryId 是现名；旧名 messageId / message_id 仍被接受，已在跑的会话不出错
    for (const legacy of [{ entry_id: ' e-1 ' }, { messageId: 'e-1' }, { message_id: ' e-1 ' }])
      expect(
        normalizeSecretaryParams('session_read', { conversation_id: 'c1', ...legacy })
      ).toEqual({ conversationId: 'c1', entryId: 'e-1' });
    expect(
      normalizeSecretaryParams('session_read', {
        conversationId: 'c1',
        entryId: 'new',
        messageId: 'old',
      })
    ).toEqual({ conversationId: 'c1', entryId: 'new' });
    const readSchema = createSecretaryTools(invoker().port).find(
      (tool) => tool.name === 'session_read'
    )?.parameters as unknown as { properties: Record<string, unknown> };
    expect(readSchema.properties).toHaveProperty('entryId');
    expect(readSchema.properties).not.toHaveProperty('messageId');
    expect(
      normalizeSecretaryParams('session_activity', { conversation_id: 'c1', limit: '50' })
    ).toEqual({ conversationId: 'c1', limit: 50 });
    expect(normalizeSecretaryParams('session_tasks', { id: 'c1' })).toEqual({
      conversationId: 'c1',
    });
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

  it('image_view 把图片字节拆成图片块，文本里只剩元数据', async () => {
    const { invoke, port } = invoker();
    invoke.mockResolvedValueOnce({
      path: '/tmp/shot.png',
      size: 2048,
      format: 'png',
      mimeType: 'image/png',
      width: 1280,
      height: 720,
      data: 'AAAA',
    } as never);
    const tool = createSecretaryTools(port).find((entry) => entry.name === 'image_view')!;
    const result = await tool.execute(
      'call-3',
      { path: '/tmp/shot.png' } as never,
      undefined,
      undefined as never,
      undefined as never
    );
    expect(result.content[0]).toEqual({
      type: 'text',
      text: '{"path":"/tmp/shot.png","size":2048,"width":1280,"height":720,"mimeType":"image/png"}',
    });
    expect(result.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    // base64 不进文本，会话文件里不会多一份
    expect(JSON.stringify(result.content[0])).not.toContain('AAAA');
  });

  it('image_view 失败时照常返回错误文本', async () => {
    const { invoke, port } = invoker();
    invoke.mockRejectedValueOnce(new Error('path is out of scope'));
    const tool = createSecretaryTools(port).find((entry) => entry.name === 'image_view')!;
    const result = await tool.execute(
      'call-4',
      { path: '/Users/me/x.png' } as never,
      undefined,
      undefined as never,
      undefined as never
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'path is out of scope' }]);
  });

  it('看图与清理的参数别名在 schema 校验前归一化', () => {
    expect(normalizeSecretaryParams('image_view', { file_path: ' /tmp/a.png ' })).toEqual({
      path: '/tmp/a.png',
    });
    // 只给一个 id 字符串时包成数组，schema 不会因此拒绝
    expect(normalizeSecretaryParams('cleanup_apply', { id: 'branch|/repo|feat/x' })).toEqual({
      ids: ['branch|/repo|feat/x'],
    });
    // 空白 id 丢掉；全空等同没传，由 Main 报缺 ids，绝不变成 all
    expect(normalizeSecretaryParams('cleanup_apply', { ids: ['', 'branch|/repo|feat/x'] })).toEqual(
      { ids: ['branch|/repo|feat/x'] }
    );
    expect(normalizeSecretaryParams('cleanup_apply', { ids: ['', ' '] })).toEqual({});
    expect(normalizeSecretaryParams('session_archive', { ids: ['s1', ''] })).toEqual({
      ids: ['s1'],
    });
    expect(normalizeSecretaryParams('session_unarchive', { id: 's1' })).toEqual({ ids: ['s1'] });
    // 空数组有含义的列表不动
    expect(
      normalizeSecretaryParams('secretary_profile_propose', { visibleProjectIds: [''] })
    ).toEqual({ visibleProjectIds: [''] });
    expect(normalizeSecretaryParams('cleanup_list', { project_id: 'p1' })).toEqual({
      projectId: 'p1',
    });
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

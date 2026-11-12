import { describe, expect, it } from 'vitest';
import {
  parseAgentCommand,
  parseAgentControlToolRequest,
  parseAgentWorkerEvent,
  parseConversationAuthority,
  parseConversationAuthorityRequest,
  parseCreateConversationAuthorityRequest,
  parseCreateProjectAuthorityRequest,
  parseProjectAuthority,
  parseRemoveProjectAuthorityRequest,
  parseSelectProjectAuthorityRequest,
  parseSourceAuthorityProjection,
  parseUpdateConversationSelectionRequest,
  workspaceBranchChangedNote,
} from './agent';
import { child, parent } from './agent.testUtils';

describe('agent control tool protocol', () => {
  it('accepts normalized spawn/send/wait requests with bounded gate shape', () => {
    expect(
      parseAgentControlToolRequest({
        operation: 'spawn',
        mode: 'task',
        description: 'review',
        prompt: 'review it',
        wait: false,
        gate: { commandRef: 'tests' },
      })
    ).not.toBeNull();
    expect(
      parseAgentControlToolRequest({
        operation: 'send',
        agentId: 'agent-1',
        message: 'fix issue',
        delivery: 'next',
        wait: false,
        gate: { commandRef: 'tests' },
      })
    ).not.toBeNull();
    expect(
      parseAgentControlToolRequest({
        operation: 'wait',
        runIds: ['run-1', 'run-2'],
        until: 'any',
        timeoutMs: 100,
      })
    ).not.toBeNull();
  });

  it('rejects invalid operation combinations, duplicate waits and free shell gate', () => {
    for (const request of [
      {
        operation: 'spawn',
        mode: 'task',
        description: 'x',
        prompt: 'x',
        wait: false,
        agentId: 'x',
      },
      {
        operation: 'send',
        agentId: 'a',
        message: 'x',
        delivery: 'auto',
        wait: false,
        mode: 'task',
      },
      { operation: 'wait', runIds: ['same', 'same'], until: 'all' },
      { operation: 'wait', runIds: [], until: 'all' },
      { operation: 'report', runId: 'r', timeoutMs: 1 },
      { operation: 'stop', runId: '' },
      {
        operation: 'spawn',
        mode: 'task',
        description: 'x',
        prompt: 'x',
        wait: false,
        gate: 'pnpm test',
      },
      {
        operation: 'spawn',
        mode: 'task',
        description: 'x',
        prompt: 'x',
        wait: false,
        gate: { argv: [''] },
      },
      {
        operation: 'spawn',
        mode: 'task',
        description: 'x',
        prompt: 'x',
        wait: false,
        gate: { argv: ['pnpm', 'test'] },
      },
    ]) {
      expect(parseAgentControlToolRequest(request)).toBeNull();
    }
  });

  it('worker RPC binds an exact actor identity and request id in both directions', () => {
    const request = { operation: 'report', runId: 'run-1' } as const;
    const invoke = {
      type: 'agent-control-invoke',
      identity: parent,
      seq: 3,
      requestId: 'rpc-1',
      request,
    } as const;
    expect(parseAgentWorkerEvent(invoke)).toEqual(invoke);
    expect(
      parseAgentCommand({
        type: 'agent-control-result',
        identity: parent,
        requestId: 'rpc-1',
        response: { ok: true, value: { runId: 'run-1' } },
      })
    ).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, identity: { sessionId: 'parent' } })).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, requestId: '' })).toBeNull();
    expect(parseAgentCommand({ ...invoke, type: 'agent-control-result' })).toBeNull();
    const cancel = {
      type: 'agent-control-cancel',
      identity: parent,
      seq: 4,
      requestId: 'rpc-1',
      kind: 'detach',
    } as const;
    expect(parseAgentWorkerEvent(cancel)).toEqual(cancel);
    expect(parseAgentWorkerEvent({ ...cancel, kind: 'abort' })).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...cancel, kind: 'stop' })).toBeNull();
    const { kind: _kind, ...withoutKind } = cancel;
    expect(parseAgentWorkerEvent(withoutKind)).toBeNull();
  });

  it('accepts consumption only with exact session generation, sequence and operation nonce', () => {
    const event = {
      type: 'workspace-branch-context-consumed',
      identity: parent,
      seq: 7,
      requestId: 'switch-1',
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, identity: child })).toEqual({
      ...event,
      identity: child,
    });
    for (const patch of [
      { identity: { sessionId: parent.sessionId } },
      { seq: -1 },
      { requestId: '' },
      { branch: 'wrong' },
      { cwd: '/arbitrary' },
    ]) {
      expect(parseAgentWorkerEvent({ ...event, ...patch })).toBeNull();
    }
  });

  it.each(['prompt', 'steer'])('%s 命令可带有界的 deliveryId', (type) => {
    const command = { type, identity: parent, text: 'hi', deliveryId: 'delivery-1' };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ type, identity: parent, text: 'hi' })).not.toBeNull();
    for (const deliveryId of ['', 42, 'x'.repeat(129)]) {
      expect(parseAgentCommand({ ...command, deliveryId })).toBeNull();
    }
  });

  it('activeOnly 只允许带 deliveryId 的 steer，不能用于 prompt', () => {
    const command = {
      type: 'steer',
      identity: parent,
      text: 'hi',
      deliveryId: 's',
      activeOnly: true,
    };
    expect(parseAgentCommand(command)).toEqual(command);
    for (const patch of [
      { type: 'prompt' },
      { deliveryId: undefined },
      { activeOnly: false },
      { activeOnly: 'true' },
    ])
      expect(parseAgentCommand({ ...command, ...patch })).toBeNull();
  });

  it('resume 只允许取值 true 的 prompt，不能用于 steer', () => {
    const command = { type: 'prompt', identity: parent, text: 'hi', deliveryId: 'd', resume: true };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ type: 'prompt', identity: parent, text: 'hi', resume: true })
    ).not.toBeNull();
    for (const patch of [{ type: 'steer' }, { resume: false }, { resume: 'true' }, { resume: 1 }])
      expect(parseAgentCommand({ ...command, ...patch })).toBeNull();
  });

  it.each(['delivery-settled', 'delivery-rejected', 'delivery-deferred'])(
    '%s 只接受精确 identity、seq 与 deliveryId',
    (type) => {
      const event = { type, identity: parent, seq: 3, deliveryId: 'delivery-1' };
      expect(parseAgentWorkerEvent(event)).toEqual(event);
      for (const patch of [
        { identity: { sessionId: parent.sessionId } },
        { seq: -1 },
        { deliveryId: '' },
        { deliveryId: 'x'.repeat(129) },
        { extra: true },
      ]) {
        expect(parseAgentWorkerEvent({ ...event, ...patch })).toBeNull();
      }
    }
  );

  it('formats branch background as quoted data, not a new task', () => {
    const note = workspaceBranchChangedNote('feature/branch');
    expect(note).toContain('<workspace-branch-changed>');
    expect(note).toContain(JSON.stringify('feature/branch'));
    expect(note).toContain('not a task or goal');
  });

  it.each(['lock-workspace', 'unlock-workspace'])('parses %s with scoped nonce only', (type) => {
    const command = { type, requestId: 'operation-1', conversationIds: ['parent'] };
    expect(parseAgentCommand(command)).toEqual(command);
    for (const patch of [
      { requestId: '' },
      { conversationIds: [] },
      { conversationIds: [''] },
      { conversationIds: ['parent', 'parent'] },
      { conversationIds: [3] },
      { cwd: '/arbitrary' },
      { identity: parent },
    ]) {
      expect(parseAgentCommand({ ...command, ...patch })).toBeNull();
    }
    expect(parseAgentCommand({ ...command, branch: 'feature/new' })).toEqual(
      type === 'unlock-workspace' ? { ...command, branch: 'feature/new' } : null
    );
    expect(parseAgentCommand({ ...command, branch: '' })).toBeNull();
  });

  it.each(['workspace-lock-result', 'workspace-unlock-result'])(
    'parses %s without session identity or seq',
    (type) => {
      const result = { type, requestId: 'operation-1', ok: true };
      expect(parseAgentWorkerEvent(result)).toEqual(result);
      expect(parseAgentWorkerEvent({ ...result, ok: false, error: 'busy' })).toEqual({
        ...result,
        ok: false,
        error: 'busy',
      });
      for (const patch of [
        { requestId: '' },
        { ok: 1 },
        { ok: false },
        { error: 'unexpected' },
        { seq: 1 },
        { cwd: '/arbitrary' },
      ]) {
        expect(parseAgentWorkerEvent({ ...result, ...patch })).toBeNull();
      }
    }
  );

  it('插件 MCP 命令：list / call / cancel 严格校验', () => {
    const servers = [{ name: 'bce', transport: 'stdio', command: 'bce-tool' }];
    const list = { type: 'plugin-mcp-list', requestId: 'r1', servers };
    expect(parseAgentCommand(list)).toEqual(list);
    const call = {
      type: 'plugin-mcp-call',
      requestId: 'r2',
      servers,
      server: 'bce',
      tool: 'enhance_prompt',
      args: { prompt: 'x' },
    };
    expect(parseAgentCommand(call)).toEqual(call);
    expect(parseAgentCommand({ type: 'plugin-mcp-cancel', requestId: 'r2' })).toEqual({
      type: 'plugin-mcp-cancel',
      requestId: 'r2',
    });
    for (const bad of [
      { ...list, requestId: '' },
      { ...list, servers: 'x' },
      { ...list, extra: 1 },
      { ...call, server: '' },
      { ...call, tool: 1 },
      { ...call, args: [1] },
      { type: 'plugin-mcp-cancel', requestId: 'r2', extra: 1 },
    ])
      expect(parseAgentCommand(bad)).toBeNull();
  });

  it('插件 MCP 结果：成功带 value，失败带 error', () => {
    const ok = { type: 'plugin-mcp-result', requestId: 'r1', ok: true, value: [] };
    expect(parseAgentWorkerEvent(ok)).toEqual(ok);
    const failed = { type: 'plugin-mcp-result', requestId: 'r1', ok: false, error: 'boom' };
    expect(parseAgentWorkerEvent(failed)).toEqual(failed);
    for (const bad of [
      { ...ok, requestId: '' },
      { ...ok, error: 'x' },
      { ...failed, error: '' },
      { ...failed, value: 1 },
    ])
      expect(parseAgentWorkerEvent(bad)).toBeNull();
  });
});

describe('Main-owned source authority contracts', () => {
  const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('authority projection 使用 Main ids/version，拒绝 child/伪字段/坏版本', () => {
    const project = {
      projectId,
      canonicalPath: '/repo',
      state: 'active',
      version: 1,
    };
    expect(parseProjectAuthority(project)).toEqual(project);
    expect(parseProjectAuthority({ ...project, version: -1 })).toBeNull();
    expect(parseProjectAuthority({ ...project, rendererOwned: true })).toBeNull();

    // 远程项目：必须同时有 sshHost(展示/目标串) 与 sshConnectionId
    const sshProject = {
      ...project,
      kind: 'ssh',
      sshHost: 'user@dev-box',
      sshConnectionId: projectId,
    };
    expect(parseProjectAuthority(sshProject)).toEqual(sshProject);
    const localKind = { ...project, kind: 'local' };
    expect(parseProjectAuthority(localKind)).toEqual(localKind);
    expect(parseProjectAuthority({ ...project, kind: 'ssh' })).toBeNull();
    expect(parseProjectAuthority({ ...project, kind: 'ssh', sshHost: 'user@dev-box' })).toBeNull();
    expect(
      parseProjectAuthority({
        ...project,
        kind: 'ssh',
        sshHost: 'user@dev-box',
        sshConnectionId: 'not-uuid',
      })
    ).toBeNull();
    expect(parseProjectAuthority({ ...project, kind: 'ftp', sshHost: 'h' })).toBeNull();
    expect(parseProjectAuthority({ ...project, sshHost: 'user@dev-box' })).toBeNull();
    expect(parseProjectAuthority({ ...project, kind: 'local', sshHost: 'h' })).toBeNull();
    expect(
      parseProjectAuthority({ ...project, kind: 'local', sshConnectionId: projectId })
    ).toBeNull();

    const conversation = {
      conversationId,
      projectId,
      kind: 'root',
      lifecycle: 'draft',
      version: 2,
      selection: { providerId: 'settings-entry', modelId: 'model-1', revision: 3 },
    };
    expect(
      parseSourceAuthorityProjection({ projects: [project], conversations: [conversation] })
    ).not.toBeNull();
    expect(
      parseSourceAuthorityProjection({
        projects: [project],
        conversations: [conversation],
        fromSettings: true,
      })
    ).toBeNull();
    expect(parseConversationAuthority(conversation)).toEqual(conversation);
    expect(parseConversationAuthority({ ...conversation, kind: 'child' })).toBeNull();
    expect(parseConversationAuthority({ ...conversation, parentId: 'forged' })).toBeNull();
  });

  it('bot-home 项目与 bot 会话绑定只在权威形状里出现，renderer 创建请求不得携带', () => {
    const botId = '33333333-3333-4333-8333-333333333333';
    const chatId = '44444444-4444-4444-8444-444444444444';
    const home = { projectId, canonicalPath: '/u/bots/x/workspace', kind: 'bot-home' };
    expect(parseProjectAuthority({ ...home, state: 'active', version: 1 })).not.toBeNull();
    expect(
      parseProjectAuthority({ ...home, sshHost: 'h', state: 'active', version: 1 })
    ).toBeNull();
    expect(
      parseCreateProjectAuthorityRequest({ requestId: 'p', path: '/x', kind: 'bot-home' })
    ).toBeNull();
    expect(
      parseProjectAuthority({
        projectId,
        canonicalPath: '/u/scratch',
        kind: 'scratch',
        state: 'active',
        version: 1,
      })
    ).not.toBeNull();
    expect(
      parseCreateProjectAuthorityRequest({ requestId: 'p', path: '/x', kind: 'scratch' })
    ).toBeNull();

    const base = { conversationId, projectId, kind: 'root', lifecycle: 'draft', version: 1 };
    const direct = { ...base, bot: { botId, chatId } };
    expect(parseConversationAuthority(direct)).toEqual(direct);
    const delegated = { ...base, bot: { botId, chatId: null, delegationId: 'd-1' } };
    expect(parseConversationAuthority(delegated)).toEqual(delegated);
    expect(parseConversationAuthority({ ...base, bot: { botId: 'x', chatId } })).toBeNull();
    expect(parseConversationAuthority({ ...base, bot: { botId } })).toBeNull();
    expect(parseConversationAuthority({ ...base, bot: { botId, chatId, extra: 1 } })).toBeNull();
    expect(
      parseCreateConversationAuthorityRequest({
        requestId: 'c',
        projectId,
        projectVersion: 1,
        bot: { botId, chatId },
      })
    ).toBeNull();
  });

  it('session-meta 的 occupancy 可带上下文拆分条目，脏条目拒绝', () => {
    const occupancy = {
      buckets: {
        system: 1,
        instructions: 2,
        skills: 0,
        tools: 1,
        conversation: 10,
        compaction: 0,
        projectMemory: 0,
        reminders: 0,
      },
      used: 14,
      estimated: true as const,
      compactedMessageCount: 0,
      compactionModelMismatch: false,
    };
    const parts = [
      { kind: 'tools', tokens: 1, items: [{ name: 'mcp__github', tag: 'mcp', n: 2, tokens: 1 }] },
      { kind: 'chat', tokens: 10, items: [{ name: '1', tag: 'turn', tokens: 10 }] },
    ];
    const event = {
      type: 'session-meta',
      identity: parent,
      seq: 4,
      occupancy: { ...occupancy, parts },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(
      parseAgentWorkerEvent({
        ...event,
        occupancy: { ...occupancy, parts: [{ kind: 'nope', tokens: 1, items: [] }] },
      })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({
        ...event,
        occupancy: {
          ...occupancy,
          parts: [{ kind: 'tools', tokens: 1, items: [{ name: '', tag: '', tokens: 1 }] }],
        },
      })
    ).toBeNull();
    const after = { ...event, occupancy: { ...occupancy, compactionTokensAfter: 12 } };
    expect(parseAgentWorkerEvent(after)).toEqual(after);
    expect(
      parseAgentWorkerEvent({ ...event, occupancy: { ...occupancy, compactionTokensAfter: -1 } })
    ).toBeNull();
  });

  it('project/conversation 专用 mutations strict，id 由 Main result 生成', () => {
    expect(parseCreateProjectAuthorityRequest({ requestId: 'p1', path: '/repo' })).not.toBeNull();
    expect(
      parseCreateProjectAuthorityRequest({ requestId: 'p1', path: '/repo', projectId })
    ).toBeNull();
    // 远程项目创建：只收 sshConnectionId,不收自由 sshHost
    expect(
      parseCreateProjectAuthorityRequest({
        requestId: 'p1',
        path: '/srv/app',
        kind: 'ssh',
        sshConnectionId: projectId,
      })
    ).not.toBeNull();
    expect(
      parseCreateProjectAuthorityRequest({ requestId: 'p1', path: '/srv/app', kind: 'ssh' })
    ).toBeNull();
    expect(
      parseCreateProjectAuthorityRequest({
        requestId: 'p1',
        path: '/srv/app',
        kind: 'ssh',
        sshHost: 'user@dev-box',
      })
    ).toBeNull();
    expect(
      parseCreateProjectAuthorityRequest({
        requestId: 'p1',
        path: '/srv/app',
        sshConnectionId: projectId,
      })
    ).toBeNull();
    expect(
      parseCreateProjectAuthorityRequest({
        requestId: 'p1',
        path: '/srv/app',
        kind: 'bogus',
        sshConnectionId: projectId,
      })
    ).toBeNull();
    expect(
      parseSelectProjectAuthorityRequest({ requestId: 'p2', projectId, version: 1 })
    ).not.toBeNull();
    expect(
      parseRemoveProjectAuthorityRequest({ requestId: 'p3', projectId, version: 1 })
    ).not.toBeNull();
    expect(
      parseCreateConversationAuthorityRequest({
        requestId: 'c1',
        projectId,
        projectVersion: 1,
      })
    ).not.toBeNull();
    expect(
      parseCreateConversationAuthorityRequest({
        requestId: 'c1',
        projectId,
        projectVersion: 1,
        conversationId,
      })
    ).toEqual({
      requestId: 'c1',
      projectId,
      projectVersion: 1,
      conversationId,
    });
    expect(
      parseCreateConversationAuthorityRequest({
        requestId: 'c1',
        projectId,
        projectVersion: 1,
        conversationId: 'not-a-uuid',
      })
    ).toBeNull();
    expect(
      parseCreateConversationAuthorityRequest({
        requestId: 'c1',
        projectId,
        projectVersion: 1,
        forkedFrom: { conversationId, entryId: 'leaf-1' },
      })
    ).toEqual({
      requestId: 'c1',
      projectId,
      projectVersion: 1,
      forkedFrom: { conversationId, entryId: 'leaf-1' },
    });
    expect(
      parseCreateConversationAuthorityRequest({
        requestId: 'c1',
        projectId,
        projectVersion: 1,
        forkedFrom: { conversationId, entryId: '' },
      })
    ).toBeNull();
    expect(
      parseConversationAuthorityRequest({ requestId: 'c2', conversationId, version: 2 })
    ).not.toBeNull();
    expect(
      parseConversationAuthorityRequest({
        requestId: 'c2',
        conversationId,
        version: 2,
        selectionEpoch: 4,
      })
    ).toMatchObject({ selectionEpoch: 4 });
    expect(
      parseConversationAuthorityRequest({
        requestId: 'c2',
        conversationId,
        version: 2,
        selectionEpoch: -1,
      })
    ).toBeNull();
    expect(
      parseConversationAuthorityRequest({
        requestId: 'c2',
        conversationId,
        version: 2,
        selectionEpoch: 4,
        selectionBootId: 'boot-a',
      })
    ).toMatchObject({ selectionBootId: 'boot-a' });
    expect(
      parseConversationAuthorityRequest({
        requestId: 'c2',
        conversationId,
        version: 2,
        selectionBootId: '',
      })
    ).toBeNull();
    expect(
      parseUpdateConversationSelectionRequest({
        requestId: 'c3',
        conversationId,
        version: 2,
        selection: { providerId: 'settings-entry', modelId: 'model-2' },
      })
    ).not.toBeNull();
    expect(
      parseUpdateConversationSelectionRequest({
        requestId: 'c3',
        conversationId,
        version: 2,
        selection: { providerId: 'p', modelId: 'm' },
        available: true,
      })
    ).toBeNull();
  });
});

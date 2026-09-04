import { describe, expect, it } from 'vitest';
import {
  parseAgentCommand,
  parseAgentSessionCustomEntry,
  parseAgentWorkerEvent,
  parseChildSessionIdentity,
  parseConversationAuthority,
  parseConversationAuthorityRequest,
  parseCreateConversationAuthorityRequest,
  parseCreateProjectAuthorityRequest,
  parseDispatchMainEvent,
  parseProjectAuthority,
  parseRemoveProjectAuthorityRequest,
  parseResolvedChildProfileProof,
  parseSafeJournalProjection,
  parseSafeJournalRecord,
  parseSelectProjectAuthorityRequest,
  parseSessionSnapshot,
  parseSourceAuthorityProjection,
  parseUpdateConversationSelectionRequest,
  shouldApplyDispatchMainEvent,
} from './agent';

const PARENT_GENERATION = '11111111-1111-4111-8111-111111111111';
const CHILD_GENERATION = '22222222-2222-4222-8222-222222222222';
const INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const RECEIPT_ID = '44444444-4444-4444-8444-444444444444';
const SPAWN_SPEC_ID = '55555555-5555-4555-8555-555555555555';
const DISPATCH_ID = '66666666-6666-4666-8666-666666666666';

const parent = { sessionId: 'conversation-1', generation: PARENT_GENERATION } as const;
const child = {
  sessionId: 'conversation-1::cw-33333333',
  generation: CHILD_GENERATION,
  parent,
  instanceId: INSTANCE_ID,
  instanceName: 'Enso 3333',
  typeKey: 'agent:enso',
  profileId: 'enso-locked-v1',
} as const;
const model = {
  api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  modelId: 'gpt',
  settingsProviderId: 'provider-entry-1',
};
const task = { text: 'Configure theme', images: [], fileMentions: [] };
const proof = {
  spawnSpecId: SPAWN_SPEC_ID,
  typeKey: 'agent:enso',
  model: { providerId: 'p', modelId: 'm' },
  toolIds: ['enso_capabilities', 'enso_app', 'ask_user'],
  loadedSkillBindingIds: [],
  loadedMcpBindingIds: [],
  systemPromptHash: 'sha256:locked-prompt',
};
const receipt = {
  receiptId: RECEIPT_ID,
  operationId: 'op-1',
  child,
  turnId: 'turn-1',
  requestId: 'cap-1',
  capabilityId: 'appearance.theme',
  risk: 'reversible',
  subject: { kind: 'setting', id: 'theme', label: 'Theme' },
  outcome: 'succeeded',
  summary: 'Theme changed',
  changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
  occurredAt: 1,
  sequence: 0,
};

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

describe('parent/child commands', () => {
  it('spawn-parent 必须 exact generation；旧 spawn/sessionId shape 拒绝', () => {
    const command = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ ...command, identity: { ...parent, generation: 'old' } })
    ).toBeNull();
    expect(
      parseAgentCommand({ type: 'spawn', sessionId: parent.sessionId, cwd: '/repo', model })
    ).toBeNull();
  });

  it('spawn-parent 携 remote:合法通过,坏 shape 拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/srv/app', model };
    const withRemote = { ...base, remote: { host: 'user@dev-box', auth: 'key' } };
    expect(parseAgentCommand(withRemote)).toEqual(withRemote);
    expect(parseAgentCommand({ ...base, remote: { host: 'user@dev-box' } })).toBeNull();
    expect(parseAgentCommand({ ...base, remote: { host: '', auth: 'key' } })).toBeNull();
    expect(parseAgentCommand({ ...base, remote: {} })).toBeNull();
    expect(parseAgentCommand({ ...base, remote: 'user@dev-box' })).toBeNull();
    const withPort = { ...base, remote: { host: 'h', auth: 'key', port: 22 } };
    expect(parseAgentCommand(withPort)).toEqual(withPort);
    const withPassword = {
      ...base,
      remote: { host: 'h', auth: 'password', password: 's3cret' },
    };
    expect(parseAgentCommand(withPassword)).toEqual(withPassword);
    expect(parseAgentCommand({ ...base, remote: { host: 'h', auth: 'password' } })).toBeNull();
    expect(
      parseAgentCommand({
        ...base,
        remote: { host: 'h', auth: 'key', password: 'nope' },
      })
    ).toBeNull();
  });

  it('release-parent 可解析（Move to worktree 依赖；漏白名单会被 worker 静默丢弃）', () => {
    const command = { type: 'release-parent', identity: parent };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ type: 'release-parent' })).toBeNull();
  });

  it('spawn-parent 携 subagentModels:合法通过,坏条目整条拒绝', () => {
    const option = { name: 'openai/gpt', config: model, description: '便宜快,适合简单任务' };
    const command = {
      type: 'spawn-parent',
      identity: parent,
      cwd: '/repo',
      model,
      subagentModels: [option],
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ ...command, subagentModels: [{ name: '', config: model }] })
    ).toBeNull();
    expect(parseAgentCommand({ ...command, subagentModels: [{ name: 'x' }] })).toBeNull();
    expect(
      parseAgentCommand({
        ...command,
        subagentModels: [{ name: 'x', config: model, description: 42 }],
      })
    ).toBeNull();
    expect(
      parseAgentCommand({ ...command, subagentModels: [{ name: 'x', config: model }] })
    ).toEqual({ ...command, subagentModels: [{ name: 'x', config: model }] });
    expect(
      parseAgentCommand({
        ...command,
        subagentModels: [{ name: 'x', config: { ...model, settingsProviderId: '' } }],
      })
    ).toBeNull();
    expect(parseAgentCommand({ ...command, subagentModels: 'nope' })).toBeNull();
  });

  it('spawn model 缺 settingsProviderId 必须拒绝：worker 回报 ready 模型身份要用它', () => {
    // 生产端 spawnModelConfig() 恒发该字段，worker 的 settingsModelRef() 缺了就抛错。
    // 解析器若放行，命令会在 worker 入口被静默丢弃 → Main 只能等 ready 握手超时。
    const { settingsProviderId: _omitted, ...withoutSettingsProvider } = model;
    expect(
      parseAgentCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/repo',
        model: withoutSettingsProvider,
      })
    ).toBeNull();
    expect(
      parseAgentCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/repo',
        model: { ...model, settingsProviderId: '' },
      })
    ).toBeNull();
  });

  it('spawn-child Enso 必须 locked profile、exact tools、无 skills/MCP', () => {
    const command = {
      type: 'spawn-child',
      identity: child,
      cwd: '/repo',
      config: {
        typeKey: 'agent:enso',
        spawnSpecId: SPAWN_SPEC_ID,
        displayName: 'Enso',
        description: 'System agent',
        systemPrompt: 'Locked prompt',
        model,
        tools: 'enso-locked',
        skillBindingIds: [],
        skillPaths: [],
        mcpBindingIds: [],
        systemPromptHash: proof.systemPromptHash,
        mcpServers: [],
        lockedProfileId: 'enso-locked-v1',
      },
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({
        ...command,
        config: { ...command.config, tools: 'all' },
      })
    ).toBeNull();
    expect(
      parseAgentCommand({
        ...command,
        identity: { ...child, profileId: 'other' },
      })
    ).toBeNull();
  });

  it('prompt-child 首条 task 绑定 child generation/requestId，旧 generation 拒绝', () => {
    const command = { type: 'prompt-child', identity: child, requestId: 'dispatch-1', task };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({
        ...command,
        identity: { ...child, generation: PARENT_GENERATION },
      })
    ).toBeNull();
  });

  it('dismiss-coworker 绑 exact parent generation，coworkerId 必须属于该父会话', () => {
    // worker 直雇 coworker（普通身份，不在 Main sessions 索引）的遥控解雇命令；
    // 身份校验落在 parent 上，coworkerId 只做归属校验防跨会话误解雇。
    const command = {
      type: 'dismiss-coworker',
      parent,
      coworkerId: 'conversation-1::cw-bob',
      notify: true,
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, notify: undefined })).toEqual({
      ...command,
      notify: undefined,
    });
    // coworkerId 不属于 parent → 拒绝（防把别的会话的 coworker 解掉）
    expect(parseAgentCommand({ ...command, coworkerId: 'conversation-2::cw-bob' })).toBeNull();
    expect(parseAgentCommand({ ...command, coworkerId: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, parent: { sessionId: 'conversation-1' } })).toBeNull();
    // 未知字段拒绝（白名单三方一致）
    expect(parseAgentCommand({ ...command, resumeFile: '/tmp/x.jsonl' })).toBeNull();
  });

  it('resume-coworker 绑 exact parent，resumeFile 必填，coworkerId 归属校验', () => {
    // 双形状过渡命令：Main 从自己读的持久化取 name/agentType/resumeFile，
    // 渲染层永远不参与——但解析器仍要把关：缺 resumeFile 的、跨会话的都拒。
    const command = {
      type: 'resume-coworker',
      parent,
      coworkerId: 'conversation-1::cw-bob',
      name: 'bob',
      agentType: 'scout',
      resumeFile: '/tmp/sessions/bob.jsonl',
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, agentType: undefined })).toEqual({
      ...command,
      agentType: undefined,
    });
    expect(parseAgentCommand({ ...command, resumeFile: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, resumeFile: undefined })).toBeNull();
    expect(parseAgentCommand({ ...command, name: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, coworkerId: 'conversation-2::cw-bob' })).toBeNull();
    expect(parseAgentCommand({ ...command, extra: 1 })).toBeNull();
  });

  it('capability-result 绑定 child/turn/request 并只接受 envelope', () => {
    const command = {
      type: 'capability-result',
      child,
      turnId: 'turn-1',
      requestId: 'cap-1',
      envelope: { modelResult: { ok: true, data: { changed: true } }, receipt },
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, turnId: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, envelope: { result: { ok: true } } })).toBeNull();
  });
});

describe('标题总结命令与事件', () => {
  const summarize = {
    type: 'summarize-title',
    conversationId: 'conversation-1',
    text: '帮我把登录页的 bug 修一下',
    model,
  };

  it('summarize-title 命令完整往返；缺字段或空值拒绝', () => {
    expect(parseAgentCommand(summarize)).toEqual(summarize);
    expect(parseAgentCommand({ ...summarize, conversationId: '' })).toBeNull();
    expect(parseAgentCommand({ ...summarize, text: '' })).toBeNull();
    expect(parseAgentCommand({ ...summarize, model: undefined })).toBeNull();
    expect(parseAgentCommand({ ...summarize, extra: 1 })).toBeNull();
  });

  it('summarize-title 的 model 缺 settingsProviderId 拒绝（与 spawn 同约束）', () => {
    const { settingsProviderId: _omitted, ...rest } = model;
    expect(parseAgentCommand({ ...summarize, model: rest })).toBeNull();
  });

  it('title-generated 事件完整往返；脏输入不崩', () => {
    const event = {
      type: 'title-generated',
      conversationId: 'conversation-1',
      title: '修复登录 bug',
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, title: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, title: 42 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, conversationId: undefined })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, extra: true })).toBeNull();
  });

  it('turn-failed 的 undelivered 只接受 true/缺省', () => {
    const event = { type: 'turn-failed', identity: parent, seq: 3, turnId: 't', error: 'stuck' };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, undelivered: true })).toEqual({
      ...event,
      undelivered: true,
    });
    expect(parseAgentWorkerEvent({ ...event, undelivered: 'yes' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, undelivered: false })).toBeNull();
  });
});

describe('generation lifecycle/events', () => {
  it('parent/child ready 使用 exact profile proof，缺资源或伪字段拒绝', () => {
    expect(
      parseAgentWorkerEvent({
        type: 'parent-ready',
        identity: parent,
        seq: 1,
        sessionFile: '/parent.jsonl',
        model: { providerId: 'p', modelId: 'm' },
      })
    ).not.toBeNull();
    const ready = {
      type: 'child-ready',
      identity: child,
      seq: 2,
      sessionFile: '/child.jsonl',
      proof,
    };
    expect(parseResolvedChildProfileProof(proof)).toEqual(proof);
    expect(parseAgentWorkerEvent(ready)).toEqual(ready);
    expect(
      parseAgentWorkerEvent({ ...ready, identity: { ...child, generation: 'old' } })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({
        ...ready,
        proof: { ...proof, loadedMcpBindingIds: ['missing-main-binding'] },
      })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({
        ...ready,
        proof: { ...proof, toolIds: [...proof.toolIds, 'bash'] },
      })
    ).toBeNull();
    expect(parseAgentWorkerEvent({ ...ready, rendererVerified: true })).toBeNull();
    expect(
      parseAgentWorkerEvent({ type: 'status', sessionId: child.sessionId, seq: 3, status: 'idle' })
    ).toBeNull();
  });

  it('turn-retry 事件携重试元信息，缺字段或类型不符拒绝', () => {
    const retry = {
      type: 'turn-retry',
      identity: child,
      seq: 3,
      attempt: 1,
      maxAttempts: 3,
      delayMs: 4000,
      error: '503 status code (no body)',
    };
    expect(parseAgentWorkerEvent(retry)).toEqual(retry);
    expect(parseAgentWorkerEvent({ ...retry, attempt: 0 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...retry, maxAttempts: '3' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...retry, delayMs: -1 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...retry, error: '' })).toBeNull();
    const { error: _dropped, ...withoutError } = retry;
    expect(parseAgentWorkerEvent(withoutError)).toBeNull();
  });

  it('session-meta 可带 occupancy；脏桶拒绝', () => {
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
    const event = {
      type: 'session-meta',
      identity: parent,
      seq: 4,
      sessionFile: '/s.jsonl',
      occupancy,
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(
      parseAgentWorkerEvent({
        ...event,
        occupancy: { ...occupancy, estimated: false },
      })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({
        ...event,
        occupancy: { ...occupancy, buckets: { ...occupancy.buckets, system: -1 } },
      })
    ).toBeNull();
  });

  it('abort-retry 命令只携 identity，多余字段拒绝', () => {
    const command = { type: 'abort-retry', identity: parent };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, extra: true })).toBeNull();
    expect(parseAgentCommand({ type: 'abort-retry' })).toBeNull();
  });

  it('retry 命令只携 identity，多余字段拒绝', () => {
    const command = { type: 'retry', identity: parent };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, extra: true })).toBeNull();
    expect(parseAgentCommand({ type: 'retry' })).toBeNull();
  });

  it('snapshot 可带可选 sessionId', () => {
    expect(parseAgentCommand({ type: 'snapshot' })).toEqual({ type: 'snapshot' });
    expect(parseAgentCommand({ type: 'snapshot', sessionId: 'c1' })).toEqual({
      type: 'snapshot',
      sessionId: 'c1',
    });
    expect(parseAgentCommand({ type: 'snapshot', sessionId: '' })).toBeNull();
    expect(parseAgentCommand({ type: 'snapshot', extra: 1 })).toBeNull();
  });

  it('set-proxy-env 只接受 string|null 值的 env 映射，多余字段拒绝', () => {
    // 代理切换后 Main 推给 worker 的 env 补丁；null 表示删除该键。
    const command = {
      type: 'set-proxy-env',
      env: { HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: null },
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, extra: 1 })).toBeNull();
    expect(parseAgentCommand({ type: 'set-proxy-env' })).toBeNull();
    expect(parseAgentCommand({ type: 'set-proxy-env', env: 'x' })).toBeNull();
    expect(parseAgentCommand({ type: 'set-proxy-env', env: { HTTP_PROXY: 1 } })).toBeNull();
    expect(parseAgentCommand({ type: 'set-proxy-env', env: { HTTP_PROXY: undefined } })).toBeNull();
  });

  it('pin-sessions 只接受字符串数组（脏项整体拒绝）', () => {
    expect(parseAgentCommand({ type: 'pin-sessions', sessionIds: [] })).toEqual({
      type: 'pin-sessions',
      sessionIds: [],
    });
    expect(parseAgentCommand({ type: 'pin-sessions', sessionIds: ['a', 'b'] })).toEqual({
      type: 'pin-sessions',
      sessionIds: ['a', 'b'],
    });
    expect(parseAgentCommand({ type: 'pin-sessions', sessionIds: ['a', 1] })).toBeNull();
    expect(parseAgentCommand({ type: 'pin-sessions', sessionIds: 'a' })).toBeNull();
    expect(parseAgentCommand({ type: 'pin-sessions' })).toBeNull();
  });

  it('turn/capability 事件必须 exact identity generation + turnId', () => {
    expect(
      parseAgentWorkerEvent({
        type: 'turn-completed',
        identity: child,
        seq: 3,
        turnId: 'turn-1',
      })
    ).not.toBeNull();
    expect(
      parseAgentWorkerEvent({
        type: 'capability-invoke',
        child,
        seq: 4,
        turnId: 'turn-1',
        requestId: 'cap-1',
        capabilityId: 'appearance.theme',
        params: { value: 'dark' },
      })
    ).not.toBeNull();
    expect(
      parseAgentWorkerEvent({
        type: 'capability-invoke',
        child: { ...child, generation: 'old' },
        seq: 4,
        turnId: 'turn-1',
        requestId: 'cap-1',
        capabilityId: 'appearance.theme',
        params: {},
      })
    ).toBeNull();
  });
});

describe('Main dispatch sequence and terminal authority', () => {
  const running = {
    dispatchId: DISPATCH_ID,
    child,
    mainSeq: 3,
    phase: 'running',
  } as const;
  const terminal = {
    dispatchId: DISPATCH_ID,
    child,
    mainSeq: 4,
    phase: 'terminal',
    terminal: 'completed',
    receiptSummary: 'Theme changed',
  } as const;

  it('只接受同 dispatch/exact child 的递增 Main seq，terminal 只能收口一次', () => {
    expect(parseDispatchMainEvent(running)).toEqual(running);
    expect(parseDispatchMainEvent(terminal)).toEqual(terminal);
    expect(shouldApplyDispatchMainEvent(null, running)).toBe(true);
    expect(shouldApplyDispatchMainEvent(running, { ...running, mainSeq: 2 })).toBe(false);
    expect(shouldApplyDispatchMainEvent(running, terminal)).toBe(true);
    expect(shouldApplyDispatchMainEvent(terminal, { ...terminal, mainSeq: 5 })).toBe(false);
    expect(
      shouldApplyDispatchMainEvent(running, {
        ...terminal,
        child: { ...child, generation: PARENT_GENERATION },
      })
    ).toBe(false);
  });

  it('worker seq/额外 terminal 字段不能伪造 Main dispatch 事件', () => {
    expect(parseDispatchMainEvent({ ...running, seq: 99 })).toBeNull();
    expect(parseDispatchMainEvent({ ...terminal, gatewayDone: true })).toBeNull();
    expect(parseDispatchMainEvent({ ...terminal, mainSeq: -1 })).toBeNull();
  });
});

describe('custom entry and snapshot projection', () => {
  it('dispatch/completed/failed/receipt 是 custom entry，不是 ProjectedMessage', () => {
    const entry = {
      kind: 'capability-receipt',
      receipt,
    };
    expect(parseAgentSessionCustomEntry(entry)).toEqual(entry);
    expect(parseAgentSessionCustomEntry({ role: 'assistant', content: [] })).toBeNull();
  });

  it('SessionSnapshot 只携 safe journal 白名单，并拒绝旧/raw SDK shape', () => {
    const metadata = {
      parentId: parent.sessionId,
      childGeneration: CHILD_GENERATION,
      agentTypeKey: 'agent:enso',
      agentInstanceId: INSTANCE_ID,
      agentInstanceName: 'Enso 3333',
      dispatchOrigin: 'typed-mention',
      lockedProfileId: 'enso-locked-v1',
    };
    const safeJournal = {
      records: [
        { type: 'safe-user-text', text: 'Change the theme', at: 1 },
        {
          type: 'enso-operation',
          operationId: 'op-1',
          capabilityId: 'appearance.theme',
          toolCallId: 'tool-1',
          at: 2,
        },
        {
          type: 'safe-model-result',
          toolCallId: 'tool-1',
          modelResult: { ok: true, data: { changed: true } },
          at: 3,
        },
        { type: 'capability-receipt', receipt, at: 4 },
      ],
      partial: false,
    } as const;
    const snapshot = {
      identity: child,
      status: 'idle',
      messages: [],
      commands: [],
      child: metadata,
      customEntries: [{ kind: 'capability-receipt', receipt }],
      safeJournal,
    };
    expect(parseSafeJournalProjection(safeJournal)).toEqual(safeJournal);
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
    // 压缩状态要能过白名单：漏了整帧 snapshot 会被判 null 静默丢弃，表现是手机全白
    const compacted = { ...snapshot, compaction: 'running', compactionNoticeAt: 12 };
    expect(parseSessionSnapshot(compacted)).toEqual(compacted);
    expect(
      parseSafeJournalRecord({
        type: 'enso-operation',
        operationId: 'op-1',
        capabilityId: 'appearance.theme',
        toolCallId: 'tool-1',
        params: { apiKey: 'secret' },
        at: 2,
      })
    ).toBeNull();
    expect(
      parseSessionSnapshot({
        ...snapshot,
        safeJournal: {
          records: [{ type: 'sdk-message', raw: { params: {} }, at: 1 }],
          partial: false,
        },
      })
    ).toBeNull();
    expect(
      parseSessionSnapshot({
        sessionId: child.sessionId,
        status: 'idle',
        messages: [],
        commands: [],
      })
    ).toBeNull();
  });

  it('ChildSessionIdentity 不允许 parent/child 同 generation 串台或错误 locked profile', () => {
    expect(parseChildSessionIdentity(child)).toEqual(child);
    expect(
      parseChildSessionIdentity({
        ...child,
        parent: { ...parent, generation: 'old' },
      })
    ).toBeNull();
    expect(parseChildSessionIdentity({ ...child, profileId: undefined })).toBeNull();
  });
});

describe('browser-invoke / browser-result', () => {
  const invoke = {
    type: 'browser-invoke',
    identity: parent,
    seq: 5,
    requestId: 'br-1',
    op: 'navigate',
    params: { url: 'http://127.0.0.1:3000' },
  };
  const result = {
    type: 'browser-result',
    identity: parent,
    requestId: 'br-1',
    ok: true,
    result: { url: 'x' },
  };

  it('browser-invoke 只接受闭集 op，identity 可为 parent 或 child', () => {
    expect(parseAgentWorkerEvent(invoke)).toEqual(invoke);
    expect(parseAgentWorkerEvent({ ...invoke, identity: child })).not.toBeNull();
    for (const op of [
      'snapshot',
      'click',
      'type',
      'fill',
      'press_key',
      'scroll',
      'cdp',
      'screenshot',
      'tabs',
      'lock',
      'close',
    ]) {
      expect(parseAgentWorkerEvent({ ...invoke, op })).not.toBeNull();
    }
    expect(parseAgentWorkerEvent({ ...invoke, op: 'hover' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, requestId: '' })).toBeNull();
    expect(
      parseAgentWorkerEvent({ ...invoke, identity: { ...parent, generation: 'old' } })
    ).toBeNull();
    const { params: _p, ...noParams } = invoke;
    expect(parseAgentWorkerEvent(noParams)).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, extra: 1 })).toBeNull();
  });

  it('browser-result 成功带 result，失败带 error，字段互斥', () => {
    expect(parseAgentCommand(result)).toEqual(result);
    const failed = {
      type: 'browser-result',
      identity: parent,
      requestId: 'br-1',
      ok: false,
      error: 'boom',
    };
    expect(parseAgentCommand(failed)).toEqual(failed);
    expect(parseAgentCommand({ ...failed, error: '' })).toBeNull();
    expect(parseAgentCommand({ ...result, ok: false })).toBeNull();
    expect(parseAgentCommand({ ...failed, ok: true })).toBeNull();
    expect(parseAgentCommand({ ...result, requestId: '' })).toBeNull();
    expect(parseAgentCommand({ ...result, extra: 1 })).toBeNull();
  });
});

describe('tool-output 事件跨进程边界', () => {
  const event = {
    type: 'tool-output',
    identity: { sessionId: 's1', generation: '11111111-1111-4111-8111-111111111111' },
    seq: 3,
    toolCallId: 'call-1',
    output: 'step 1\nstep 2',
  };

  it('合法事件原样通过（否则 worker→main 边界会静默丢弃）', () => {
    expect(parseAgentWorkerEvent(event)).toEqual(event);
  });

  it('脏输入拒绝', () => {
    expect(parseAgentWorkerEvent({ ...event, toolCallId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, output: 42 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, identity: undefined })).toBeNull();
  });
});

describe('MCP 旁路事件收窄', () => {
  const status = {
    type: 'mcp-status',
    serverId: 'srv-1',
    serverName: 'notion',
    state: 'ready',
    toolCount: 3,
  };

  it('合法 mcp-status 通过，脏字段拒绝', () => {
    expect(parseAgentWorkerEvent(status)).toEqual(status);
    expect(parseAgentWorkerEvent({ type: 'mcp-status', serverName: 'n', state: 'error' })).toEqual({
      type: 'mcp-status',
      serverName: 'n',
      state: 'error',
    });
    expect(parseAgentWorkerEvent({ ...status, serverId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...status, serverId: 42 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...status, toolCount: 'many' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...status, toolCount: -1 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...status, error: 42 })).toBeNull();
    // 该事件广播到所有窗口：多余字段一律拒绝
    expect(parseAgentWorkerEvent({ ...status, html: '<script>' })).toBeNull();
  });

  it('mcp-tokens-refreshed 裁剪白名单外的 token 字段，不丢整条事件', () => {
    const event = {
      type: 'mcp-tokens-refreshed',
      serverId: 'srv-1',
      tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r', expires_in: 60 },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    // SDK 会保留 id_token：裁掉它，但 refresh 结果必须能落盘（否则轮换的 refresh_token 会丢）
    expect(
      parseAgentWorkerEvent({
        ...event,
        tokens: { access_token: 'a', refresh_token: 'r2', id_token: 'jwt' },
      })
    ).toEqual({
      type: 'mcp-tokens-refreshed',
      serverId: 'srv-1',
      tokens: { access_token: 'a', refresh_token: 'r2' },
    });
    expect(parseAgentWorkerEvent({ ...event, tokens: { token_type: 'Bearer' } })).toBeNull();
    expect(
      parseAgentWorkerEvent({ ...event, tokens: { access_token: 'a', expires_in: 'x' } })
    ).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, extra: 1 })).toBeNull();
  });
});

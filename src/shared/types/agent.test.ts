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

  it('spawn-parent 携 subagentModels:合法通过,坏条目整条拒绝', () => {
    const option = { name: 'openai/gpt', config: model };
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

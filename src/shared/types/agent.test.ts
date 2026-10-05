import { describe, expect, it } from 'vitest';
import {
  parseAgentCommand,
  parseAgentControlToolRequest,
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
  parseTitleSummaryInput,
  parseUpdateConversationSelectionRequest,
  shouldApplyDispatchMainEvent,
  workspaceBranchChangedNote,
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

  it.each(['delivery-settled', 'delivery-rejected'])(
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

describe('parent/child commands', () => {
  it('rewind accepts an exclusive persisted entry anchor and rejects ambiguous or dirty anchors', () => {
    const command = { type: 'rewind', identity: parent, entryId: 'user-entry', restoreFiles: true };
    expect(parseAgentCommand(command)).toEqual(command);
    for (const entryId of ['', ' ', 1, null]) {
      expect(parseAgentCommand({ ...command, entryId })).toBeNull();
    }
    expect(parseAgentCommand({ ...command, userIndexFromEnd: 0 })).toBeNull();
    expect(parseAgentCommand({ ...command, userIndexFromEnd: '0' })).toBeNull();
    expect(parseAgentCommand({ type: 'rewind', identity: parent })).toBeNull();
    expect(
      parseAgentCommand({ type: 'rewind', identity: parent, userIndexFromEnd: 0 })
    ).not.toBeNull();
  });
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

  it('spawn-parent 携 rolePrompt:非空字符串通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, rolePrompt: 'You are aside' })).toEqual({
      ...base,
      rolePrompt: 'You are aside',
    });
    expect(parseAgentCommand({ ...base, rolePrompt: '' })).toBeNull();
    expect(parseAgentCommand({ ...base, rolePrompt: 1 })).toBeNull();
  });

  it('spawn-parent 携 trustedProjectCode:字符串数组通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    const trusted = { ...base, trustedProjectCode: ['.pi/extensions/a.ts', 'package:npm:x'] };
    expect(parseAgentCommand(trusted)).toEqual(trusted);
    expect(parseAgentCommand({ ...base, trustedProjectCode: 'x' })).toBeNull();
    expect(parseAgentCommand({ ...base, trustedProjectCode: [1] })).toBeNull();
    expect(parseAgentCommand({ ...base, trustedProjectCode: ['x'.repeat(2000)] })).toBeNull();
  });

  it('spawn-parent 携插件命令与 hooks:合法通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    const hook = {
      plugin: 'demo',
      root: '/p',
      dataDir: '/d',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'echo hi',
      timeoutSec: 5,
    };
    const command = {
      name: 'demo:review',
      description: 'Review',
      argumentHint: '[focus]',
      content: 'Review $ARGUMENTS',
      filePath: '/p/commands/review.md',
    };
    const full = { ...base, pluginHooks: [hook], pluginCommands: [command] };
    expect(parseAgentCommand(full)).toEqual(full);
    expect(
      parseAgentCommand({ ...base, pluginHooks: [{ ...hook, event: 'Notification' }] })
    ).toBeNull();
    expect(parseAgentCommand({ ...base, pluginHooks: [{ ...hook, timeoutSec: 0 }] })).toBeNull();
    expect(parseAgentCommand({ ...base, pluginHooks: [{ ...hook, extra: 1 }] })).toBeNull();
    expect(
      parseAgentCommand({ ...base, pluginCommands: [{ ...command, content: '' }] })
    ).toBeNull();
    expect(parseAgentCommand({ ...base, pluginCommands: 'x' })).toBeNull();
  });

  it('tool-background 必须 exact identity + 合法 toolCallId', () => {
    const command = { type: 'tool-background', identity: parent, toolCallId: 'call_1|fc_2' };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ ...command, identity: { ...parent, generation: 'old' } })
    ).toBeNull();
    expect(parseAgentCommand({ ...command, toolCallId: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, toolCallId: 'x'.repeat(513) })).toBeNull();
    expect(parseAgentCommand({ ...command, extra: 1 })).toBeNull();
  });

  it('workflow-stop 必须 exact identity + 合法 runId', () => {
    const command = { type: 'workflow-stop', identity: parent, runId: 'run-1' };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ ...command, identity: { ...parent, generation: 'old' } })
    ).toBeNull();
    expect(parseAgentCommand({ ...command, runId: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, runId: 'x'.repeat(81) })).toBeNull();
    expect(parseAgentCommand({ ...command, extra: 1 })).toBeNull();
  });

  it('subagent-stop 必须 exact identity + 非空 agentId', () => {
    const command = { type: 'subagent-stop', identity: parent, agentId: 'agent-1' };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ ...command, identity: { ...parent, generation: 'old' } })
    ).toBeNull();
    expect(parseAgentCommand({ type: 'subagent-stop', identity: parent, agentId: '' })).toBeNull();
    expect(
      parseAgentCommand({ type: 'subagent-stop', sessionId: parent.sessionId, agentId: 'agent-1' })
    ).toBeNull();
  });

  it('set-max-active-coworkers 只接受 1–20 整数', () => {
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 5 })).toEqual({
      type: 'set-max-active-coworkers',
      limit: 5,
    });
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 1 })).not.toBeNull();
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 20 })).not.toBeNull();
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 0 })).toBeNull();
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 21 })).toBeNull();
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 5.5 })).toBeNull();
    expect(parseAgentCommand({ type: 'set-max-active-coworkers' })).toBeNull();
  });

  it('set-disabled-workflow-presets 只接受合法 id 数组', () => {
    expect(
      parseAgentCommand({ type: 'set-disabled-workflow-presets', ids: ['parallel-review'] })
    ).toEqual({ type: 'set-disabled-workflow-presets', ids: ['parallel-review'] });
    expect(parseAgentCommand({ type: 'set-disabled-workflow-presets', ids: [] })).not.toBeNull();
    expect(parseAgentCommand({ type: 'set-disabled-workflow-presets', ids: ['../x'] })).toBeNull();
    expect(parseAgentCommand({ type: 'set-disabled-workflow-presets', ids: 'x' })).toBeNull();
    expect(parseAgentCommand({ type: 'set-disabled-workflow-presets' })).toBeNull();
  });

  it('spawn-parent 携 editMode:仅接受三个互斥模式', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    for (const editMode of ['replace', 'apply_patch'] as const) {
      expect(parseAgentCommand({ ...base, editMode })).toEqual({ ...base, editMode });
    }
    expect(parseAgentCommand({ ...base, editMode: 'patch' })).toBeNull();
    expect(parseAgentCommand({ ...base, editMode: true })).toBeNull();
  });

  it('spawn-parent 继续兼容旧 hashlineEditEnabled，且严格拒绝脏值', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand(base)).toEqual(base);
    expect(parseAgentCommand({ ...base, hashlineEditEnabled: true })).toEqual({
      ...base,
      hashlineEditEnabled: true,
    });
    expect(parseAgentCommand({ ...base, hashlineEditEnabled: false })).toEqual({
      ...base,
      hashlineEditEnabled: false,
    });
    expect(parseAgentCommand({ ...base, hashlineEditEnabled: 'true' })).toBeNull();
    expect(parseAgentCommand({ ...base, hashlineEditEnabled: 1 })).toBeNull();
  });

  it('spawn-parent 携 compactStrategy:仅接受三个互斥策略', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    for (const compactStrategy of ['standard', 'smart', 'continuous-memory'] as const) {
      expect(parseAgentCommand({ ...base, compactStrategy })).toEqual({ ...base, compactStrategy });
    }
    expect(parseAgentCommand({ ...base, compactStrategy: 'plugin' })).toBeNull();
    expect(parseAgentCommand({ ...base, compactStrategy: true })).toBeNull();
  });

  it('spawn-parent 携 smartCompactEnabled:合法通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, smartCompactEnabled: true })).toEqual({
      ...base,
      smartCompactEnabled: true,
    });
    expect(parseAgentCommand({ ...base, smartCompactEnabled: false })).toEqual({
      ...base,
      smartCompactEnabled: false,
    });
    expect(parseAgentCommand({ ...base, smartCompactEnabled: 'true' })).toBeNull();
    expect(parseAgentCommand({ ...base, smartCompactEnabled: 1 })).toBeNull();
  });

  it('spawn-parent 携 smartCompactSummaryModel:合法 spawn config 通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, smartCompactSummaryModel: model })).toEqual({
      ...base,
      smartCompactSummaryModel: model,
    });
    expect(parseAgentCommand({ ...base, smartCompactSummaryModel: { modelId: 'gpt' } })).toBeNull();
    expect(parseAgentCommand({ ...base, smartCompactSummaryModel: 'anthropic/x' })).toBeNull();
  });

  it('spawn-parent / set-model 携虚拟模型配置：成员与分类器严格收窄', () => {
    const virtualModel = {
      ...model,
      settingsProviderId: 'enso-virtual',
      modelId: 'auto-1',
      virtual: {
        name: 'Auto',
        primary: model,
        fast: { ...model, modelId: 'fast' },
        fallbacks: [{ ...model, modelId: 'backup' }],
        classifier: { source: 'judge', timeoutMs: 3000, model: { ...model, modelId: 'fast' } },
      },
    };
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo' };
    expect(parseAgentCommand({ ...base, model: virtualModel })).toEqual({
      ...base,
      model: virtualModel,
    });
    expect(
      parseAgentCommand({ type: 'set-model', identity: parent, model: virtualModel })
    ).not.toBeNull();
    const piClassifier = {
      ...virtualModel,
      virtual: {
        ...virtualModel.virtual,
        classifier: {
          source: 'pi-classifier',
          timeoutMs: 3000,
          classifier: { provider: 'openrouter', modelId: 'typesafe/jev-1.13', apiKey: 'k' },
        },
      },
    };
    expect(parseAgentCommand({ ...base, model: piClassifier })).not.toBeNull();
    const bad = [
      { ...virtualModel, virtual: { ...virtualModel.virtual, primary: { modelId: 'x' } } },
      { ...virtualModel, virtual: { ...virtualModel.virtual, fallbacks: [virtualModel] } },
      { ...virtualModel, virtual: { ...virtualModel.virtual, extra: true } },
      {
        ...virtualModel,
        virtual: { ...virtualModel.virtual, classifier: { source: 'judge', timeoutMs: 3000 } },
      },
      {
        ...virtualModel,
        virtual: {
          ...virtualModel.virtual,
          classifier: {
            source: 'pi-classifier',
            timeoutMs: 0,
            classifier: { provider: 'x', modelId: 'y' },
          },
        },
      },
    ];
    for (const candidate of bad) {
      expect(parseAgentCommand({ ...base, model: candidate })).toBeNull();
    }
    // 辅助用途（代审、压缩摘要）只收真实模型
    expect(parseAgentCommand({ type: 'set-approval-reviewer', model: virtualModel })).toBeNull();
    expect(
      parseAgentCommand({ ...base, model, smartCompactSummaryModel: virtualModel })
    ).toBeNull();
  });

  it('spawn-parent 携 smartCompactMode:合法通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, smartCompactMode: 'balanced' })).toEqual({
      ...base,
      smartCompactMode: 'balanced',
    });
    expect(parseAgentCommand({ ...base, smartCompactMode: 'fast' })).toEqual({
      ...base,
      smartCompactMode: 'fast',
    });
    expect(parseAgentCommand({ ...base, smartCompactMode: 'thorough' })).toEqual({
      ...base,
      smartCompactMode: 'thorough',
    });
    expect(parseAgentCommand({ ...base, smartCompactMode: 'auto' })).toEqual({
      ...base,
      smartCompactMode: 'auto',
    });
    expect(parseAgentCommand({ ...base, smartCompactMode: 'aggressive' })).toBeNull();
    expect(parseAgentCommand({ ...base, smartCompactMode: true })).toBeNull();
  });

  it('spawn-parent 携 windowsLocalShell:合法通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, windowsLocalShell: 'bash' })).toEqual({
      ...base,
      windowsLocalShell: 'bash',
    });
    expect(parseAgentCommand({ ...base, windowsLocalShell: 'auto' })).toEqual({
      ...base,
      windowsLocalShell: 'auto',
    });
    expect(parseAgentCommand({ ...base, windowsLocalShell: 'powershell' })).toEqual({
      ...base,
      windowsLocalShell: 'powershell',
    });
    expect(parseAgentCommand({ ...base, windowsLocalShell: 'pwsh' })).toBeNull();
    expect(parseAgentCommand({ ...base, windowsLocalShell: true })).toBeNull();
  });

  it('spawn-parent 只接受布尔 RTK 开关，兼容未配置旧会话', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand(base)).toEqual(base);
    for (const rtkEnabled of [true, false]) {
      expect(parseAgentCommand({ ...base, rtkEnabled })).toEqual({ ...base, rtkEnabled });
    }
    for (const rtkEnabled of [0, 'false', null, {}]) {
      expect(parseAgentCommand({ ...base, rtkEnabled })).toBeNull();
    }
  });

  it('命令结果统计在 worker 边界校验，非法计数拒绝', () => {
    const event = {
      type: 'message-upsert',
      identity: parent,
      seq: 1,
      index: 0,
      message: {
        role: 'toolResult',
        toolName: 'bash',
        content: [],
        rtk: {
          status: 'compressed',
          originalCommand: 'git status',
          inputTokens: 100,
          outputTokens: 10,
        },
      },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(
      parseAgentWorkerEvent({
        ...event,
        message: { ...event.message, rtk: { ...event.message.rtk, inputTokens: -10 } },
      })
    ).toBeNull();
    const moved = { ...event, message: { ...event.message, backgroundTaskId: 'task-1-abc' } };
    expect(parseAgentWorkerEvent(moved)).toEqual(moved);
    for (const backgroundTaskId of ['', 1, 'x'.repeat(129)]) {
      expect(
        parseAgentWorkerEvent({ ...event, message: { ...event.message, backgroundTaskId } })
      ).toBeNull();
    }
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
    const withTimeout = { ...base, remote: { host: 'h', auth: 'key', timeoutSeconds: 60 } };
    expect(parseAgentCommand(withTimeout)).toEqual(withTimeout);
    for (const timeoutSeconds of [0, 12.5, '60']) {
      expect(
        parseAgentCommand({ ...base, remote: { host: 'h', auth: 'key', timeoutSeconds } })
      ).toBeNull();
    }
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

describe('removed project memory protocol', () => {
  it('拒绝旧记忆管线命令与进度事件', () => {
    expect(
      parseAgentCommand({ type: 'run-memory-pipeline', requestId: RECEIPT_ID, cwd: '/repo', model })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({ type: 'memory-pipeline-done', requestId: RECEIPT_ID, ok: true })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({
        type: 'memory-pipeline-progress',
        requestId: RECEIPT_ID,
        phase: 'stage1',
        current: 1,
        total: 1,
      })
    ).toBeNull();
  });

  it('父会话正常启动，但不再接受旧记忆配置字段', () => {
    const command = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, localMemoryEnabled: true })).toBeNull();
    expect(parseAgentCommand({ ...command, memoryPhase2Model: model })).toBeNull();
  });
});

describe('一次性文本补全命令', () => {
  it('接受正整数输出预算并拒绝脏值', () => {
    const command = {
      type: 'complete-text',
      requestId: 'completion-1',
      systemPrompt: 'system',
      userText: 'user',
      candidates: [model],
      timeoutMs: 1000,
      maxTokens: 1024,
    };
    expect(parseAgentCommand(command)).toEqual(command);
    const { maxTokens: _maxTokens, ...withoutBudget } = command;
    expect(parseAgentCommand(withoutBudget)).toEqual(withoutBudget);
    for (const maxTokens of [0, -1, 1.5, Number.NaN, '1024']) {
      expect(parseAgentCommand({ ...command, maxTokens })).toBeNull();
    }
  });

  it('接受 abort-complete-text 并拒绝脏 requestId', () => {
    const command = { type: 'abort-complete-text', requestId: 'completion-1' };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ type: 'abort-complete-text', requestId: '' })).toBeNull();
    expect(parseAgentCommand({ type: 'abort-complete-text' })).toBeNull();
  });

  it('classify-choice：校验分类器、criteria 与超时', () => {
    const command = {
      type: 'classify-choice',
      requestId: 'route-1',
      classifier: { provider: 'openrouter', modelId: 'cls', apiKey: 'k' },
      state: { message: 'hi', history: [{ speaker: 'Human', text: 'x' }] },
      instructions: 'who replies?',
      criteria: { a: 'Alice', b: 'Bob' },
      timeoutMs: 3000,
    };
    expect(parseAgentCommand(command)).toEqual(command);
    const { apiKey: _apiKey, ...noKey } = command.classifier;
    expect(parseAgentCommand({ ...command, classifier: noKey })).not.toBeNull();
    for (const bad of [
      { ...command, requestId: '' },
      { ...command, classifier: { provider: '', modelId: 'cls' } },
      { ...command, classifier: { ...command.classifier, extra: 1 } },
      { ...command, criteria: {} },
      { ...command, criteria: { a: 1 } },
      { ...command, state: [] },
      { ...command, instructions: 1 },
      { ...command, timeoutMs: 0 },
      { ...command, extra: true },
    ]) {
      expect(parseAgentCommand(bad)).toBeNull();
    }
    expect(parseAgentCommand({ type: 'abort-classify-choice', requestId: 'route-1' })).toEqual({
      type: 'abort-classify-choice',
      requestId: 'route-1',
    });
    expect(parseAgentCommand({ type: 'abort-classify-choice', requestId: '' })).toBeNull();
  });

  it('choice-classified / choice-failed 事件', () => {
    const done = { type: 'choice-classified', requestId: 'r', probabilities: { a: 0.7, b: 0.3 } };
    expect(parseAgentWorkerEvent(done)).toEqual(done);
    expect(parseAgentWorkerEvent({ ...done, probabilities: { a: 'x' } })).toBeNull();
    const failed = { type: 'choice-failed', requestId: 'r', error: 'aborted' };
    expect(parseAgentWorkerEvent(failed)).toEqual(failed);
    expect(parseAgentWorkerEvent({ ...failed, error: '' })).toBeNull();
  });

  it('接受 stream 与 reasoning，拒绝脏值', () => {
    const command = {
      type: 'complete-text',
      requestId: 'completion-1',
      systemPrompt: 'system',
      userText: 'user',
      candidates: [model],
      timeoutMs: 1000,
      stream: true as const,
      reasoning: 'high' as const,
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, reasoning: 'off' })).toEqual({
      ...command,
      reasoning: 'off',
    });
    expect(parseAgentCommand({ ...command, stream: false })).toBeNull();
    expect(parseAgentCommand({ ...command, reasoning: 'nope' })).toBeNull();
  });
});

describe('标题总结命令与事件', () => {
  const secondModel = { ...model, modelId: 'fallback-model' };
  const summarizeInitial = {
    type: 'summarize-title',
    conversationId: 'conversation-1',
    input: { kind: 'initial', text: '帮我把登录页的 bug 修一下' },
    candidates: [model],
  };
  const summarizeRolling = {
    type: 'summarize-title',
    conversationId: 'conversation-1',
    input: {
      kind: 'rolling',
      currentTitle: '修复登录 bug',
      firstUserText: '帮我把登录页的 bug 修一下',
      userText: '这个修复有通用性吗',
      assistantText: '只影响登录路径',
    },
    candidates: [model, secondModel],
  };

  it('summarize-title 命令 initial 输入完整往返；缺字段或空值拒绝', () => {
    expect(parseAgentCommand(summarizeInitial)).toEqual(summarizeInitial);
    expect(parseAgentCommand({ ...summarizeInitial, conversationId: '' })).toBeNull();
    expect(
      parseAgentCommand({ ...summarizeInitial, input: { kind: 'initial', text: '' } })
    ).toBeNull();
    expect(parseAgentCommand({ ...summarizeInitial, candidates: undefined })).toBeNull();
    expect(parseAgentCommand({ ...summarizeInitial, extra: 1 })).toBeNull();
  });

  it('summarize-title 命令 rolling 输入完整往返（含多候选）', () => {
    expect(parseAgentCommand(summarizeRolling)).toEqual(summarizeRolling);
  });

  it('summarize-title candidates 接受 1–3 项；空数组、超过 3 项、非数组拒绝', () => {
    const third = { ...model, modelId: 'third-model' };
    expect(
      parseAgentCommand({ ...summarizeInitial, candidates: [model, secondModel, third] })
    ).not.toBeNull();
    expect(parseAgentCommand({ ...summarizeInitial, candidates: [] })).toBeNull();
    expect(
      parseAgentCommand({
        ...summarizeInitial,
        candidates: [model, secondModel, third, { ...model, modelId: 'fourth' }],
      })
    ).toBeNull();
    expect(parseAgentCommand({ ...summarizeInitial, candidates: model })).toBeNull();
  });

  it('summarize-title 旧形状（单 model 字段而无 candidates）拒绝', () => {
    const { candidates: _omitted, ...rest } = summarizeInitial;
    expect(parseAgentCommand({ ...rest, model })).toBeNull();
  });

  it('summarize-title 旧形状（顶层 text 字段而无 input）拒绝', () => {
    const legacy = {
      type: 'summarize-title',
      conversationId: 'conversation-1',
      text: '帮我把登录页的 bug 修一下',
      candidates: [model],
    };
    expect(parseAgentCommand(legacy)).toBeNull();
  });

  it('summarize-title rolling 缺 currentTitle 拒绝', () => {
    expect(
      parseAgentCommand({
        ...summarizeRolling,
        input: {
          kind: 'rolling',
          currentTitle: '',
          firstUserText: 'f',
          userText: 'x',
          assistantText: 'y',
        },
      })
    ).toBeNull();
  });

  it('summarize-title rolling 缺 firstUserText 键拒绝；firstUserText 允许为空串', () => {
    expect(
      parseAgentCommand({
        ...summarizeRolling,
        input: { kind: 'rolling', currentTitle: 't', userText: 'x', assistantText: 'y' },
      })
    ).toBeNull();
    const emptyAnchor = {
      ...summarizeRolling,
      input: {
        kind: 'rolling',
        currentTitle: 't',
        firstUserText: '',
        userText: 'x',
        assistantText: 'y',
      },
    };
    expect(parseAgentCommand(emptyAnchor)).toEqual(emptyAnchor);
  });

  it('summarize-title rolling 的 userText 与 assistantText 都为空串拒绝', () => {
    expect(
      parseAgentCommand({
        ...summarizeRolling,
        input: {
          kind: 'rolling',
          currentTitle: 't',
          firstUserText: 'f',
          userText: '',
          assistantText: '',
        },
      })
    ).toBeNull();
  });

  it('summarize-title initial 的 text 为空拒绝', () => {
    expect(
      parseAgentCommand({ ...summarizeInitial, input: { kind: 'initial', text: '   ' } })
    ).toBeNull();
  });

  it('summarize-title 的候选缺 settingsProviderId 拒绝（与 spawn 同约束）', () => {
    const { settingsProviderId: _omitted, ...rest } = model;
    expect(parseAgentCommand({ ...summarizeInitial, candidates: [rest] })).toBeNull();
    expect(parseAgentCommand({ ...summarizeInitial, candidates: [model, rest] })).toBeNull();
  });

  it('parseTitleSummaryInput 直接单测：initial / rolling 合法形状通过', () => {
    expect(parseTitleSummaryInput({ kind: 'initial', text: 'hi' })).toEqual({
      kind: 'initial',
      text: 'hi',
    });
    expect(
      parseTitleSummaryInput({
        kind: 'rolling',
        currentTitle: 't',
        firstUserText: 'f',
        userText: 'u',
        assistantText: 'a',
      })
    ).toEqual({
      kind: 'rolling',
      currentTitle: 't',
      firstUserText: 'f',
      userText: 'u',
      assistantText: 'a',
    });
  });

  it('parseTitleSummaryInput 直接单测：非法形状返回 null', () => {
    expect(parseTitleSummaryInput(null)).toBeNull();
    expect(parseTitleSummaryInput({})).toBeNull();
    expect(parseTitleSummaryInput({ kind: 'initial' })).toBeNull();
    expect(parseTitleSummaryInput({ kind: 'initial', text: '' })).toBeNull();
    expect(
      parseTitleSummaryInput({
        kind: 'rolling',
        currentTitle: '',
        firstUserText: 'f',
        userText: 'u',
        assistantText: 'a',
      })
    ).toBeNull();
    expect(
      parseTitleSummaryInput({
        kind: 'rolling',
        currentTitle: 't',
        firstUserText: 'f',
        userText: '',
        assistantText: '',
      })
    ).toBeNull();
    expect(
      parseTitleSummaryInput({
        kind: 'rolling',
        currentTitle: 't',
        firstUserText: 'f',
        userText: 1,
        assistantText: 'a',
      })
    ).toBeNull();
    expect(
      parseTitleSummaryInput({
        kind: 'rolling',
        currentTitle: 't',
        firstUserText: 1,
        userText: 'u',
        assistantText: 'a',
      })
    ).toBeNull();
    expect(parseTitleSummaryInput({ kind: 'other', text: 'x' })).toBeNull();
    expect(parseTitleSummaryInput({ kind: 'initial', text: 'x', extra: 1 })).toBeNull();
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

  it('text-delta 允许空 text，thinking 可选，拒绝脏输入', () => {
    const event = { type: 'text-delta', requestId: 'completion-1', text: 'hel' };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, text: '' })).toEqual({ ...event, text: '' });
    expect(parseAgentWorkerEvent({ ...event, thinking: 'hmm' })).toEqual({
      ...event,
      thinking: 'hmm',
    });
    expect(parseAgentWorkerEvent({ ...event, thinking: 1 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, requestId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, extra: true })).toBeNull();
  });

  it('rewind-done 保留待回填图片并拒绝脏图片', () => {
    const event = {
      type: 'rewind-done',
      identity: parent,
      seq: 3,
      editorText: '再试一次',
      editorImages: [{ data: 'AAAA', mimeType: 'image/png' }],
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(
      parseAgentWorkerEvent({ ...event, editorImages: [{ data: 7, mimeType: 'image/png' }] })
    ).toBeNull();
  });

  it('snapshot 事件外壳保留 partial / sessionId：空 targeted 快照靠 sessionId 路由收回 started', () => {
    const empty = { type: 'snapshot', sessions: [], partial: true, sessionId: 'evicted' };
    expect(parseAgentWorkerEvent(empty)).toEqual(empty);
    const full = { type: 'snapshot', sessions: [] };
    expect(parseAgentWorkerEvent(full)).toEqual(full);
    expect(parseAgentWorkerEvent({ type: 'snapshot', sessions: [{ bogus: true }] })).toBeNull();
  });

  it('title-failed 事件完整往返；缺 error / 空串 / 多余键 → null', () => {
    const event = {
      type: 'title-failed',
      conversationId: 'conversation-1',
      error: 'cursor/composer-2.5-fast: timed out after 60s',
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, error: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, error: undefined })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, error: 7 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, conversationId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, identity: parent })).toBeNull();
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

  it('turn-completed 带合法 digest 往返', () => {
    const event = {
      type: 'turn-completed',
      identity: parent,
      seq: 1,
      turnId: 'turn-1',
      digest: { firstUserText: '开场请求', userText: '本轮请求', assistantText: '本轮结论' },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
  });

  it('turn-completed digest 的 firstUserText 允许空串（冷会话无首条）', () => {
    const event = {
      type: 'turn-completed',
      identity: parent,
      seq: 1,
      turnId: 'turn-1',
      digest: { firstUserText: '', userText: '本轮请求', assistantText: '本轮结论' },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
  });

  it('turn-completed digest 形状非法 → 整条事件返回 null', () => {
    const base = {
      type: 'turn-completed',
      identity: parent,
      seq: 1,
      turnId: 'turn-1',
    };
    expect(
      parseAgentWorkerEvent({
        ...base,
        digest: { firstUserText: 'f', userText: 1, assistantText: 'a' },
      })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({ ...base, digest: { firstUserText: 'f', userText: 'u' } })
    ).toBeNull();
    // 旧两键形状：缺 firstUserText 即拒绝，不做兼容层
    expect(
      parseAgentWorkerEvent({ ...base, digest: { userText: 'u', assistantText: 'a' } })
    ).toBeNull();
    expect(parseAgentWorkerEvent({ ...base, digest: 'nope' })).toBeNull();
    expect(
      parseAgentWorkerEvent({
        ...base,
        digest: { firstUserText: 'f', userText: 'u', assistantText: 'a', extra: 1 },
      })
    ).toBeNull();
  });

  it('turn-completed 无 digest 仍合法', () => {
    const event = {
      type: 'turn-completed',
      identity: parent,
      seq: 1,
      turnId: 'turn-1',
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
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

  it('session-meta 可带 usageTotals；脏统计只丢统计不丢事件', () => {
    const usageTotals = { inputTokens: 300, outputTokens: 10, cacheHitPercent: 63 };
    const withTotals = { type: 'session-meta', identity: parent, seq: 5, usageTotals };
    expect(parseAgentWorkerEvent(withTotals)).toEqual(withTotals);
    expect(
      parseAgentWorkerEvent({ ...withTotals, usageTotals: { inputTokens: -1, outputTokens: 'x' } })
    ).toEqual({ type: 'session-meta', identity: parent, seq: 5 });
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
    ).toEqual({
      ...event,
      occupancy: { ...occupancy, estimated: false },
    });
    expect(
      parseAgentWorkerEvent({
        ...event,
        occupancy: { ...occupancy, estimated: 'yes' },
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

  it('set-approval-mode 接受 assistant 合法字面量；未知 mode 不解析成 assistant', () => {
    const base = { type: 'set-approval-mode', identity: parent, mode: 'assistant' };
    expect(parseAgentCommand(base)).toEqual(base);
    expect(parseAgentCommand({ ...base, mode: 'bogus-mode' })).toBeNull();
    expect(parseAgentCommand({ ...base, mode: undefined })).toBeNull();
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
  const minimalSnapshot = {
    identity: parent,
    status: 'idle',
    messages: [],
    commands: [],
  } as const;

  it('SessionSnapshot 接受非负整数 baseIndex', () => {
    expect(parseSessionSnapshot({ ...minimalSnapshot, baseIndex: 12 })).toEqual({
      ...minimalSnapshot,
      baseIndex: 12,
    });
  });

  it('SessionSnapshot 拒绝负数 baseIndex', () => {
    expect(parseSessionSnapshot(minimalSnapshot)).toEqual(minimalSnapshot);
    expect(parseSessionSnapshot({ ...minimalSnapshot, baseIndex: -1 })).toBeNull();
  });

  it('SessionSnapshot 拒绝非整数 baseIndex', () => {
    expect(parseSessionSnapshot(minimalSnapshot)).toEqual(minimalSnapshot);
    expect(parseSessionSnapshot({ ...minimalSnapshot, baseIndex: 1.5 })).toBeNull();
  });

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

describe('memory-invoke / memory-result', () => {
  it('delegation-invoke 接受 group_history，拒绝未知 op', () => {
    const event = {
      type: 'delegation-invoke',
      identity: parent,
      seq: 1,
      requestId: 'd-1',
      op: 'group_history',
      params: { limit: 5 },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, op: 'group_secrets' })).toBeNull();
  });

  const invoke = {
    type: 'memory-invoke',
    identity: parent,
    seq: 5,
    requestId: 'mem-1',
    op: 'search',
    params: { query: 'pg', limit: 10, spaceId: 'all' },
  };
  const result = {
    type: 'memory-result',
    identity: parent,
    requestId: 'mem-1',
    ok: true,
    result: { results: [] },
  };

  it('memory-invoke 只接受闭集 op，identity 可为 parent 或 child', () => {
    expect(parseAgentWorkerEvent(invoke)).toEqual(invoke);
    expect(parseAgentWorkerEvent({ ...invoke, identity: child })).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, op: 'capture' })).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, op: 'delete' })).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, op: 'purge' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, requestId: '' })).toBeNull();
    const { params: _p, ...noParams } = invoke;
    expect(parseAgentWorkerEvent(noParams)).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, extra: 1 })).toBeNull();
  });

  it('memory-result 成功带 result，失败带 error，字段互斥', () => {
    expect(parseAgentCommand(result)).toEqual(result);
    const failed = { ...result, ok: false, error: 'boom', result: undefined };
    delete (failed as { result?: unknown }).result;
    expect(parseAgentCommand(failed)).toEqual(failed);
    expect(parseAgentCommand({ ...failed, error: '' })).toBeNull();
    expect(parseAgentCommand({ ...result, ok: false })).toBeNull();
    expect(parseAgentCommand({ ...result, extra: 1 })).toBeNull();
  });
});

describe('computer-invoke / computer-result', () => {
  const invoke = {
    type: 'computer-invoke',
    identity: parent,
    seq: 5,
    requestId: 'cu-1',
    op: 'run',
    params: { code: 'return 1', readOnly: true, timeoutSec: 12 },
  };
  const result = {
    type: 'computer-result',
    identity: parent,
    requestId: 'cu-1',
    ok: true,
    result: { text: '1', screenshots: [] },
  };

  it('computer-invoke 只接受 run', () => {
    expect(parseAgentWorkerEvent(invoke)).toEqual(invoke);
    expect(parseAgentWorkerEvent({ ...invoke, identity: child })).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, op: 'click' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, extra: 1 })).toBeNull();
  });

  it('computer-cancel 只带 requestId', () => {
    const cancel = { type: 'computer-cancel', identity: parent, seq: 6, requestId: 'cu-1' };
    expect(parseAgentWorkerEvent(cancel)).toEqual(cancel);
    expect(parseAgentWorkerEvent({ ...cancel, requestId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...cancel, extra: 1 })).toBeNull();
  });

  it('computer-result 成功带 result，失败带 error，字段互斥', () => {
    expect(parseAgentCommand(result)).toEqual(result);
    const failed = {
      type: 'computer-result',
      identity: parent,
      requestId: 'cu-1',
      ok: false,
      error: 'boom',
    };
    expect(parseAgentCommand(failed)).toEqual(failed);
    expect(parseAgentCommand({ ...result, ok: false })).toBeNull();
    expect(parseAgentCommand({ ...failed, ok: true })).toBeNull();
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

  it('可选 startedAt 随事件通过，脏数字拒绝', () => {
    expect(parseAgentWorkerEvent({ ...event, startedAt: 1_000 })).toEqual({
      ...event,
      startedAt: 1_000,
    });
    expect(parseAgentWorkerEvent({ ...event, startedAt: 'now' })).toBeNull();
  });

  it('可选 deadlineAt 随事件通过，脏数字拒绝', () => {
    expect(parseAgentWorkerEvent({ ...event, deadlineAt: 2_000 })).toEqual({
      ...event,
      deadlineAt: 2_000,
    });
    expect(parseAgentWorkerEvent({ ...event, deadlineAt: 'later' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, deadlineAt: Number.NaN })).toBeNull();
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

  it('mcp-status 的 scopeChallenge 只收字符串 scope 与合法 URL', () => {
    const challenged = {
      ...status,
      state: 'unauthorized',
      scopeChallenge: {
        scope: 'files:write',
        resourceMetadataUrl: 'https://mcp.test/.well-known/x',
      },
    };
    expect(parseAgentWorkerEvent(challenged)).toEqual(challenged);
    expect(parseAgentWorkerEvent({ ...status, scopeChallenge: { scope: 1 } })).toBeNull();
    expect(
      parseAgentWorkerEvent({ ...status, scopeChallenge: { resourceMetadataUrl: 'not a url' } })
    ).toBeNull();
    expect(parseAgentWorkerEvent({ ...status, scopeChallenge: { scope: 'a', x: 1 } })).toBeNull();
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

describe('apply_patch fileChanges 事件收窄', () => {
  const event = {
    type: 'message-upsert',
    identity: parent,
    seq: 1,
    index: 0,
    message: {
      role: 'toolResult',
      content: [],
      toolName: 'apply_patch',
      fileChanges: [{ path: 'a.ts', oldText: 'a', newText: 'b', type: 'update' }],
      applyPatchOutcome: {
        status: 'partial',
        applied: ['a.ts'],
        failed: ['b.ts'],
        error: 'write failed',
        unattempted: ['c.ts'],
        uncertain: [],
      },
    },
  } as const;

  it('接受完整白名单形状与显式 truncated', () => {
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(
      parseAgentWorkerEvent({
        ...event,
        message: {
          ...event.message,
          applyPatchOutcome: {
            ...event.message.applyPatchOutcome,
            input: '*** Begin Patch\n*** End Patch',
          },
        },
      })
    ).not.toBeNull();
    expect(
      parseAgentWorkerEvent({
        ...event,
        message: {
          ...event.message,
          fileChanges: [{ ...event.message.fileChanges[0], oldText: 'a\n…', truncated: true }],
        },
      })
    ).not.toBeNull();
  });

  it('snapshot 同样收窄嵌套消息的 fileChanges', () => {
    expect(
      parseSessionSnapshot({
        identity: parent,
        status: 'idle',
        messages: [event.message],
        commands: [],
      })
    ).not.toBeNull();
    expect(
      parseSessionSnapshot({
        identity: parent,
        status: 'idle',
        messages: [
          { ...event.message, fileChanges: [{ ...event.message.fileChanges[0], extra: 1 }] },
        ],
        commands: [],
      })
    ).toBeNull();
  });

  it('拒绝 applyPatchOutcome 脏字段、超预算路径与不一致 applied', () => {
    for (const applyPatchOutcome of [
      { ...event.message.applyPatchOutcome, status: 'unknown' },
      { ...event.message.applyPatchOutcome, failed: 'b.ts' },
      { ...event.message.applyPatchOutcome, applied: ['other.ts'] },
      { ...event.message.applyPatchOutcome, failed: ['x'.repeat(4_097)] },
      { ...event.message.applyPatchOutcome, extra: true },
      { ...event.message.applyPatchOutcome, errorTruncated: false },
      { ...event.message.applyPatchOutcome, inputTruncated: false },
      { ...event.message.applyPatchOutcome, input: '' },
    ]) {
      expect(
        parseAgentWorkerEvent({ ...event, message: { ...event.message, applyPatchOutcome } })
      ).toBeNull();
    }
  });

  it('拒绝 fileChanges 脏字段、错误类型与不显式的 truncated=false', () => {
    for (const fileChanges of [
      [{ ...event.message.fileChanges[0], secret: 'x' }],
      [{ ...event.message.fileChanges[0], oldText: 1 }],
      [{ ...event.message.fileChanges[0], type: 'move' }],
      [{ ...event.message.fileChanges[0], truncated: false }],
      null,
    ]) {
      expect(
        parseAgentWorkerEvent({ ...event, message: { ...event.message, fileChanges } })
      ).toBeNull();
    }
  });
});

describe('spawn-parent system prompt 协议', () => {
  it('spawn-parent 携 systemPrompt:非空字符串通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, systemPrompt: 'custom base prompt' })).not.toBeNull();
    expect(parseAgentCommand({ ...base, systemPrompt: '' })).toBeNull();
    expect(parseAgentCommand({ ...base, systemPrompt: 1 })).toBeNull();
  });
});

describe('受保护动作底线协议', () => {
  it('spawn-parent 携 botWriteLock：名字与祖先会话列表齐全才通过', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(
      parseAgentCommand({ ...base, botWriteLock: { label: 'alice', ancestors: ['p'] } })
    ).toMatchObject({ botWriteLock: { label: 'alice', ancestors: ['p'] } });
    expect(parseAgentCommand({ ...base, botWriteLock: { label: 'alice' } })).toBeNull();
    expect(parseAgentCommand({ ...base, botWriteLock: { label: '', ancestors: [] } })).toBeNull();
    expect(parseAgentCommand({ ...base, botWriteLock: { label: 'a', ancestors: [1] } })).toBeNull();
  });

  it('spawn-parent 携 protectedActions：布尔通过，脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, protectedActions: true })).not.toBeNull();
    expect(parseAgentCommand({ ...base, protectedActions: 'yes' })).toBeNull();
  });

  it('approval-request 的 protected 只接受已知类别', () => {
    const event = {
      type: 'approval-request',
      identity: parent,
      seq: 1,
      request: { requestId: 'r1', tool: 'bash', kind: 'command', summary: 'rm -rf x' },
    };
    const withProtected = { ...event, request: { ...event.request, protected: 'delete' } };
    expect(parseAgentWorkerEvent(withProtected)).toEqual(withProtected);
    expect(
      parseAgentWorkerEvent({ ...event, request: { ...event.request, protected: 'nuke' } })
    ).toBeNull();
  });
});

describe('等人超时协议', () => {
  it('request-timeout 命令只接受 approval / ask 与非空 requestId', () => {
    const base = { type: 'request-timeout', identity: parent, requestId: 'r1' };
    expect(parseAgentCommand({ ...base, kind: 'approval' })).toEqual({ ...base, kind: 'approval' });
    expect(parseAgentCommand({ ...base, kind: 'ask' })).not.toBeNull();
    expect(parseAgentCommand({ ...base, kind: 'plan' })).toBeNull();
    expect(parseAgentCommand({ ...base, kind: 'ask', requestId: '' })).toBeNull();
    expect(parseAgentCommand({ ...base, kind: 'ask', extra: 1 })).toBeNull();
  });

  it('approval-request / ask-request 的 expiresAt 必须是有限数字', () => {
    const approval = {
      type: 'approval-request',
      identity: parent,
      seq: 1,
      request: { requestId: 'r1', tool: 'bash', kind: 'command', summary: 'ls', expiresAt: 5 },
    };
    expect(parseAgentWorkerEvent(approval)).toEqual(approval);
    expect(
      parseAgentWorkerEvent({ ...approval, request: { ...approval.request, expiresAt: 'x' } })
    ).toBeNull();
    const ask = {
      type: 'ask-request',
      identity: parent,
      seq: 2,
      ask: { requestId: 'q', question: 'q', expiresAt: 5 },
    };
    expect(parseAgentWorkerEvent(ask)).toEqual(ask);
    expect(
      parseAgentWorkerEvent({ ...ask, ask: { ...ask.ask, expiresAt: Number.NaN } })
    ).toBeNull();
  });
});

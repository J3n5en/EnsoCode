import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type { CapabilityReceipt } from '@shared/capabilities/types';
import type {
  AgentSessionCustomEntry,
  DispatchMainEvent,
  ResolvedAgentTypeSpawnConfig,
} from '@shared/types/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveConversationRegistry } from './activeConversationRegistry';
import { AgentDispatchService } from './agentDispatchService';
import { AgentSessionIndex } from './agentSessionIndex';
import { SourceAuthorityRegistry } from './sourceAuthorityRegistry';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface SetupOptions {
  /** 注入持久化会话状态（settings.json 的 enso-conversations.state） */
  persistedState?: (conversationId: string) => Record<string, unknown>;
  /** 覆盖 resolveAgentType（模拟类型已删） */
  resolveAgentTypeError?: string;
}

async function setup(
  proofOverride?: (proof: ResolvedAgentTypeSpawnConfig) => Partial<ResolvedAgentTypeSpawnConfig>,
  options: SetupOptions = {}
) {
  const root = path.join(process.cwd(), 'temp', `dispatch-${crypto.randomUUID()}`);
  const projectPath = path.join(root, 'project');
  mkdirSync(projectPath, { recursive: true });
  roots.push(root);
  const authority = new SourceAuthorityRegistry({ registryFile: path.join(root, 'registry.json') });
  const project = authority.createProject({ requestId: 'p', path: projectPath });
  if (!project.accepted) throw new Error(project.error);
  const conversation = authority.createConversation({
    requestId: 'c',
    projectId: project.value.projectId,
    projectVersion: project.value.version,
  });
  if (!conversation.accepted) throw new Error(conversation.error);
  const selected = authority.updateSelection({
    requestId: 's',
    conversationId: conversation.value.conversationId,
    version: conversation.value.version,
    selection: { providerId: 'provider', modelId: 'model' },
  });
  if (!selected.accepted) throw new Error(selected.error);
  let persistedConversationId = '';
  const index = new AgentSessionIndex({
    readSettings: () =>
      options.persistedState && persistedConversationId
        ? {
            'enso-conversations': {
              state: options.persistedState(persistedConversationId),
            },
          }
        : null,
  });
  persistedConversationId = conversation.value.conversationId;
  const bindings = new ActiveConversationRegistry({
    authority,
    sessionIndex: index,
    isMainWebContents: (id) => id === 1,
  });
  bindings.selectConversation(1, selected.value.conversationId);
  const parentBinding = bindings.bindSource(1, { requestId: 'bind' });
  if (!parentBinding.accepted) throw new Error(parentBinding.error);
  const selection = bindings.registerModelSelection(
    1,
    {
      parentBindingId: parentBinding.parentBindingId,
      selection: { providerId: 'provider', modelId: 'model' },
    },
    true
  );
  if (!selection.accepted) throw new Error(selection.error);
  const config: ResolvedAgentTypeSpawnConfig = {
    typeKey: 'agent:enso',
    displayName: 'Enso',
    description: 'Built in',
    spawnSpecId: crypto.randomUUID(),
    systemPrompt: 'safe',
    model: Object.assign(
      {
        api: 'openai-completions' as const,
        baseUrl: 'https://example.com',
        apiKey: 'key',
        modelId: 'model',
      },
      { settingsProviderId: 'provider' }
    ),
    tools: 'enso-locked',
    skillPaths: [],
    skillBindingIds: [],
    mcpServers: [],
    mcpBindingIds: [],
    systemPromptHash: 'hash',
    lockedProfileId: 'enso-locked-v1',
  };
  const mainEvents: DispatchMainEvent[] = [];
  const customEntries: AgentSessionCustomEntry[] = [];
  const spawnChildCalls: Array<{
    identity: ChildSessionIdentity;
    cwd: string;
    resumeFile?: string;
  }> = [];
  const resumeCoworkerCalls: Array<{
    parent: { sessionId: string; generation: string };
    coworkerId: string;
    name: string;
    agentType?: string;
    resumeFile: string;
  }> = [];
  const capabilityBindings: ChildSessionIdentity[] = [];
  const terminatedGenerations: ChildSessionIdentity[] = [];
  let service!: AgentDispatchService;
  service = new AgentDispatchService({
    registerCapabilityInvocation: (context) => {
      capabilityBindings.push(context.child);
      return true;
    },
    terminateGeneration: (child) => {
      terminatedGenerations.push(child);
    },
    sourceRegistry: bindings,
    sessionIndex: index,
    readStoredOauthCredentialKeys: async () => new Set(),
    emitRendererEvent: () => {},
    emitDispatchEvent: (_owner, event) => mainEvents.push(event),
    host: {
      registrySnapshot: () => ({
        revision: 1,
        candidates: [
          {
            kind: 'agent-type',
            id: 'agent:enso',
            typeKey: 'agent:enso',
            displayName: 'Enso',
            description: 'Built in',
            source: 'system',
            locked: true,
            canDisable: false,
            canEdit: false,
          },
        ],
      }),
      resolveModel: () => ({
        ok: true,
        selection: {
          ref: { providerId: 'provider', modelId: 'model' },
          runtimeRef: { providerId: 'runtime', modelId: 'model' },
          config: config.model,
        },
      }),
      resolveAgentType: () =>
        options.resolveAgentTypeError
          ? { ok: false, error: options.resolveAgentTypeError }
          : {
              ok: true,
              config,
              expectedModel: { providerId: 'provider', modelId: 'model' },
              expectedToolIds: ['enso_capabilities', 'enso_app', 'ask_user'],
            },
      spawnParent: (identity) => {
        queueMicrotask(() =>
          service.observe({
            type: 'parent-ready',
            identity,
            seq: 1,
            sessionFile: path.join(root, 'parent.jsonl'),
            model: { providerId: 'provider', modelId: 'model' },
          })
        );
        return { ok: true };
      },
      spawnChild: (identity, cwd, _config, resumeFile) => {
        spawnChildCalls.push({ identity, cwd, ...(resumeFile ? { resumeFile } : {}) });
        const altered = proofOverride?.(config) ?? {};
        queueMicrotask(() =>
          service.observe({
            type: 'child-ready',
            identity,
            seq: 1,
            sessionFile: path.join(root, 'child.jsonl'),
            proof: {
              spawnSpecId: altered.spawnSpecId ?? config.spawnSpecId,
              typeKey: config.typeKey,
              model: { providerId: 'provider', modelId: 'model' },
              toolIds: ['enso_capabilities', 'enso_app', 'ask_user'],
              loadedSkillBindingIds: config.skillBindingIds,
              loadedMcpBindingIds: config.mcpBindingIds,
              systemPromptHash: altered.systemPromptHash ?? config.systemPromptHash,
            },
          })
        );
        return { ok: true };
      },
      promptChild: () => ({ ok: true }),
      appendCustomEntry: (_identity, entry) => {
        customEntries.push(entry);
        return { ok: true };
      },
      dismissChild: () => ({ ok: true }),
      resumeCoworker: (parent, coworkerId, name, agentType, resumeFile) => {
        resumeCoworkerCalls.push({
          parent,
          coworkerId,
          name,
          ...(agentType ? { agentType } : {}),
          resumeFile,
        });
        return { ok: true };
      },
    },
  });
  return {
    service,
    conversationId: conversation.value.conversationId,
    selectionBindingId: selection.binding.selectionBindingId,
    mainEvents,
    customEntries,
    bindings,
    index,
    spawnChildCalls,
    resumeCoworkerCalls,
    capabilityBindings,
    terminatedGenerations,
    root,
  };
}

describe('AgentDispatchService delta coordination', () => {
  it('receipt 的每笔调用 requestId 与派发 requestId 不同时，完成通知仍带安全 summary', async () => {
    const { service, selectionBindingId, customEntries } = await setup();
    const result = await service.dispatch(
      {
        requestId: 'turn-1',
        selectionBindingId,
        typeKey: 'agent:enso',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const child = result.child;
    // 生产形状：ensoApp 每笔 capability 调用自己 randomUUID()，与派发 requestId 无关。
    const callRequestId = 'capability-call-uuid';
    service.observeReceipt({
      type: 'receipt-started',
      child,
      turnId: 'turn-1',
      requestId: callRequestId,
      receiptId: 'r1',
      receiptSeq: 1,
      executionState: 'executing',
    });
    service.observe({ type: 'turn-completed', identity: child, seq: 2, turnId: 'turn-1' });
    service.observeReceipt({
      type: 'receipt-settled',
      child,
      turnId: 'turn-1',
      requestId: callRequestId,
      receiptId: 'r1',
      receiptSeq: 1,
      executionState: 'settled',
      receipt: {
        receiptId: 'r1',
        operationId: 'op',
        child,
        turnId: 'turn-1',
        requestId: callRequestId,
        capabilityId: 'appearance.theme',
        risk: 'reversible',
        subject: { kind: 'setting', id: 'theme', label: 'Application theme' },
        outcome: 'succeeded',
        summary: 'theme: system → dark',
        occurredAt: 1,
        sequence: 1,
      },
    });
    const completed = customEntries.filter((entry) => entry.kind === 'agent-completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ receiptSummary: 'theme: system → dark' });
  });

  it('settles receipt + turn exactly once with strictly increasing Main seq', async () => {
    const { service, selectionBindingId, mainEvents, customEntries, bindings } = await setup();
    const result = await service.dispatch(
      {
        requestId: 'turn-1',
        selectionBindingId,
        typeKey: 'agent:enso',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const child = result.child;
    service.observeReceipt({
      type: 'receipt-started',
      child,
      turnId: 'turn-1',
      requestId: 'turn-1',
      receiptId: 'r1',
      receiptSeq: 1,
      executionState: 'executing',
    });
    service.observe({ type: 'turn-completed', identity: child, seq: 2, turnId: 'turn-1' });
    expect(mainEvents.at(-1)?.phase).not.toBe('terminal');
    const receipt: CapabilityReceipt = {
      receiptId: 'r1',
      operationId: 'op',
      child,
      turnId: 'turn-1',
      requestId: 'turn-1',
      capabilityId: 'appearance.status-line-segments',
      risk: 'reversible',
      subject: { kind: 'setting', id: 'statusLineSegments', label: 'Status line segments' },
      outcome: 'succeeded',
      summary: 'saved',
      occurredAt: 1,
      sequence: 1,
    };
    service.observeReceipt({
      type: 'receipt-settled',
      child,
      turnId: 'turn-1',
      requestId: 'turn-1',
      receiptId: 'r1',
      receiptSeq: 1,
      executionState: 'settled',
      receipt,
    });
    service.observeReceipt({
      type: 'receipt-settled',
      child,
      turnId: 'turn-1',
      requestId: 'turn-1',
      receiptId: 'r1',
      receiptSeq: 1,
      executionState: 'settled',
      receipt,
    });
    expect(mainEvents.filter((event) => event.phase === 'terminal')).toHaveLength(1);
    expect(mainEvents.map((event) => event.mainSeq)).toEqual(
      mainEvents.map((_event, index) => index + 1)
    );
    expect(customEntries.filter((entry) => entry.kind === 'agent-completed')).toHaveLength(1);
    const reboundParent = bindings.bindSource(1, { requestId: 'bind-again' });
    expect(reboundParent.accepted).toBe(true);
    if (!reboundParent.accepted) return;
    const reboundSelection = bindings.registerModelSelection(
      1,
      {
        parentBindingId: reboundParent.parentBindingId,
        selection: { providerId: 'provider', modelId: 'model' },
      },
      true
    );
    expect(reboundSelection.accepted).toBe(true);
    if (!reboundSelection.accepted) return;
    await expect(
      service.dispatch(
        {
          requestId: 'turn-2',
          selectionBindingId: reboundSelection.binding.selectionBindingId,
          typeKey: 'agent:enso',
          task: { text: 'again', images: [], fileMentions: [] },
        },
        1
      )
    ).resolves.toMatchObject({ accepted: true });
  });

  it('派发回合结束不撤销能力授权，child 生命周期结束才撤销', async () => {
    const { service, selectionBindingId, capabilityBindings, terminatedGenerations } =
      await setup();
    const result = await service.dispatch(
      {
        requestId: 'turn-1',
        selectionBindingId,
        typeKey: 'agent:enso',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const child = result.child;
    expect(capabilityBindings).toHaveLength(1);
    // 派发轮结束只是本次任务收口；child 会话仍活着，后续轮次的 enso_app 调用必须继续可用
    service.observe({ type: 'turn-completed', identity: child, seq: 2, turnId: 'turn-1' });
    expect(terminatedGenerations).toHaveLength(0);
    // 真正的撤销边界是 child 结束
    service.observe({ type: 'child-ended', identity: child, seq: 3, reason: 'dismissed' });
    expect(terminatedGenerations).toEqual([child]);
  });

  it('rejects ordinary/locked child when exact spawn proof drifts', async () => {
    const { service, selectionBindingId } = await setup(() => ({ systemPromptHash: 'drifted' }));
    const result = await service.dispatch(
      {
        requestId: 'turn-2',
        selectionBindingId,
        typeKey: 'agent:enso',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    expect(result).toMatchObject({ accepted: false, code: 'dispatch-failed' });
  });
});

describe('parent-ready 级联恢复 child（§7.3）', () => {
  const INSTANCE_ID = '99999999-9999-4999-8999-999999999999';
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** 持久化形状：typed child（带 metadata）+ 工具直雇 legacy + 已 ended + 缺 sessionFile */
  function persistedState(conversationId: string): Record<string, unknown> {
    const typedId = `${conversationId}::cw-${INSTANCE_ID}`;
    const legacyId = `${conversationId}::cw-bob`;
    const endedId = `${conversationId}::cw-ended`;
    const noFileId = `${conversationId}::cw-nofile`;
    return {
      conversations: {
        [conversationId]: { coworkerIds: [typedId, legacyId, endedId, noFileId] },
        [typedId]: {
          sessionFile: '/tmp/typed.jsonl',
          child: {
            parentId: conversationId,
            childGeneration: '77777777-7777-4777-8777-777777777777',
            agentTypeKey: 'agent:enso',
            agentInstanceId: INSTANCE_ID,
            agentInstanceName: 'Enso · 9999',
            dispatchOrigin: 'typed-mention',
            lockedProfileId: 'enso-locked-v1',
          },
        },
        [legacyId]: {
          sessionFile: '/tmp/bob.jsonl',
          coworkerName: 'bob',
          agentType: 'scout',
        },
        [endedId]: {
          ended: true,
          sessionFile: '/tmp/ended.jsonl',
          coworkerName: 'gone',
        },
        [noFileId]: { coworkerName: 'nofile' },
      },
    };
  }

  async function ready(fixture: Awaited<ReturnType<typeof setup>>, generation: string) {
    const identity = { sessionId: fixture.conversationId, generation };
    fixture.index.prepareParent(identity);
    fixture.service.observe({
      type: 'parent-ready',
      identity,
      seq: 1,
      sessionFile: path.join(fixture.root, 'parent.jsonl'),
      model: { providerId: 'provider', modelId: 'model' },
    });
    await settle();
    return identity;
  }

  it('typed child 走 resume 预约 + spawnChild(resumeFile)；legacy 走 resumeCoworker；ended/缺文件跳过', async () => {
    const fixture = await setup(undefined, { persistedState });
    const identity = await ready(fixture, '11111111-1111-4111-8111-111111111111');

    expect(fixture.spawnChildCalls).toHaveLength(1);
    const typed = fixture.spawnChildCalls[0];
    expect(typed.identity.instanceId).toBe(INSTANCE_ID);
    expect(typed.identity.instanceName).toBe('Enso · 9999');
    expect(typed.identity.generation).not.toBe('77777777-7777-4777-8777-777777777777');
    expect(typed.identity.parent).toEqual(identity);
    expect(typed.resumeFile).toBe('/tmp/typed.jsonl');

    expect(fixture.resumeCoworkerCalls).toHaveLength(1);
    expect(fixture.resumeCoworkerCalls[0]).toMatchObject({
      parent: identity,
      coworkerId: `${fixture.conversationId}::cw-bob`,
      name: 'bob',
      agentType: 'scout',
      resumeFile: '/tmp/bob.jsonl',
    });
  });

  it('同一 parent generation 只级联一次（派发触发的 parent-ready 重放不重复 spawn）', async () => {
    const fixture = await setup(undefined, { persistedState });
    const identity = await ready(fixture, '11111111-1111-4111-8111-111111111111');
    fixture.service.observe({
      type: 'parent-ready',
      identity,
      seq: 2,
      sessionFile: path.join(fixture.root, 'parent.jsonl'),
      model: { providerId: 'provider', modelId: 'model' },
    });
    await settle();
    expect(fixture.spawnChildCalls).toHaveLength(1);
    expect(fixture.resumeCoworkerCalls).toHaveLength(1);
  });

  it('类型解析失败（已删/禁用）时该 child 跳过，不静默降级、不影响其他 child', async () => {
    const fixture = await setup(undefined, {
      persistedState,
      resolveAgentTypeError: 'Agent type is unavailable.',
    });
    await ready(fixture, '11111111-1111-4111-8111-111111111111');
    expect(fixture.spawnChildCalls).toHaveLength(0);
    expect(fixture.resumeCoworkerCalls).toHaveLength(1);
  });

  it('无持久化 coworkerIds 时零动作', async () => {
    const fixture = await setup();
    await ready(fixture, '11111111-1111-4111-8111-111111111111');
    expect(fixture.spawnChildCalls).toHaveLength(0);
    expect(fixture.resumeCoworkerCalls).toHaveLength(0);
  });
});

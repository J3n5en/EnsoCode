import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type {
  AgentSessionCustomEntry,
  DispatchMainEvent,
  ResolvedAgentTypeSpawnConfig,
} from '@shared/types/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveConversationRegistry } from './activeConversationRegistry';
import { AgentDispatchService, selectHiredAgentType } from './agentDispatchService';
import { AgentSessionIndex } from './agentSessionIndex';
import { SourceAuthorityRegistry } from './sourceAuthorityRegistry';

const worktrees = vi.hoisted(() => new Map<string, { path: string }>());
const busyWorktrees = vi.hoisted(() => new Set<string>());
vi.mock('../ipc/worktree', () => ({
  sessionWorktree: (conversationId: string) => worktrees.get(conversationId),
  sessionWorktreeBusy: (conversationId: string) => busyWorktrees.has(conversationId),
}));

const roots: string[] = [];
afterEach(() => {
  worktrees.clear();
  busyWorktrees.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('selectHiredAgentType', () => {
  const builtinWorker = {
    typeKey: 'builtin:worker' as const,
    displayName: 'worker',
    description: 'builtin',
    source: 'builtin' as const,
    locked: false,
    canDisable: true,
    canEdit: false,
  };
  const customWorker = {
    typeKey: 'custom:14478e0b-5089-4801-967e-0adeadfb4813' as const,
    displayName: 'worker',
    description: 'custom',
    source: 'custom' as const,
    locked: false,
    canDisable: false,
    canEdit: true,
  };

  it('未指定类型时选内置 worker', () => {
    expect(selectHiredAgentType([builtinWorker])?.typeKey).toBe('builtin:worker');
  });

  it('同名自定义类型换掉 builtin:worker 后，未指定类型仍选到 worker', () => {
    expect(selectHiredAgentType([customWorker])?.typeKey).toBe(customWorker.typeKey);
  });

  it('内置仍在时不改用同名自定义类型', () => {
    expect(selectHiredAgentType([customWorker, builtinWorker])?.typeKey).toBe('builtin:worker');
  });

  it('显式未知类型不回退到 worker', () => {
    expect(selectHiredAgentType([customWorker], 'reviewer')).toBeUndefined();
  });
});

interface SetupOptions {
  /** 注入持久化会话状态（settings.json 的 enso-conversations.state） */
  persistedState?: (conversationId: string) => Record<string, unknown>;
  /** 覆盖 resolveAgentType（模拟类型已删） */
  resolveAgentTypeError?: string;
  readCredentials?: () => Promise<ReadonlySet<string>>;
  /** 跳过写入 draft selection，模拟新对话尚未选过模型 */
  persistSelection?: boolean;
  resolveDefaultModel?: () => { providerId: string; modelId: string } | null;
  /** 临时会话项目：会话 cwd = <根>/<会话 id> */
  scratch?: boolean;
  /** worker 拒绝子会话时的原因 */
  rejectChild?: string;
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
  const scratchProject = options.scratch
    ? authority.ensureScratchProject(path.join(root, 'scratch'))
    : undefined;
  const project = scratchProject
    ? { accepted: true as const, value: scratchProject }
    : authority.createProject({ requestId: 'p', path: projectPath });
  if (!project.accepted) throw new Error(project.error);
  const conversation = authority.createConversation({
    requestId: 'c',
    projectId: project.value.projectId,
    projectVersion: project.value.version,
  });
  if (!conversation.accepted) throw new Error(conversation.error);
  const selected =
    options.persistSelection === false
      ? conversation
      : authority.updateSelection({
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
    ...(options.resolveDefaultModel ? { resolveDefaultModel: options.resolveDefaultModel } : {}),
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
    typeKey: 'builtin:scout',
    displayName: 'scout',
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
    tools: 'all',
    skillPaths: [],
    skillBindingIds: [],
    mcpServers: [],
    mcpBindingIds: [],
    systemPromptHash: 'hash',
  };
  const toolIds = ['read', 'grep'];
  const mainEvents: DispatchMainEvent[] = [];
  const customEntries: AgentSessionCustomEntry[] = [];
  const spawnParentCalls: Array<{ sessionId: string; cwd: string }> = [];
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
  const promptedTasks: string[] = [];
  const parentNotices: Array<{
    parent: { sessionId: string; generation: string };
    text: string;
    urgent: boolean;
    ownerWebContentsId: number;
  }> = [];
  let service!: AgentDispatchService;
  service = new AgentDispatchService({
    sourceRegistry: bindings,
    sessionIndex: index,
    readStoredOauthCredentialKeys: options.readCredentials ?? (async () => new Set()),
    emitRendererEvent: () => {},
    emitDispatchEvent: (_owner, event) => mainEvents.push(event),
    host: {
      registrySnapshot: () => ({
        revision: 1,
        candidates: [
          {
            typeKey: 'builtin:scout',
            displayName: 'scout',
            description: 'Built in',
            source: 'builtin',
            locked: false,
            canDisable: true,
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
      // 同生产 host：registry 里没有的类型（含历史 agent:enso）一律 unavailable
      resolveAgentType: (typeKey) =>
        options.resolveAgentTypeError || typeKey !== config.typeKey
          ? { ok: false, error: options.resolveAgentTypeError ?? 'Agent type is unavailable.' }
          : {
              ok: true,
              config,
              expectedModel: { providerId: 'provider', modelId: 'model' },
              expectedToolIds: toolIds,
            },
      spawnParent: (identity, request) => {
        spawnParentCalls.push({ sessionId: identity.sessionId, cwd: request.cwd });
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
        if (options.rejectChild) {
          const reason = options.rejectChild;
          queueMicrotask(() =>
            service.observe({ type: 'child-rejected', identity, seq: 0, reason })
          );
          return { ok: true };
        }
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
              toolIds,
              loadedSkillBindingIds: config.skillBindingIds,
              loadedMcpBindingIds: config.mcpBindingIds,
              systemPromptHash: altered.systemPromptHash ?? config.systemPromptHash,
            },
          })
        );
        return { ok: true };
      },
      promptChild: (_identity, _requestId, task) => {
        promptedTasks.push(task.text);
        return { ok: true };
      },
      appendCustomEntry: (_identity, entry) => {
        customEntries.push(entry);
        return { ok: true };
      },
      notifyParent: (parent, notice) => {
        parentNotices.push({ parent, ...notice });
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
    spawnParentCalls,
    spawnChildCalls,
    resumeCoworkerCalls,
    projectPath: project.value.canonicalPath,
    root,
    promptedTasks,
    parentNotices,
  };
}

describe('AgentDispatchService delta coordination', () => {
  it('rejects a busy workspace before any parent or child spawn', async () => {
    const fixture = await setup();
    busyWorktrees.add(fixture.conversationId);
    const result = await fixture.service.dispatch(
      {
        requestId: 'busy',
        selectionBindingId: fixture.selectionBindingId,
        typeKey: 'builtin:scout',
        task: { text: 'task', images: [], fileMentions: [] },
      },
      1
    );
    expect(result.accepted).toBe(false);
    expect(fixture.spawnParentCalls).toEqual([]);
    expect(fixture.spawnChildCalls).toEqual([]);
  });

  it('uses the binding completed during credential lookup for cwd and file mentions', async () => {
    let finish!: () => void;
    const fixture = await setup(undefined, {
      readCredentials: () =>
        new Promise((resolve) => {
          finish = () => resolve(new Set());
        }),
    });
    const cwd = path.join(fixture.root, 'worktree');
    mkdirSync(cwd);
    writeFileSync(path.join(fixture.projectPath, 'file.txt'), 'wrong main content');
    writeFileSync(path.join(cwd, 'file.txt'), 'correct worktree content');
    const pending = fixture.service.dispatch(
      {
        requestId: 'late-binding',
        selectionBindingId: fixture.selectionBindingId,
        typeKey: 'builtin:scout',
        task: {
          text: 'task',
          images: [],
          fileMentions: [{ id: 'file', relativePath: 'file.txt' }],
        },
      },
      1
    );
    worktrees.set(fixture.conversationId, { path: cwd });
    finish();
    expect((await pending).accepted).toBe(true);
    expect(fixture.spawnParentCalls[0].cwd).toBe(cwd);
    expect(fixture.spawnChildCalls[0].cwd).toBe(cwd);
    expect(fixture.promptedTasks[0]).toContain('correct worktree content');
    expect(fixture.promptedTasks[0]).not.toContain('wrong main content');
  });

  it('skips directory file mentions when snapshotting dispatch task text', async () => {
    const fixture = await setup();
    mkdirSync(path.join(fixture.projectPath, 'src'));
    writeFileSync(path.join(fixture.projectPath, 'note.txt'), 'note body');
    const result = await fixture.service.dispatch(
      {
        requestId: 'dir-mention',
        selectionBindingId: fixture.selectionBindingId,
        typeKey: 'builtin:scout',
        task: {
          text: 'look at @src/ and @note.txt',
          images: [],
          fileMentions: [
            { id: 'src/', relativePath: 'src/' },
            { id: 'note.txt', relativePath: 'note.txt' },
          ],
        },
      },
      1
    );
    expect(result.accepted).toBe(true);
    expect(fixture.promptedTasks[0]).toContain('look at @src/ and @note.txt');
    expect(fixture.promptedTasks[0]).toContain('note body');
    expect(fixture.promptedTasks[0]).not.toContain('path="src/"');
  });

  it.each([true, false])(
    '冷 parent 首次 dispatch 按 root registry 选择 cwd（worktree=%s）',
    async (isolated) => {
      const fixture = await setup();
      const cwd = isolated ? path.join(fixture.root, 'worktree') : fixture.projectPath;
      mkdirSync(cwd, { recursive: true });
      if (isolated) worktrees.set(fixture.conversationId, { path: cwd });

      const result = await fixture.service.dispatch(
        {
          requestId: 'worktree-dispatch',
          selectionBindingId: fixture.selectionBindingId,
          typeKey: 'builtin:scout',
          task: { text: 'do it', images: [], fileMentions: [] },
        },
        1
      );

      expect(result.accepted).toBe(true);
      expect(fixture.spawnParentCalls).toEqual([{ sessionId: fixture.conversationId, cwd }]);
      expect(fixture.spawnChildCalls).toHaveLength(1);
      expect(fixture.spawnChildCalls[0].cwd).toBe(cwd);
      expect(fixture.bindings.resolveParentSource(fixture.conversationId)?.parentProjectPath).toBe(
        fixture.projectPath
      );
    }
  );

  it('新对话未写入 draft selection 时仍能按 binding 解析 spawn cwd', async () => {
    const fixture = await setup(undefined, {
      persistSelection: false,
      resolveDefaultModel: () => ({ providerId: 'provider', modelId: 'model' }),
    });
    const result = await fixture.service.dispatch(
      {
        requestId: 'draft-dispatch',
        selectionBindingId: fixture.selectionBindingId,
        typeKey: 'builtin:scout',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    expect(result).toMatchObject({ accepted: true });
    expect(fixture.spawnParentCalls).toEqual([
      { sessionId: fixture.conversationId, cwd: fixture.projectPath },
    ]);
  });

  it('settles the turn exactly once with strictly increasing Main seq', async () => {
    const { service, selectionBindingId, mainEvents, customEntries, bindings } = await setup();
    const result = await service.dispatch(
      {
        requestId: 'turn-1',
        selectionBindingId,
        typeKey: 'builtin:scout',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const child = result.child;
    service.observe({ type: 'turn-completed', identity: child, seq: 2, turnId: 'turn-1' });
    service.observe({ type: 'turn-completed', identity: child, seq: 3, turnId: 'turn-1' });
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
          typeKey: 'builtin:scout',
          task: { text: 'again', images: [], fileMentions: [] },
        },
        1
      )
    ).resolves.toMatchObject({ accepted: true });
  });

  it('rejects the child when exact spawn proof drifts', async () => {
    const { service, selectionBindingId } = await setup(() => ({ systemPromptHash: 'drifted' }));
    const result = await service.dispatch(
      {
        requestId: 'turn-2',
        selectionBindingId,
        typeKey: 'builtin:scout',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    expect(result).toMatchObject({ accepted: false, code: 'dispatch-failed' });
  });
});

describe('派发收口通知父会话模型', () => {
  async function dispatched(requestId = 'turn-1') {
    const fixture = await setup();
    const result = await fixture.service.dispatch(
      {
        requestId,
        selectionBindingId: fixture.selectionBindingId,
        typeKey: 'builtin:scout',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    if (!result.accepted) throw new Error('dispatch rejected');
    return { ...fixture, child: result.child };
  }

  it('completed 通知一次：带类型、实例名与子会话 id，不加急', async () => {
    const { service, child, parentNotices } = await dispatched();
    service.observe({ type: 'turn-completed', identity: child, seq: 2, turnId: 'turn-1' });
    expect(parentNotices).toHaveLength(1);
    const [notice] = parentNotices;
    expect(notice.parent).toEqual(child.parent);
    expect(notice.ownerWebContentsId).toBe(1);
    expect(notice.urgent).toBe(false);
    expect(notice.text).toContain('已完成');
    expect(notice.text).toContain(child.instanceName);
    expect(notice.text).toContain(child.typeKey);
    expect(notice.text).toContain(child.sessionId);
    expect(notice.text).not.toContain(child.generation);
  });

  it('failed 通知一次并带错误码', async () => {
    const { service, child, parentNotices } = await dispatched();
    service.observe({
      type: 'turn-failed',
      identity: child,
      seq: 2,
      turnId: 'turn-1',
      error: 'boom',
    });
    expect(parentNotices).toHaveLength(1);
    expect(parentNotices[0].urgent).toBe(true);
    expect(parentNotices[0].text).toContain('child-failed');
    expect(parentNotices[0].text).toContain(child.sessionId);
  });

  it('用户中止子代理回合按 cancelled 收口：带错误码', async () => {
    const { service, child, parentNotices, customEntries } = await dispatched();
    service.observe({
      type: 'turn-completed',
      identity: child,
      seq: 2,
      turnId: 'turn-1',
      aborted: true,
    });
    expect(parentNotices).toHaveLength(1);
    expect(parentNotices[0].urgent).toBe(true);
    expect(parentNotices[0].text).toContain('已取消');
    expect(parentNotices[0].text).toContain('child-cancelled');
    expect(customEntries.at(-1)).toMatchObject({
      kind: 'agent-failed',
      errorCode: 'child-cancelled',
    });
  });

  it('同一 dispatch 只通知一次：重复终态与后续 child-ended 不再追发', async () => {
    const { service, child, parentNotices } = await dispatched();
    service.observe({ type: 'turn-completed', identity: child, seq: 2, turnId: 'turn-1' });
    service.observe({ type: 'turn-completed', identity: child, seq: 3, turnId: 'turn-1' });
    service.observe({ type: 'child-ended', identity: child, seq: 4, reason: 'dismissed' });
    service.observe({ type: 'worker-exited' });
    expect(parentNotices).toHaveLength(1);
  });

  it('用户解雇 child 或 worker 退出导致的级联收口不通知', async () => {
    const dismissed = await dispatched();
    dismissed.service.observe({
      type: 'child-ended',
      identity: dismissed.child,
      seq: 2,
      reason: 'dismissed',
    });
    expect(dismissed.customEntries.at(-1)).toMatchObject({ errorCode: 'child-cancelled' });
    expect(dismissed.parentNotices).toHaveLength(0);

    const exited = await dispatched();
    exited.service.observe({ type: 'worker-exited' });
    expect(exited.customEntries.at(-1)).toMatchObject({ kind: 'agent-failed' });
    expect(exited.parentNotices).toHaveLength(0);
  });

  it('父会话已结束（换代）时不投递', async () => {
    const { service, child, parentNotices } = await dispatched();
    service.observe({ type: 'parent-ended', identity: child.parent, seq: 9, reason: 'released' });
    service.observe({ type: 'turn-completed', identity: child, seq: 2, turnId: 'turn-1' });
    expect(parentNotices).toHaveLength(0);
  });

  it('任务未派出就失败的派发不通知（renderer 已直接拿到拒绝）', async () => {
    const fixture = await setup(() => ({ systemPromptHash: 'drifted' }));
    const result = await fixture.service.dispatch(
      {
        requestId: 'turn-1',
        selectionBindingId: fixture.selectionBindingId,
        typeKey: 'builtin:scout',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    expect(result.accepted).toBe(false);
    expect(fixture.parentNotices).toHaveLength(0);
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
            agentTypeKey: 'builtin:scout',
            agentInstanceId: INSTANCE_ID,
            agentInstanceName: 'scout · 9999',
            dispatchOrigin: 'typed-mention',
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

  it.each([true, false])('hire 按 root registry 选择 cwd（worktree=%s）', async (isolated) => {
    const fixture = await setup();
    await ready(fixture, '11111111-1111-4111-8111-111111111111');
    const cwd = isolated ? path.join(fixture.root, 'worktree') : fixture.projectPath;
    mkdirSync(cwd, { recursive: true });
    if (isolated) worktrees.set(fixture.conversationId, { path: cwd });

    const result = await fixture.service.hireCoworker(
      fixture.conversationId,
      'helper',
      'builtin:scout'
    );

    expect(result.ok).toBe(true);
    expect(fixture.spawnParentCalls).toHaveLength(0);
    expect(fixture.spawnChildCalls).toHaveLength(1);
    expect(fixture.spawnChildCalls[0].cwd).toBe(cwd);
  });

  it('临时会话的子会话 cwd 与父会话一致：<根>/<会话 id>（#184）', async () => {
    const fixture = await setup(undefined, { scratch: true });
    await ready(fixture, '11111111-1111-4111-8111-111111111111');
    const result = await fixture.service.hireCoworker(
      fixture.conversationId,
      'helper',
      'builtin:scout'
    );
    expect(result.ok).toBe(true);
    expect(fixture.spawnChildCalls[0]?.cwd).toBe(
      path.join(fixture.projectPath, fixture.conversationId)
    );
  });

  it('worker 拒绝子会话时把原因带给调用方（#184）', async () => {
    const fixture = await setup(undefined, { rejectChild: 'Child source does not match.' });
    await ready(fixture, '11111111-1111-4111-8111-111111111111');
    const result = await fixture.service.hireCoworker(
      fixture.conversationId,
      'helper',
      'builtin:scout'
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('Child source does not match.');
  });

  it.each([true, false])(
    'typed child 恢复按 root 而非 child registry 选择 cwd（worktree=%s）',
    async (isolated) => {
      const fixture = await setup(undefined, { persistedState });
      const cwd = isolated ? path.join(fixture.root, 'worktree') : fixture.projectPath;
      mkdirSync(cwd, { recursive: true });
      if (isolated) worktrees.set(fixture.conversationId, { path: cwd });
      worktrees.set(`${fixture.conversationId}::cw-${INSTANCE_ID}`, {
        path: path.join(fixture.root, 'wrong-child-worktree'),
      });

      await ready(fixture, '11111111-1111-4111-8111-111111111111');

      expect(fixture.spawnChildCalls).toHaveLength(1);
      expect(fixture.spawnChildCalls[0]).toMatchObject({ cwd, resumeFile: '/tmp/typed.jsonl' });
      expect(fixture.resumeCoworkerCalls).toHaveLength(1);
    }
  );

  it('typed child 走 resume 预约 + spawnChild(resumeFile)；legacy 走 resumeCoworker；ended/缺文件跳过', async () => {
    const fixture = await setup(undefined, { persistedState });
    const identity = await ready(fixture, '11111111-1111-4111-8111-111111111111');

    expect(fixture.spawnChildCalls).toHaveLength(1);
    const typed = fixture.spawnChildCalls[0];
    expect(typed.identity.instanceId).toBe(INSTANCE_ID);
    expect(typed.identity.instanceName).toBe('scout · 9999');
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

  it('历史 Enso child（lockedProfileId）恢复时安全跳过，不降级为 legacy resumeCoworker', async () => {
    const ensoId = (conversationId: string) => `${conversationId}::cw-${INSTANCE_ID}`;
    const fixture = await setup(undefined, {
      persistedState: (conversationId) => ({
        conversations: {
          [conversationId]: { coworkerIds: [ensoId(conversationId)] },
          [ensoId(conversationId)]: {
            sessionFile: '/tmp/enso-safe-journal.jsonl',
            coworkerName: 'Enso · 9999',
            agentType: 'agent:enso',
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
        },
      }),
    });
    await ready(fixture, '11111111-1111-4111-8111-111111111111');
    expect(fixture.spawnChildCalls).toHaveLength(0);
    expect(fixture.resumeCoworkerCalls).toHaveLength(0);
  });

  it('无持久化 coworkerIds 时零动作', async () => {
    const fixture = await setup();
    await ready(fixture, '11111111-1111-4111-8111-111111111111');
    expect(fixture.spawnChildCalls).toHaveLength(0);
    expect(fixture.resumeCoworkerCalls).toHaveLength(0);
  });
});

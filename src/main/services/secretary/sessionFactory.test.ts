import { describe, expect, it } from 'vitest';
import {
  defaultApprovalMode,
  type ModelCredentialContext,
  resolveChatModel,
  resolveChatReasoning,
  scopedDefaultModels,
} from '../../../shared/defaultModel';
import type { AgentSpawnRequest, ProjectAuthority } from '../../../shared/types/agent';
import type { ModelProvider } from '../../../shared/types/llm';
import type { SessionWorktree } from '../../../shared/types/worktree';
import {
  createSessionFromMain,
  type MainSessionDefaults,
  mainSessionDefaults,
  type SessionFactoryPorts,
} from './sessionFactory';

const PROJECT: ProjectAuthority = {
  projectId: 'proj-1',
  canonicalPath: '/work/demo',
  kind: 'local',
  state: 'active',
  version: 3,
};

const DEFAULTS: MainSessionDefaults = {
  providerId: 'p',
  modelId: 'm1',
  reasoningEnabled: true,
  thinkingLevel: 'medium',
  approvalMode: 'assistant',
};

const WORKTREE: SessionWorktree = {
  conversationId: 'conv-1',
  projectId: 'proj-1',
  repoPath: '/work/demo',
  path: '/worktrees/proj-1/conv-1',
  branch: 'enso/conv-1',
  baseBranch: 'main',
  baseCommit: 'abc',
  createdAt: 1,
};

interface Harness {
  ports: SessionFactoryPorts;
  log: string[];
  rows: Map<string, Record<string, unknown>>;
  removedRows: string[];
  removedConversations: string[];
  removedWorktrees: SessionWorktree[];
  spawns: AgentSpawnRequest[];
  prompts: { id: string; text: string; deliveryId: string }[];
  spawnResult: { ok: boolean; error?: string };
  promptResult: { ok: boolean; error?: string };
}

function harness(
  options: { project?: ProjectAuthority | null; defaults?: MainSessionDefaults | null } = {}
): Harness {
  const log: string[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const state: Harness = {
    log,
    rows,
    removedRows: [],
    removedConversations: [],
    removedWorktrees: [],
    spawns: [],
    prompts: [],
    spawnResult: { ok: true },
    promptResult: { ok: true },
    ports: {
      project: (id) => {
        const project = options.project === undefined ? PROJECT : options.project;
        return project?.projectId === id ? project : undefined;
      },
      createConversation: (projectId) => {
        log.push('createConversation');
        return {
          conversationId: 'conv-1',
          projectId,
          kind: 'root',
          lifecycle: 'draft',
          version: 1,
        };
      },
      removeConversation: (id) => {
        log.push('removeConversation');
        state.removedConversations.push(id);
      },
      defaults: () => (options.defaults === undefined ? DEFAULTS : options.defaults),
      createWorktree: async (conversationId, projectId) => {
        log.push('createWorktree');
        return { ...WORKTREE, conversationId, projectId };
      },
      removeWorktree: async (record) => {
        log.push('removeWorktree');
        state.removedWorktrees.push(record);
      },
      writeRow: (row) => {
        log.push('writeRow');
        rows.set(String(row.id), row);
      },
      removeRow: (id) => {
        log.push('removeRow');
        state.removedRows.push(id);
      },
      spawn: async (request) => {
        log.push('spawn');
        state.spawns.push(request);
        return state.spawnResult;
      },
      release: async () => {
        log.push('release');
      },
      prompt: (id, text, deliveryId) => {
        log.push('prompt');
        state.prompts.push({ id, text, deliveryId });
        return state.promptResult;
      },
      newId: () => 'delivery-1',
      now: () => 1700000000000,
    },
  };
  return state;
}

const REQUEST = { projectId: 'proj-1', prompt: '看看这个 bug', worktree: false };

describe('createSessionFromMain', () => {
  it('先写行再 spawn，首条 prompt 带 Main 生成的 deliveryId', async () => {
    const h = harness();
    const result = await createSessionFromMain(h.ports, REQUEST);
    expect(result).toEqual({ ok: true, conversationId: 'conv-1' });
    expect(h.log).toEqual(['createConversation', 'writeRow', 'spawn', 'prompt']);
    expect(h.prompts).toEqual([{ id: 'conv-1', text: '看看这个 bug', deliveryId: 'delivery-1' }]);
  });

  it('写出的行是 renderer 能直接水合的投影，标题非空且标为 Main 驱动', async () => {
    const h = harness();
    await createSessionFromMain(h.ports, { ...REQUEST, prompt: '看看这个 bug\n第二行细节' });
    const row = h.rows.get('conv-1') ?? {};
    expect(row).toMatchObject({
      id: 'conv-1',
      projectId: 'proj-1',
      title: '看看这个 bug',
      createdAt: 1700000000000,
      lastActiveAt: 1700000000000,
      messages: [],
      commands: [],
      customEntries: [],
      dispatchMainEvents: {},
      lastSeq: 0,
      spawning: false,
      status: 'idle',
      started: false,
      reasoningEnabled: true,
      thinkingLevel: 'medium',
      lastProviderId: 'p',
      lastModelId: 'm1',
      approvalMode: 'assistant',
      driver: 'main',
    });
    expect(row.worktree).toBeUndefined();
    expect(h.spawns[0]).toMatchObject({
      sessionId: 'conv-1',
      providerId: 'p',
      modelId: 'm1',
      cwd: '/work/demo',
      reasoningEnabled: true,
      thinkingLevel: 'medium',
      approvalMode: 'assistant',
    });
  });

  it('显式模型与推理档覆盖默认值', async () => {
    const h = harness();
    await createSessionFromMain(h.ports, {
      ...REQUEST,
      model: { providerId: 'p2', modelId: 'm9' },
      thinkingLevel: 'high',
    });
    expect(h.spawns[0]).toMatchObject({
      providerId: 'p2',
      modelId: 'm9',
      thinkingLevel: 'high',
    });
    expect(h.rows.get('conv-1')).toMatchObject({ lastProviderId: 'p2', lastModelId: 'm9' });
  });

  it('要 worktree 时行与 spawn cwd 都用隔离目录', async () => {
    const h = harness();
    await createSessionFromMain(h.ports, { ...REQUEST, worktree: true });
    expect(h.rows.get('conv-1')?.worktree).toEqual(WORKTREE);
    expect(h.spawns[0].cwd).toBe(WORKTREE.path);
  });

  it('带目标派出时首条消息追加 kickoff，行里落下可续跑的目标', async () => {
    const h = harness();
    await createSessionFromMain(h.ports, { ...REQUEST, goal: '把登录重定向修好' });
    expect(h.prompts[0].text).toContain('看看这个 bug');
    expect(h.prompts[0].text).toContain('<goal-continuation>');
    expect(h.prompts[0].text).toContain('把登录重定向修好');
    expect(h.rows.get('conv-1')?.goal).toMatchObject({
      text: '把登录重定向修好',
      status: 'active',
      autoTurns: 0,
      noProgressRuns: 0,
    });
  });

  it('spawn 失败时删行、删权威、删 worktree', async () => {
    const h = harness();
    h.spawnResult = { ok: false, error: 'model credentials unavailable' };
    const result = await createSessionFromMain(h.ports, { ...REQUEST, worktree: true });
    expect(result).toEqual({ ok: false, error: 'model credentials unavailable' });
    expect(h.removedWorktrees).toHaveLength(1);
    expect(h.removedRows).toEqual(['conv-1']);
    expect(h.removedConversations).toEqual(['conv-1']);
    expect(h.prompts).toEqual([]);
  });

  it('首条 prompt 被拒时先释放已 spawn 的会话再回滚', async () => {
    const h = harness();
    h.promptResult = { ok: false, error: 'unknown or stale session generation' };
    const result = await createSessionFromMain(h.ports, REQUEST);
    expect(result).toEqual({ ok: false, error: 'unknown or stale session generation' });
    expect(h.log).toEqual([
      'createConversation',
      'writeRow',
      'spawn',
      'prompt',
      'release',
      'removeRow',
      'removeConversation',
    ]);
  });

  it('spawn 失败时不释放', async () => {
    const h = harness();
    h.spawnResult = { ok: false, error: 'x' };
    await createSessionFromMain(h.ports, REQUEST);
    expect(h.log).not.toContain('release');
  });

  it('只接受 active 的本地项目', async () => {
    for (const project of [
      { ...PROJECT, kind: 'ssh' as const },
      { ...PROJECT, kind: 'scratch' as const },
      { ...PROJECT, kind: 'bot-home' as const },
      { ...PROJECT, state: 'removed' as const },
      null,
    ]) {
      const h = harness({ project });
      const result = await createSessionFromMain(h.ports, REQUEST);
      expect(result.ok).toBe(false);
      expect(h.log).toEqual([]);
    }
  });

  it('没有可用模型时不建权威', async () => {
    const h = harness({ defaults: null });
    const result = await createSessionFromMain(h.ports, REQUEST);
    expect(result).toEqual({ ok: false, error: 'no usable model' });
    expect(h.log).toEqual([]);
  });

  it('空 prompt 被拒', async () => {
    const h = harness();
    expect(await createSessionFromMain(h.ports, { ...REQUEST, prompt: '  ' })).toEqual({
      ok: false,
      error: 'empty prompt',
    });
    expect(h.log).toEqual([]);
  });

  it('显式标题优先于首条 prompt 的截断', async () => {
    const h = harness();
    await createSessionFromMain(h.ports, { ...REQUEST, title: '修复登录' });
    expect(h.rows.get('conv-1')?.title).toBe('修复登录');
  });
});

function provider(id: string, modelIds: string[]): ModelProvider {
  return {
    id,
    name: id,
    api: 'openai-completions',
    apiKey: `key-${id}`,
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: modelIds.map((modelId) => ({ id: modelId })),
  };
}

const credentials: ModelCredentialContext = {
  oauthCredentials: { status: 'ready', authenticatedAccountKeys: new Set() },
};

describe('mainSessionDefaults', () => {
  it('与 renderer 新会话取同一组默认值', () => {
    const providers = [provider('p', ['m1', 'm2'])];
    const project = {
      groupId: 'g1',
      defaultModel: { providerId: 'p', modelId: 'm2' },
      defaultReasoningEnabled: false,
      defaultThinkingLevel: 'high' as const,
    };
    const groups = [{ id: 'g1', defaultModel: { providerId: 'p', modelId: 'm1' } }];
    const input = {
      project,
      groups,
      defaultModel: { providerId: 'p', modelId: 'm1' },
      defaultReasoningEnabled: true,
      defaultThinkingLevel: 'medium' as const,
      providers,
      credentials,
      approvalReviewer: { providerId: 'p', modelId: 'm1' },
      lastApprovalMode: 'supervised' as const,
      defaultPresetId: 'preset-a',
      presets: [{ id: 'preset-a' }],
    };
    const scoped = scopedDefaultModels(project, groups);
    const model = resolveChatModel({
      defaultModel: input.defaultModel,
      ...scoped,
      providers,
      credentials,
    });
    const reasoning = resolveChatReasoning({
      ...scoped,
      defaultReasoningEnabled: input.defaultReasoningEnabled,
      defaultThinkingLevel: input.defaultThinkingLevel,
    });
    expect(mainSessionDefaults(input)).toEqual({
      providerId: model.providerId,
      modelId: model.modelId,
      reasoningEnabled: reasoning.reasoningEnabled,
      thinkingLevel: reasoning.thinkingLevel,
      approvalMode: defaultApprovalMode(
        input.approvalReviewer,
        providers,
        credentials,
        input.lastApprovalMode
      ),
      presetId: 'preset-a',
    });
  });

  it('默认预设为 default 或已删除时不写 presetId', () => {
    const providers = [provider('p', ['m1'])];
    const base = {
      project: null,
      groups: [],
      defaultModel: { providerId: 'p', modelId: 'm1' },
      providers,
      credentials,
      approvalReviewer: null,
      presets: [{ id: 'preset-a' }],
    };
    expect(mainSessionDefaults({ ...base, defaultPresetId: 'default' })).not.toHaveProperty(
      'presetId'
    );
    expect(mainSessionDefaults({ ...base, defaultPresetId: 'gone' })).not.toHaveProperty(
      'presetId'
    );
  });

  it('没有可用模型时返回 null', () => {
    expect(
      mainSessionDefaults({
        project: null,
        groups: [],
        defaultModel: { providerId: 'p', modelId: 'm1' },
        providers: [],
        credentials,
        approvalReviewer: null,
        defaultPresetId: 'default',
        presets: [],
      })
    ).toBeNull();
  });
});

describe('派出会话的静音与无人值守', () => {
  it('要求静音和无人值守时，行与 spawn 请求都带上', async () => {
    const h = harness();
    await createSessionFromMain(h.ports, { ...REQUEST, muted: true, unattended: true });
    const row = h.rows.get('conv-1') ?? {};
    expect(row.muted).toBe(true);
    expect(row.autoRejectApprovals).toBe(true);
    expect(h.spawns[0].autoRejectApprovals).toBe(true);
  });

  it('不要求时行与 spawn 请求都不写这两个字段', async () => {
    const h = harness();
    await createSessionFromMain(h.ports, REQUEST);
    const row = h.rows.get('conv-1') ?? {};
    expect(row.muted).toBeUndefined();
    expect(row.autoRejectApprovals).toBeUndefined();
    expect(h.spawns[0].autoRejectApprovals).toBeUndefined();
  });
});

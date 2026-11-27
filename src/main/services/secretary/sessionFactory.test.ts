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
  createSecretaryConversationFromMain,
  createSessionFromMain,
  type MainSessionDefaults,
  type MainSessionDefaultsResult,
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
  prompts: {
    id: string;
    text: string;
    deliveryId: string;
    images?: { data: string; mimeType: string }[];
  }[];
  spawnResult: { ok: boolean; error?: string };
  promptResult: { ok: boolean; error?: string };
}

function harness(
  options: {
    project?: ProjectAuthority | null;
    defaults?: MainSessionDefaultsResult;
    imageInput?: boolean;
  } = {}
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
      defaults: () => options.defaults ?? { ok: true, value: DEFAULTS },
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
      prompt: (id, text, deliveryId, images) => {
        log.push('prompt');
        state.prompts.push({ id, text, deliveryId, ...(images ? { images } : {}) });
        return state.promptResult;
      },
      imageInput: async () => options.imageInput,
      newId: () => 'delivery-1',
      now: () => 1700000000000,
    },
  };
  return state;
}

const REQUEST = { projectId: 'proj-1', prompt: '看看这个 bug', worktree: false };

describe('createSessionFromMain', () => {
  const SHOT = { path: '/tmp/shot.png', size: 3, data: 'AAAA', mimeType: 'image/png' };

  it('带图且模型能看图：图片块跟着首条 prompt，路径行在目标之后的末尾', async () => {
    const h = harness({ imageInput: true });
    await createSessionFromMain(h.ports, {
      ...REQUEST,
      goal: '修好',
      attachments: { images: [SHOT] },
    });
    expect(h.prompts[0]?.images).toEqual([{ data: 'AAAA', mimeType: 'image/png' }]);
    expect(h.prompts[0]?.text.startsWith('看看这个 bug\n\n')).toBe(true);
    expect(h.prompts[0]?.text.endsWith('\n\n[图片 1] /tmp/shot.png')).toBe(true);
    expect(h.prompts[0]?.text).not.toContain('image_view');
  });

  it('带图但模型不能看图：不发图片块，退回路径加 image_view', async () => {
    const h = harness({ imageInput: false });
    await createSessionFromMain(h.ports, { ...REQUEST, attachments: { images: [SHOT] } });
    expect(h.prompts[0]?.images).toBeUndefined();
    expect(h.prompts[0]?.text).toBe(
      '看看这个 bug\n\n[图片 1] /tmp/shot.png\n用 image_view 查看这些图片。'
    );
  });

  it('开始时已不可用的图写进 prompt，其余照常附上', async () => {
    const h = harness({ imageInput: true });
    await createSessionFromMain(h.ports, {
      ...REQUEST,
      attachments: {
        images: [SHOT],
        unavailable: [{ path: '/tmp/gone.png', reason: 'no such file: /tmp/gone.png' }],
      },
    });
    const text = h.prompts[0]?.text ?? '';
    expect(text).toContain('/tmp/gone.png');
    expect(text).toContain('不可用');
    expect(text.endsWith('\n\n[图片 1] /tmp/shot.png')).toBe(true);
    expect(h.prompts[0]?.images).toHaveLength(1);
  });

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

  it('排队：照常建行与 worktree，首条消息与目标存进 queuedStart，不 spawn 不 prompt', async () => {
    const h = harness();
    const result = await createSessionFromMain(h.ports, {
      ...REQUEST,
      worktree: true,
      goal: '修好',
      queued: true,
      attachmentPaths: ['/tmp/shot.png'],
      askRelay: { name: '小秘' },
    });
    expect(result).toEqual({ ok: true, conversationId: 'conv-1' });
    expect(h.spawns).toEqual([]);
    expect(h.prompts).toEqual([]);
    const row = h.rows.get('conv-1');
    expect(row?.worktree).toEqual(WORKTREE);
    expect(row?.goal).toBeUndefined();
    expect(row?.queuedStart).toEqual({
      queuedAt: 1700000000000,
      text: '看看这个 bug',
      goal: '修好',
      attachments: ['/tmp/shot.png'],
      askRelay: { name: '小秘' },
    });
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
    const h = harness({ defaults: { ok: false, error: 'no usable model' } });
    const result = await createSessionFromMain(h.ports, REQUEST);
    expect(result).toEqual({ ok: false, error: 'no usable model' });
    expect(h.log).toEqual([]);
  });

  it('(d) 默认模型不可用：错误点名模型与原因原样交回秘书，不建任何东西', async () => {
    const defaults = mainSessionDefaults({
      project: null,
      groups: [],
      defaultModel: { providerId: 'magpie', modelId: 'devin/swe-2-1' },
      providers: [
        { ...provider('magpie', ['devin/swe-2-1']), name: 'Magpie', apiKey: '' },
        provider('max', ['claude-fable-5']),
      ],
      credentials,
      approvalReviewer: null,
      defaultPresetId: 'default',
      presets: [],
    });
    const h = harness({ defaults });
    const result = await createSessionFromMain(h.ports, REQUEST);
    expect(result).toEqual({
      ok: false,
      error:
        'no usable model: the default model "Magpie / devin/swe-2-1" is unavailable (its provider has no API key). No other model was used. Fix or re-pick it in Settings → Models → Default model.',
    });
    expect(h.log).toEqual([]);
    expect(h.spawns).toEqual([]);
  });

  it('显式指定模型时把它交给 defaults，默认模型不可用也不阻断', async () => {
    const seen: unknown[] = [];
    const h = harness();
    h.ports.defaults = (_projectId, model) => {
      seen.push(model);
      return { ok: true, value: { ...DEFAULTS, providerId: 'x', modelId: 'y' } };
    };
    const result = await createSessionFromMain(h.ports, {
      ...REQUEST,
      model: { providerId: 'explicit', modelId: 'e1' },
    });
    expect(result).toEqual({ ok: true, conversationId: 'conv-1' });
    expect(seen).toEqual([{ providerId: 'explicit', modelId: 'e1' }]);
    expect(h.spawns[0]).toMatchObject({ providerId: 'explicit', modelId: 'e1' });
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
      ok: true,
      value: {
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
      },
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
      'value.presetId'
    );
    expect(mainSessionDefaults({ ...base, defaultPresetId: 'gone' })).not.toHaveProperty(
      'value.presetId'
    );
  });

  const bare = {
    project: null,
    groups: [],
    credentials,
    approvalReviewer: null,
    defaultPresetId: 'default',
    presets: [],
  };

  it('没有设默认模型（首次引导）：no usable model', () => {
    expect(
      mainSessionDefaults({ ...bare, defaultModel: null, providers: [provider('p', ['m1'])] })
    ).toEqual({ ok: false, error: 'no usable model' });
  });

  it('默认模型的服务商被删 / 停用：点名模型与原因，绝不改用另一个可用模型', () => {
    const removed = mainSessionDefaults({
      ...bare,
      defaultModel: { providerId: 'gone', modelId: 'm1' },
      providers: [provider('other', ['o1'])],
    });
    expect(removed).toEqual({
      ok: false,
      error: expect.stringContaining('"gone / m1" is unavailable (its provider no longer exists)'),
    });
    const disabled = mainSessionDefaults({
      ...bare,
      defaultModel: { providerId: 'p', modelId: 'm1' },
      providers: [{ ...provider('p', ['m1']), enabled: false }, provider('other', ['o1'])],
    });
    expect(disabled).toEqual({
      ok: false,
      error: expect.stringContaining('"p / m1" is unavailable (its provider is disabled)'),
    });
  });

  it('虚拟默认模型的主模型不可用：点名虚拟模型，不回退', () => {
    const result = mainSessionDefaults({
      ...bare,
      defaultModel: { providerId: 'enso-virtual', modelId: 'auto' },
      providers: [{ ...provider('p', ['m1']), apiKey: '' }, provider('other', ['o1'])],
      virtualModels: [
        {
          id: 'auto',
          name: 'Auto',
          enabled: true,
          primary: { providerId: 'p', modelId: 'm1' },
          fallbacks: [],
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('"Auto (virtual model)" is unavailable'),
    });
  });

  it('(e) 全局默认不可用但项目默认可用：照用项目默认', () => {
    expect(
      mainSessionDefaults({
        ...bare,
        project: { defaultModel: { providerId: 'proj', modelId: 'pm' } },
        defaultModel: { providerId: 'gone', modelId: 'm1' },
        providers: [provider('other', ['o1']), provider('proj', ['pm'])],
      })
    ).toMatchObject({ ok: true, value: { providerId: 'proj', modelId: 'pm' } });
  });

  it('显式模型：默认不可用也不阻断，直接用显式模型', () => {
    expect(
      mainSessionDefaults({
        ...bare,
        defaultModel: { providerId: 'gone', modelId: 'm1' },
        providers: [provider('other', ['o1'])],
        model: { providerId: 'other', modelId: 'o1' },
      })
    ).toMatchObject({ ok: true, value: { providerId: 'other', modelId: 'o1' } });
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

describe('createSecretaryConversationFromMain', () => {
  const SECRETARY: ProjectAuthority = {
    projectId: 'sec-proj',
    canonicalPath: '/data/secretary/members/s-1/workspace',
    kind: 'secretary',
    state: 'active',
    version: 2,
  };

  it('在秘书的隐藏项目里建会话并拉起，不发消息、不建 worktree', async () => {
    const h = harness({ project: SECRETARY });
    await expect(
      createSecretaryConversationFromMain(h.ports, { projectId: 'sec-proj', title: '小幂' })
    ).resolves.toEqual({ ok: true, conversationId: 'conv-1' });
    expect(h.log).toEqual(['createConversation', 'writeRow', 'spawn']);
    expect(h.rows.get('conv-1')).toMatchObject({
      projectId: 'sec-proj',
      title: '小幂',
      driver: 'main',
      lastProviderId: 'p',
      lastModelId: 'm1',
    });
    expect(h.spawns[0]).toMatchObject({
      sessionId: 'conv-1',
      cwd: '/data/secretary/members/s-1/workspace',
      providerId: 'p',
      modelId: 'm1',
    });
    expect(h.prompts).toEqual([]);
  });

  it('没有可用模型：什么都不建，原因交回去', async () => {
    const h = harness({ project: SECRETARY, defaults: { ok: false, error: 'no usable model' } });
    await expect(
      createSecretaryConversationFromMain(h.ports, { projectId: 'sec-proj', title: '小幂' })
    ).resolves.toEqual({ ok: false, error: 'no usable model' });
    expect(h.log).toEqual([]);
  });

  it('不是秘书项目：拒绝', async () => {
    const h = harness();
    await expect(
      createSecretaryConversationFromMain(h.ports, { projectId: 'proj-1', title: 'x' })
    ).resolves.toEqual({ ok: false, error: 'not an active secretary project' });
    expect(h.log).toEqual([]);
  });

  it('拉起失败：撤掉行和会话，不留半截', async () => {
    const h = harness({ project: SECRETARY });
    h.spawnResult = { ok: false, error: 'boom' };
    await expect(
      createSecretaryConversationFromMain(h.ports, { projectId: 'sec-proj', title: '小幂' })
    ).resolves.toEqual({ ok: false, error: 'boom' });
    expect(h.removedRows).toEqual(['conv-1']);
    expect(h.removedConversations).toEqual(['conv-1']);
  });
});

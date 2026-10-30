import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpServerEntry, ModelProvider } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { botToAgentType } from './bots/botAgentType';
import { createModelProbe } from './bots/modelProbe';
import { McpToolCatalogStore } from './mcpToolCatalog';
import { pickSubagentModelRefs } from './subagentModels';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const settingsMock = vi.hoisted(() => ({
  value: undefined as Record<string, unknown> | undefined,
}));
vi.mock('../ipc/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/settings')>()),
  readSettings: () => settingsMock.value,
}));
const directoryMock = vi.hoisted(() => ({
  snapshot: {
    revision: 0,
    generatedAt: 0,
    providers: [] as Array<{
      key: string;
      kind: 'oauth' | 'custom';
      label: string;
      models: Array<{ id: string; label?: string }>;
    }>,
  },
}));
vi.mock('./modelDirectory', () => ({
  getModelDirectorySnapshot: () => directoryMock.snapshot,
  onModelDirectoryChanged: () => () => {},
}));

import {
  agentTypeRegistrySnapshot,
  configuredAgentTypes,
  expectedAgentTypeToolIds,
  readSettingsState,
  rememberParentToolProfile,
  resolveAgentTypeSpawnConfig,
  resolveApprovalReviewer,
  resolveModelSelection,
  resolvePresetSystemPrompt,
  resolveSubagentModelSelection,
  resolveWebSearchConfig,
  setMemberAgentTypeSource,
  toSessionMcpConfig,
} from './agentHost';

describe('resolveWebSearchConfig', () => {
  const custom: ModelProvider = {
    id: 'p',
    name: 'P',
    api: 'anthropic-messages',
    baseUrl: 'https://gateway.example',
    apiKey: 'secret',
    enabled: true,
    models: [{ id: 'm' }],
  };
  it.each([
    { ...custom, enabled: false },
    { ...custom, models: [] },
    { ...custom, models: [{ id: 'm', enabled: false }] },
    { ...custom, apiKey: undefined },
  ])('does not resolve disabled, removed or malformed providers/models', (provider) => {
    settingsMock.value = {
      'enso-settings': {
        state: {
          providers: [provider],
          webSearchChain: [{ providerId: 'p', modelId: 'm' }],
        },
      },
    };
    expect(resolveWebSearchConfig()).toEqual({ chain: [], configured: true });
  });
  it('distinguishes no configuration from an unavailable configured chain', () => {
    settingsMock.value = {
      'enso-settings': { state: { providers: [custom], webSearchChain: [] } },
    };
    expect(resolveWebSearchConfig()).toEqual({ chain: [], configured: false });
    settingsMock.value = {
      'enso-settings': {
        state: { providers: [], webSearchChain: [{ providerId: 'gone', modelId: 'm' }] },
      },
    };
    expect(resolveWebSearchConfig()).toEqual({ chain: [], configured: true });
  });
  it('自定义 provider 使用 worker 注册指纹，OAuth 保留精确账号身份', () => {
    const provider: ModelProvider = {
      id: 'custom-uuid',
      name: 'Gateway',
      api: 'openai-responses',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'custom-secret',
      enabled: true,
      models: [{ id: 'gpt-shared' }],
    };
    settingsMock.value = {
      'enso-settings': {
        state: {
          providers: [
            provider,
            {
              ...provider,
              id: 'oauth-uuid',
              oauthAccountKey: 'anthropic#2',
              models: [{ id: 'claude-shared' }],
            },
          ],
          webSearchChain: [
            { providerId: provider.id, modelId: 'gpt-shared' },
            { providerId: 'oauth-uuid', modelId: 'claude-shared' },
          ],
        },
      },
    };
    const host = createHash('sha256')
      .update(`${provider.api}\0${provider.baseUrl}`)
      .digest('hex')
      .slice(0, 12);
    const key = createHash('sha256').update(provider.apiKey).digest('hex').slice(0, 8);
    expect(resolveWebSearchConfig().chain).toEqual([
      { providerId: `enso-${host}-${key}`, modelId: 'gpt-shared' },
      { providerId: 'anthropic#2', modelId: 'claude-shared' },
    ]);
  });
});

describe('agentHost session MCP config', () => {
  it('deferred 带 loadMode 与缓存工具名，direct 与缺省保持原样', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-session-mcp-'));
    const catalog = new McpToolCatalogStore(path.join(dir, 'catalog.json'));
    const entry = (loadMode?: McpServerEntry['loadMode']): McpServerEntry => ({
      id: 's1',
      name: 'search',
      transport: 'stdio',
      command: 'search-mcp',
      source: 'manual',
      enabled: true,
      ...(loadMode ? { loadMode } : {}),
    });
    expect(toSessionMcpConfig(entry('deferred'), catalog)).toEqual({
      id: 's1',
      name: 'search',
      transport: 'stdio',
      command: 'search-mcp',
      loadMode: 'deferred',
    });
    catalog.record(entry(), ['find']);
    expect(toSessionMcpConfig(entry('deferred'), catalog)).toMatchObject({ toolNames: ['find'] });
    for (const config of [
      toSessionMcpConfig(entry('direct'), catalog),
      toSessionMcpConfig(entry(), catalog),
    ]) {
      expect(config).not.toHaveProperty('loadMode');
      expect(config).not.toHaveProperty('toolNames');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('description 去空白后下发，空白不下发', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-session-mcp-'));
    const catalog = new McpToolCatalogStore(path.join(dir, 'catalog.json'));
    const entry = (description?: string): McpServerEntry => ({
      id: 's1',
      name: 'search',
      transport: 'stdio',
      command: 'search-mcp',
      source: 'manual',
      enabled: true,
      ...(description !== undefined ? { description } : {}),
    });
    expect(toSessionMcpConfig(entry('  Team wiki  '), catalog)).toMatchObject({
      description: 'Team wiki',
    });
    expect(toSessionMcpConfig(entry('   '), catalog)).not.toHaveProperty('description');
    rmSync(dir, { recursive: true, force: true });
  });

  it('http/sse 下发自定义请求头，丢弃非字符串值；stdio 不下发（#177）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-session-mcp-'));
    const catalog = new McpToolCatalogStore(path.join(dir, 'catalog.json'));
    const remote = {
      id: 'r1',
      name: 'fofa',
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer t', 'X-Bad': 1, '': 'x' },
      source: 'manual',
      enabled: true,
    } as unknown as McpServerEntry;
    expect(toSessionMcpConfig(remote, catalog)).toMatchObject({
      headers: { Authorization: 'Bearer t' },
    });
    expect(toSessionMcpConfig({ ...remote, transport: 'sse' }, catalog)).toMatchObject({
      headers: { Authorization: 'Bearer t' },
    });
    expect(toSessionMcpConfig({ ...remote, headers: {} }, catalog)).not.toHaveProperty('headers');
    expect(
      toSessionMcpConfig({ ...remote, transport: 'stdio', command: 'x', url: undefined }, catalog)
    ).not.toHaveProperty('headers');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('agentHost agent type tool filtering', () => {
  it('all 按编辑模式只期望一套写工具，readonly 不开放写工具', () => {
    expect(
      expectedAgentTypeToolIds('all', { editMode: 'apply_patch', isolatedSandbox: false })
    ).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'bash',
      'apply_patch',
      'message_main_agent',
      'message_coworker',
    ]);
    expect(
      expectedAgentTypeToolIds('all', { editMode: 'replace', isolatedSandbox: false })
    ).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'bash',
      'edit',
      'write',
      'message_main_agent',
      'message_coworker',
    ]);
    expect(expectedAgentTypeToolIds('readonly', { isolatedSandbox: false })).not.toContain(
      'apply_patch'
    );
  });

  it('proof 使用父会话 spawn 时的工具档，而不是后来的全局设置', () => {
    rememberParentToolProfile('parent-snapshot', {
      editMode: 'replace',
      isolatedSandbox: false,
      exploreFold: false,
    });
    expect(expectedAgentTypeToolIds('all', { parentSessionId: 'parent-snapshot' })).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'bash',
      'edit',
      'write',
      'message_main_agent',
      'message_coworker',
    ]);
    expect(
      expectedAgentTypeToolIds('readonly', { parentSessionId: 'parent-snapshot' })
    ).not.toContain('bash');
  });
});

describe('agentHost preset system prompt authority', () => {
  it('无引用沿用默认，引用正文读取失败时明确拒绝 spawn 所需配置', () => {
    expect(resolvePresetSystemPrompt()).toEqual({ ok: true });
    expect(
      resolvePresetSystemPrompt({ systemPromptId: '11111111-1111-4111-8111-111111111111' })
    ).toEqual({ ok: false });
  });
});

describe('readSettingsState', () => {
  it('磁盘仍是迁移前版本时 computer 按默认关闭读出', () => {
    settingsMock.value = {
      'enso-settings': {
        version: 13,
        state: {
          disabledBuiltinTools: ['memory'],
          projects: [{ id: 'p', disabledBuiltinTools: [] }],
        },
      },
    };
    expect(readSettingsState()).toEqual({
      disabledBuiltinTools: ['memory', 'computer'],
      projects: [{ id: 'p', disabledBuiltinTools: ['computer'] }],
    });
    settingsMock.value = { 'enso-settings': { version: 14, state: { disabledBuiltinTools: [] } } };
    expect(readSettingsState()).toEqual({ disabledBuiltinTools: [] });
  });
});

describe('resolveModelSelection 虚拟模型', () => {
  it('TypeSafe cannot be chat, delegated, probed or a virtual fast/fallback member', async () => {
    const ts: ModelProvider = {
      id: 'ts',
      name: 'TypeSafe',
      api: 'openai-completions',
      baseUrl: 'https://api.typesafe.ai/v1/',
      apiKey: 'fixture',
      enabled: true,
      models: [{ id: 'jev-latest' }],
    };
    const chat: ModelProvider = {
      ...ts,
      id: 'chat',
      name: 'Chat',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'chat-model' }],
    };
    const tsRef = { providerId: 'ts', modelId: 'jev-latest' };
    const chatRef = { providerId: 'chat', modelId: 'chat-model' };
    const state = {
      providers: [ts, chat],
      defaultModel: tsRef,
      virtualModels: [
        {
          id: 'auto',
          name: 'Auto',
          enabled: true,
          primary: chatRef,
          fast: tsRef,
          fallbacks: [tsRef],
        },
      ],
    };
    settingsMock.value = { 'enso-settings': { version: 99, state } };
    expect(resolveModelSelection('ts', 'jev-latest', new Set())).toEqual({
      ok: false,
      error: 'Model is unavailable: classifier-only',
    });
    expect(
      pickSubagentModelRefs(
        [
          { ...tsRef, id: 'ts-entry', description: '' },
          { ...chatRef, id: 'chat-entry', description: '' },
        ],
        [ts, chat]
      ).map((entry) => entry.modelId)
    ).toEqual(['chat-model']);
    const resolved = resolveModelSelection('enso-virtual', 'auto', new Set(), {
      allowVirtual: true,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('expected virtual config');
    expect(resolved.selection.config.virtual).toMatchObject({
      primary: { modelId: 'chat-model' },
      fallbacks: [],
    });
    expect(resolved.selection.config.virtual?.fast).toBeUndefined();
    const complete = vi.fn(async () => 'OK');
    const probe = createModelProbe({
      settings: () => state,
      credentials: async () => new Set(),
      isWorkerReady: () => true,
      complete,
      resolve: (ref, keys) => {
        const result = resolveModelSelection(ref.providerId, ref.modelId, keys, {
          allowVirtual: true,
        });
        return result.ok ? { ok: true, config: result.selection.config } : result;
      },
    });
    expect(await probe(tsRef)).toMatchObject({ ok: false });
    expect(complete).not.toHaveBeenCalled();
    state.defaultModel = chatRef;
    expect(await probe(tsRef)).toMatchObject({ ok: true, fallback: { model: chatRef } });
    expect(complete.mock.calls).toHaveLength(1);
  });
  const provider = (id: string, models: string[], extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    api: 'anthropic-messages',
    apiKey: `key-${id}`,
    baseUrl: `https://${id}.test`,
    enabled: true,
    models: models.map((model) => ({ id: model })),
    ...extra,
  });
  const auto = {
    id: 'auto',
    name: 'Auto',
    enabled: true,
    primary: { providerId: 'p1', modelId: 'strong' },
    fast: { providerId: 'p1', modelId: 'weak' },
    fallbacks: [
      { providerId: 'p2', modelId: 'other' },
      { providerId: 'gone', modelId: 'x' },
      { providerId: 'cur', modelId: 'composer' },
    ],
  };
  const setSettings = (virtualModels: unknown[]) => {
    settingsMock.value = {
      'enso-settings': {
        version: 99,
        state: {
          providers: [
            provider('p1', ['strong', 'weak']),
            provider('p2', ['other']),
            provider('cur', ['composer'], { apiKey: '', baseUrl: '', oauthAccountKey: 'cursor' }),
          ],
          virtualModels,
        },
      },
    };
  };
  const keys = new Set(['cursor']);

  it('会话主模型下发虚拟配置：成员带各自凭证，跳过不可用与 Cursor 成员', () => {
    setSettings([auto]);
    const result = resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.ref).toEqual({ providerId: 'enso-virtual', modelId: 'auto' });
    const config = result.selection.config;
    expect(config).toMatchObject({ settingsProviderId: 'enso-virtual', modelId: 'auto' });
    expect(config.virtual?.primary).toMatchObject({ modelId: 'strong', apiKey: 'key-p1' });
    expect(config.virtual?.fast).toMatchObject({ modelId: 'weak' });
    expect(config.virtual?.fallbacks.map((item) => item.modelId)).toEqual(['other']);
  });

  it('不接受虚拟模型的场景落到快模型；快模型失效回落主模型', () => {
    setSettings([auto]);
    const direct = resolveModelSelection('enso-virtual', 'auto', keys);
    expect(direct.ok && direct.selection.ref).toEqual({ providerId: 'p1', modelId: 'weak' });
    setSettings([{ ...auto, fast: { providerId: 'gone', modelId: 'x' } }]);
    const fallback = resolveModelSelection('enso-virtual', 'auto', keys);
    expect(fallback.ok && fallback.selection.ref).toEqual({ providerId: 'p1', modelId: 'strong' });
  });

  it('分类器：有快模型才下发；judge 带裁判配置，pi 分类器只带 provider 与 key', () => {
    setSettings([
      {
        ...auto,
        classifier: {
          source: 'judge',
          model: { providerId: 'p1', modelId: 'weak' },
          timeoutMs: 3000,
        },
      },
    ]);
    const judge = resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true });
    expect(judge.ok && judge.selection.config.virtual?.classifier).toMatchObject({
      source: 'judge',
      timeoutMs: 3000,
      model: { modelId: 'weak', apiKey: 'key-p1' },
    });
    settingsMock.value = {
      'enso-settings': {
        version: 99,
        state: {
          providers: [
            provider('p1', ['strong', 'weak']),
            provider('or', ['x'], { baseUrl: 'https://openrouter.ai/api/v1' }),
          ],
          virtualModels: [
            {
              ...auto,
              fallbacks: [],
              classifier: {
                source: 'pi-classifier',
                model: { providerId: 'or', modelId: 'typesafe/jev-1.13' },
                timeoutMs: 3000,
              },
            },
          ],
        },
      },
    };
    const pi = resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true });
    expect(pi.ok && pi.selection.config.virtual?.classifier).toEqual({
      source: 'pi-classifier',
      timeoutMs: 3000,
      classifier: { provider: 'openrouter', modelId: 'typesafe/jev-1.13', apiKey: 'key-or' },
    });
    setSettings([
      {
        ...auto,
        fast: undefined,
        classifier: {
          source: 'judge',
          model: { providerId: 'p1', modelId: 'weak' },
          timeoutMs: 3000,
        },
      },
    ]);
    const noFast = resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true });
    expect(noFast.ok && noFast.selection.config.virtual?.classifier).toBeUndefined();
  });

  it('主模型配置不可用仍下发完整可用备用链', () => {
    setSettings([{ ...auto, primary: { providerId: 'gone', modelId: 'x' } }]);
    const result = resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selection.config.virtual?.primary.modelId).toBe('other');
  });

  it('条目缺失、停用或整链不可用时拒绝', () => {
    setSettings([]);
    expect(resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true }).ok).toBe(
      false
    );
    setSettings([{ ...auto, enabled: false }]);
    expect(resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true }).ok).toBe(
      false
    );
    setSettings([
      {
        ...auto,
        primary: { providerId: 'cur', modelId: 'composer' },
        fallbacks: [],
        fast: undefined,
      },
    ]);
    expect(resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true })).toEqual({
      ok: false,
      error: '虚拟模型没有可用成员',
    });
  });
});

describe('agentHost 成员 agent type', () => {
  const BOT_ID = '33333333-3333-4333-8333-333333333333';
  const member = (name: string, id = BOT_ID) =>
    botToAgentType(
      {
        id,
        name,
        title: 'Reviewer',
        scope: 'Reviews code',
        avatar: { color: '#888' },
        approvalMode: 'full',
        engine: { providerId: 'p1', modelId: 'strong' },
        tools: 'readonly',
        skillIds: [],
        mcpServerIds: [],
        delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
        memory: { enabled: true },
        createdAt: 1,
        updatedAt: 1,
        version: 1,
      },
      'Be strict.'
    );
  const setSettings = () => {
    settingsMock.value = {
      'enso-settings': {
        version: 99,
        state: {
          providers: [
            {
              id: 'p1',
              name: 'p1',
              api: 'anthropic-messages',
              apiKey: 'key',
              baseUrl: 'https://p1.test',
              enabled: true,
              models: [{ id: 'strong' }, { id: 'weak' }],
            },
          ],
        },
      },
    };
  };

  it('registry、@ 派发与 worker 工具列表都带上成员；与内置同名的成员被跳过', () => {
    setSettings();
    setMemberAgentTypeSource(() => [
      member('Alice'),
      member('scout', '44444444-4444-4444-8444-444444444444'),
    ]);
    try {
      const candidates = agentTypeRegistrySnapshot().candidates;
      expect(candidates.filter((entry) => entry.source === 'bot')).toMatchObject([
        { typeKey: `bot:${BOT_ID}`, displayName: 'Alice', description: 'Reviewer — Reviews code' },
      ]);
      expect(candidates.find((entry) => entry.typeKey === 'builtin:scout')).toBeDefined();

      const parent = resolveModelSelection('p1', 'weak', new Set());
      if (!parent.ok) throw new Error(parent.error);
      const resolved = resolveAgentTypeSpawnConfig(`bot:${BOT_ID}`, parent.selection, new Set());
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.config).toMatchObject({
        typeKey: `bot:${BOT_ID}`,
        displayName: 'Alice',
        tools: 'readonly',
      });
      expect(resolved.config.systemPrompt).toContain('Be strict.');
      expect(resolved.expectedModel).toEqual({ providerId: 'p1', modelId: 'strong' });
      expect(resolved.expectedToolIds).not.toContain('bash');
      expect(
        resolveAgentTypeSpawnConfig(
          'bot:44444444-4444-4444-8444-444444444444',
          parent.selection,
          new Set()
        ).ok
      ).toBe(false);

      const workerTypes = configuredAgentTypes(new Set());
      const bots = workerTypes.filter((entry) => entry.name.startsWith('bot:'));
      expect(bots).toHaveLength(1);
      expect(bots[0]).toMatchObject({
        name: `bot:${BOT_ID}`,
        description: 'Member "Alice" — Reviewer — Reviews code',
        tools: 'readonly',
        allowModelOverride: false,
        model: { modelId: 'strong' },
      });
      expect(bots[0]?.systemPrompt).toContain('Be strict.');
    } finally {
      setMemberAgentTypeSource(() => []);
    }
  });
});

describe('resolveModelSelection OAuth 目录物化', () => {
  const keys = new Set(['google-antigravity']);
  const provider = (models: Array<{ id: string; enabled?: boolean }>) => ({
    id: 'ga',
    name: 'Antigravity',
    api: 'google-generative-ai',
    apiKey: '',
    baseUrl: '',
    enabled: true,
    oauthAccountKey: 'google-antigravity',
    models,
  });
  const entry = {
    id: 'e1',
    providerId: 'ga',
    modelId: 'gemini-3.8-flash',
    description: '新静态模型',
  };

  const useDirectory = (models: Array<{ id: string; enabled?: boolean }>) => {
    directoryMock.snapshot = {
      revision: 1,
      generatedAt: 1,
      providers: [
        {
          key: 'google-antigravity',
          kind: 'oauth',
          label: 'Antigravity',
          models: [{ id: 'gemini-3.8-flash', label: 'Flash' }],
        },
      ],
    };
    settingsMock.value = {
      'enso-settings': {
        version: 99,
        state: {
          subagentModelsEnabled: true,
          subagentModels: [entry],
          providers: [provider(models)],
        },
      },
    };
  };

  it('稀疏覆盖为空时，目录里的新模型仍能通过选型与子代理校验', () => {
    useDirectory([]);
    try {
      const selected = resolveModelSelection('ga', 'gemini-3.8-flash', keys);
      expect(selected.ok).toBe(true);
      if (selected.ok) {
        expect(selected.selection.ref).toEqual({
          providerId: 'ga',
          modelId: 'gemini-3.8-flash',
        });
      }
      const subagent = resolveSubagentModelSelection('Antigravity/gemini-3.8-flash', keys);
      expect(subagent.ok).toBe(true);
      if (subagent.ok) expect(subagent.selection.config.modelId).toBe('gemini-3.8-flash');
    } finally {
      directoryMock.snapshot = { revision: 0, generatedAt: 0, providers: [] };
    }
  });

  it('物化视图保留 enabled:false 覆盖，停用的目录模型不能通过校验', () => {
    useDirectory([{ id: 'gemini-3.8-flash', enabled: false }]);
    try {
      expect(resolveModelSelection('ga', 'gemini-3.8-flash', keys)).toEqual({
        ok: false,
        error: 'Model is unavailable: model-disabled',
      });
      expect(resolveSubagentModelSelection('Antigravity/gemini-3.8-flash', keys).ok).toBe(false);
    } finally {
      directoryMock.snapshot = { revision: 0, generatedAt: 0, providers: [] };
    }
  });

  it('OAuth 稀疏行上的用户覆盖（thinkingLevel）进入 spawn 配置', () => {
    // 统一目录后 OAuth 行只承载用户意图；spawnModelConfig 不能再按 oauthAccountKey 丢弃行覆盖
    directoryMock.snapshot = {
      revision: 1,
      generatedAt: 1,
      providers: [
        {
          key: 'google-antigravity',
          kind: 'oauth',
          label: 'Antigravity',
          models: [{ id: 'gemini-3.8-flash', label: 'Flash' }],
        },
      ],
    };
    settingsMock.value = {
      'enso-settings': {
        version: 99,
        state: {
          providers: [
            {
              id: 'ga',
              name: 'Antigravity',
              api: 'google-generative-ai',
              apiKey: '',
              baseUrl: '',
              enabled: true,
              oauthAccountKey: 'google-antigravity',
              models: [{ id: 'gemini-3.8-flash', thinkingLevel: 'high' }],
            },
          ],
        },
      },
    };
    try {
      const selected = resolveModelSelection('ga', 'gemini-3.8-flash', keys);
      expect(selected.ok).toBe(true);
      if (selected.ok) {
        expect(selected.selection.config).toMatchObject({ thinkingLevel: 'high' });
      }
    } finally {
      directoryMock.snapshot = { revision: 0, generatedAt: 0, providers: [] };
    }
  });
});

describe('resolveAgentTypeSpawnConfig 类型级推理预设', () => {
  const TYPE_ID = '66666666-6666-4666-8666-666666666666';
  const setTypeSettings = (extra: Record<string, unknown>) => {
    settingsMock.value = {
      'enso-settings': {
        version: 99,
        state: {
          providers: [
            {
              id: 'p1',
              name: 'p1',
              api: 'anthropic-messages',
              apiKey: 'key-p1',
              baseUrl: 'https://p1.test',
              enabled: true,
              models: [{ id: 'strong' }],
            },
          ],
          agentTypes: [
            {
              id: TYPE_ID,
              name: 'deep-scout',
              description: 'Deep scout',
              systemPrompt: 'Be thorough.',
              tools: 'readonly',
              providerId: 'p1',
              modelId: 'strong',
              ...extra,
            },
          ],
        },
      },
    };
  };

  it('fixed 模型类型的 reasoning/thinkingLevel 透传进 resolved config', () => {
    setTypeSettings({ reasoning: 'on', thinkingLevel: 'xhigh' });
    const parent = resolveModelSelection('p1', 'strong', new Set());
    if (!parent.ok) throw new Error(parent.error);
    const resolved = resolveAgentTypeSpawnConfig(`custom:${TYPE_ID}`, parent.selection, new Set());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config).toMatchObject({ reasoning: 'on', thinkingLevel: 'xhigh' });
  });

  it('非法取值不透传（与 configuredAgentTypes 同口径）', () => {
    setTypeSettings({ reasoning: 'auto', thinkingLevel: 'extreme' });
    const parent = resolveModelSelection('p1', 'strong', new Set());
    if (!parent.ok) throw new Error(parent.error);
    const resolved = resolveAgentTypeSpawnConfig(`custom:${TYPE_ID}`, parent.selection, new Set());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config).not.toHaveProperty('reasoning');
    expect(resolved.config).not.toHaveProperty('thinkingLevel');
  });
});

describe('resolveApprovalReviewer', () => {
  const jev: ModelProvider = {
    id: 'jev',
    name: 'Jev',
    api: 'typesafe-system-one',
    baseUrl: 'https://api.typesafe.ai/v1/',
    apiKey: 'jev-key',
    enabled: true,
    models: [{ id: 'jev-latest' }],
  };
  const chat: ModelProvider = {
    id: 'chat',
    name: 'Chat',
    api: 'openai-completions',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'chat-key',
    enabled: true,
    models: [{ id: 'chat-model' }],
  };
  const withReviewer = (providers: ModelProvider[], approvalReviewer: unknown) => {
    settingsMock.value = { 'enso-settings': { state: { providers, approvalReviewer } } };
  };

  it('未选为 null；聊天模型走 model 来源', () => {
    withReviewer([chat], null);
    expect(resolveApprovalReviewer(new Set())).toEqual({ ok: true, source: null });
    withReviewer([chat], { providerId: 'chat', modelId: 'chat-model' });
    const resolved = resolveApprovalReviewer(new Set());
    expect(resolved.ok && resolved.source && 'model' in resolved.source).toBe(true);
  });

  it('分类器专用供应商走 classifier 来源，只带 provider、模型与 key', () => {
    withReviewer([jev], { providerId: 'jev', modelId: 'jev-latest' });
    expect(resolveApprovalReviewer(new Set())).toEqual({
      ok: true,
      source: { classifier: { provider: 'typesafe', modelId: 'jev-latest', apiKey: 'jev-key' } },
    });
  });

  it('托管开关只对分类器代审生效', () => {
    settingsMock.value = {
      'enso-settings': {
        state: {
          providers: [jev, chat],
          approvalReviewer: { providerId: 'jev', modelId: 'jev-latest' },
          approvalAutoManage: true,
        },
      },
    };
    expect(resolveApprovalReviewer(new Set())).toMatchObject({
      ok: true,
      source: { classifier: { modelId: 'jev-latest' }, managed: true },
    });
    settingsMock.value = {
      'enso-settings': {
        state: {
          providers: [jev, chat],
          approvalReviewer: { providerId: 'chat', modelId: 'chat-model' },
          approvalAutoManage: true,
        },
      },
    };
    const chatSource = resolveApprovalReviewer(new Set());
    expect(chatSource.ok && chatSource.source).not.toHaveProperty('managed');
    withReviewer([jev], { providerId: 'jev', modelId: 'jev-latest' });
    const off = resolveApprovalReviewer(new Set());
    expect(off.ok && off.source).not.toHaveProperty('managed');
  });

  it('放行阈值只对分类器代审下发，非 0.9 档才带；非法值按 0.9', () => {
    const withThreshold = (reviewer: { providerId: string; modelId: string }, value: unknown) => {
      settingsMock.value = {
        'enso-settings': {
          state: {
            providers: [jev, chat],
            approvalReviewer: reviewer,
            approvalAllowThreshold: value,
          },
        },
      };
      return resolveApprovalReviewer(new Set());
    };
    const jevRef = { providerId: 'jev', modelId: 'jev-latest' };
    expect(withThreshold(jevRef, 0.85)).toMatchObject({
      ok: true,
      source: { allowThreshold: 0.85 },
    });
    for (const value of [0.9, 0.5, '0.85', undefined]) {
      const result = withThreshold(jevRef, value);
      expect(result.ok && result.source).not.toHaveProperty('allowThreshold');
    }
    const chatSource = withThreshold({ providerId: 'chat', modelId: 'chat-model' }, 0.95);
    expect(chatSource.ok && chatSource.source).not.toHaveProperty('allowThreshold');
  });

  it('分类器缺 key 或停用时明确失败，不回退聊天模型', () => {
    for (const provider of [
      { ...jev, apiKey: '' },
      { ...jev, enabled: false },
    ]) {
      withReviewer([provider, chat], { providerId: 'jev', modelId: 'jev-latest' });
      expect(resolveApprovalReviewer(new Set()).ok).toBe(false);
    }
  });
});

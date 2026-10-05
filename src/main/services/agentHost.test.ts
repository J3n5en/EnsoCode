import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpServerEntry } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { botToAgentType } from './bots/botAgentType';
import { McpToolCatalogStore } from './mcpToolCatalog';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const settingsMock = vi.hoisted(() => ({
  value: undefined as Record<string, unknown> | undefined,
}));
vi.mock('../ipc/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/settings')>()),
  readSettings: () => settingsMock.value,
}));

import {
  agentTypeRegistrySnapshot,
  configuredAgentTypes,
  expectedAgentTypeToolIds,
  readSettingsState,
  rememberParentToolProfile,
  resolveAgentTypeSpawnConfig,
  resolveModelSelection,
  resolvePresetSystemPrompt,
  setMemberAgentTypeSource,
  toSessionMcpConfig,
} from './agentHost';

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

  it('条目缺失、停用或主模型不可用时拒绝', () => {
    setSettings([]);
    expect(resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true }).ok).toBe(
      false
    );
    setSettings([{ ...auto, enabled: false }]);
    expect(resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true }).ok).toBe(
      false
    );
    setSettings([{ ...auto, primary: { providerId: 'cur', modelId: 'composer' } }]);
    expect(resolveModelSelection('enso-virtual', 'auto', keys, { allowVirtual: true }).ok).toBe(
      false
    );
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

import { describe, expect, it } from 'vitest';
import { planImport } from './merge';
import type { ConfigSyncBundle, ConfigSyncMcpServer, ConfigSyncProvider } from './types';

const provider = (id: string, name: string, apiKey?: string): ConfigSyncProvider => ({
  id,
  name,
  api: 'openai-completions',
  ...(apiKey === undefined ? {} : { apiKey }),
  baseUrl: 'https://example.test',
  enabled: true,
  models: [{ id: 'model-1' }],
});

const bundle = (state: Partial<ConfigSyncBundle['state']> = {}): ConfigSyncBundle => ({
  format: 'enso-config',
  version: 1,
  createdAt: '2025-09-05T00:00:00.000Z',
  state: {
    providers: [],
    skills: [],
    mcpServers: [],
    instructions: [],
    presets: [],
    agentTypes: [],
    subagentModels: [],
    ...state,
  },
  resources: { skills: [], instructions: [] },
  secretsIncluded: false,
});

const current = (state: Record<string, unknown> = {}): Record<string, unknown> => ({
  providers: [],
  skills: [],
  mcpServers: [],
  instructions: [],
  presets: [],
  agentTypes: [],
  subagentModels: [],
  ...state,
});

describe('config sync merge identity and reference mapping', () => {
  it.each(['merge', 'replace'] as const)(
    '%s 导入未带 systemPromptId 的匹配预设时显式恢复默认提示词',
    (mode) => {
      const result = planImport(
        current({
          presets: [
            {
              id: 'same-preset',
              name: 'Preset',
              skillIds: [],
              mcpServerIds: [],
              systemPromptId: '11111111-1111-4111-8111-111111111111',
            },
          ],
        }),
        bundle({
          presets: [{ id: 'same-preset', name: 'Preset', skillIds: [], mcpServerIds: [] }],
        }),
        mode
      );
      expect(result.state.presets).toEqual([
        { id: 'same-preset', name: 'Preset', skillIds: [], mcpServerIds: [] },
      ]);
    }
  );

  it('按唯一规范化名称匹配并保留本机 ID，同时重映射预设引用', () => {
    const result = planImport(
      current({
        skills: [
          {
            id: 'local-skill',
            name: ' My Skill ',
            description: 'old',
            path: '/old',
            enabled: true,
          },
        ],
      }),
      bundle({
        skills: [
          {
            id: 'remote-skill',
            name: 'ｍｙ   skill',
            description: 'new',
            path: '',
            source: 'import',
            enabled: true,
          },
        ],
        presets: [
          {
            id: 'preset-1',
            name: 'Preset',
            skillIds: ['remote-skill'],
            mcpServerIds: [],
          },
        ],
      }),
      'merge'
    );
    expect(result.skillIdMap).toEqual({ 'remote-skill': 'local-skill' });
    expect(result.state.presets).toContainEqual(
      expect.objectContaining({ skillIds: ['local-skill'] })
    );
  });

  it('OAuth 账号省略标记会在导入预览中给出重新登录警告', () => {
    const result = planImport(
      current(),
      bundle({
        providers: [{ ...provider('remote', 'OAuth'), omittedFields: ['oauthAccountKey'] }],
      }),
      'merge'
    );
    expect(result.warnings).toContain(
      'OAuth login state is not included; sign in again after import.'
    );
  });

  it('名称匹配存在多个本机候选时不猜测覆盖，作为新增条目导入', () => {
    const result = planImport(
      current({
        skills: [
          { id: 'one', name: 'same' },
          { id: 'two', name: ' SAME ' },
        ],
      }),
      bundle({
        skills: [
          {
            id: 'remote',
            name: 'same',
            description: '',
            path: '',
            source: 'import',
            enabled: true,
          },
        ],
      }),
      'merge'
    );
    expect((result.state.skills as { id: string }[]).map((skill) => skill.id)).toEqual([
      'one',
      'two',
      'remote',
    ]);
    expect(result.summary).toContainEqual(
      expect.objectContaining({ category: 'skills', added: 1, updated: 0 })
    );
  });

  it('replace 仅替换同步白名单并保留其它设置字段', () => {
    const result = planImport(
      current({
        providers: [provider('local', 'Local', 'key')],
        theme: 'dark',
        projects: ['keep'],
      }),
      bundle({ providers: [provider('remote', 'Remote')] }),
      'replace'
    );
    expect(result.state.providers).toEqual([expect.objectContaining({ id: 'remote' })]);
    expect(result.state).toMatchObject({ theme: 'dark', projects: ['keep'] });
  });

  it('合并 provider 时保留本机独有模型，避免本机 agent 引用失效；替换时删除', () => {
    const localProvider = {
      ...provider('same-provider', 'Provider'),
      models: [
        { id: 'remote-model', label: 'Local copy' },
        { id: 'local-model', label: 'Local' },
      ],
    };
    const result = planImport(
      current({
        providers: [localProvider],
        agentTypes: [
          {
            id: 'local-agent',
            name: 'local-agent',
            description: '',
            systemPrompt: '',
            tools: 'readonly',
            modelMode: 'fixed',
            providerId: 'same-provider',
            modelId: 'local-model',
          },
        ],
        subagentModels: [
          {
            id: 'local-subagent',
            providerId: 'same-provider',
            modelId: 'local-model',
            description: 'local',
          },
        ],
      }),
      bundle({
        providers: [
          {
            ...provider('same-provider', 'Provider'),
            models: [{ id: 'remote-model', label: 'Imported update' }],
          },
        ],
      }),
      'merge'
    );

    const mergedProvider = (result.state.providers as Array<Record<string, unknown>>)[0];
    expect(mergedProvider).toMatchObject({
      models: [
        { id: 'remote-model', label: 'Imported update' },
        { id: 'local-model', label: 'Local' },
      ],
    });
    expect(result.state.agentTypes).toContainEqual(
      expect.objectContaining({ modelId: 'local-model' })
    );
    expect(result.state.subagentModels).toContainEqual(
      expect.objectContaining({ modelId: 'local-model' })
    );

    const replaced = planImport(
      current({ providers: [localProvider] }),
      bundle({
        providers: [{ ...provider('same-provider', 'Provider'), models: [{ id: 'remote-model' }] }],
      }),
      'replace'
    );
    const replacedProvider = (replaced.state.providers as Array<Record<string, unknown>>)[0];
    expect(replacedProvider?.models).toEqual([{ id: 'remote-model' }]);
  });

  it('重映射全局模型、子代理模型和自定义代理模型引用', () => {
    const result = planImport(
      current({ providers: [provider('local-provider', 'Provider', 'key')] }),
      bundle({
        providers: [provider('remote-provider', 'provider')],
        defaultModel: { providerId: 'remote-provider', modelId: 'model-1' },
        subagentModels: [
          {
            id: 'sub-model',
            providerId: 'remote-provider',
            modelId: 'model-1',
            description: '',
          },
        ],
        agentTypes: [
          {
            id: 'agent-1',
            name: 'custom-worker',
            description: '',
            systemPrompt: '',
            tools: 'readonly',
            modelMode: 'fixed',
            providerId: 'remote-provider',
            modelId: 'model-1',
          },
        ],
      }),
      'merge'
    );
    expect(result.state.defaultModel).toEqual({ providerId: 'local-provider', modelId: 'model-1' });
    expect(result.state.subagentModels).toContainEqual(
      expect.objectContaining({ providerId: 'local-provider' })
    );
    expect(result.state.agentTypes).toContainEqual(
      expect.objectContaining({ providerId: 'local-provider' })
    );
  });

  it('重映射智能压缩模型并在摘要中统计标量与子代理模型变化', () => {
    const result = planImport(
      current({
        providers: [provider('local-provider', 'Provider', 'key')],
        smartCompactEnabled: false,
        smartCompactModel: null,
      }),
      bundle({
        providers: [provider('remote-provider', 'Provider')],
        smartCompactEnabled: true,
        smartCompactModel: { providerId: 'remote-provider', modelId: 'model-1' },
        subagentModels: [
          {
            id: 'sub-model',
            providerId: 'remote-provider',
            modelId: 'model-1',
            description: 'delegate',
          },
        ],
      }),
      'merge'
    );
    expect(result.state.smartCompactEnabled).toBe(true);
    expect(result.state.smartCompactModel).toEqual({
      providerId: 'local-provider',
      modelId: 'model-1',
    });
    expect(result.summary).toContainEqual({
      category: 'subagentModels',
      added: 1,
      updated: 0,
      skipped: 0,
    });
    expect(result.summary).toContainEqual(
      expect.objectContaining({ category: 'settings', updated: expect.any(Number) })
    );
  });

  it('重复导入保持 ID 和数组稳定', () => {
    const imported = bundle({ providers: [provider('remote', 'Remote')] });
    const first = planImport(current(), imported, 'merge');
    const second = planImport(first.state, imported, 'merge');
    expect(second.state).toEqual(first.state);
    expect(second.summary).toContainEqual({
      category: 'providers',
      added: 0,
      updated: 0,
      skipped: 1,
    });
  });

  it('保留被省略的 MCP 本机值，并禁用缺少敏感值的新条目', () => {
    const imported: ConfigSyncMcpServer = {
      id: 'same',
      name: 'MCP',
      transport: 'stdio',
      command: 'node',
      source: 'import',
      enabled: true,
      omittedFields: ['args', 'env'],
    };
    const existing = {
      ...imported,
      args: ['local'],
      env: { TOKEN: 'keep' },
      omittedFields: undefined,
    };
    const remote: ConfigSyncMcpServer = {
      id: 'remote',
      name: 'Remote',
      transport: 'http',
      url: 'https://example.test/mcp',
      source: 'import',
      enabled: true,
      omittedFields: ['headers'],
    };
    const keptHeaders = planImport(
      current({
        mcpServers: [
          { ...remote, headers: { Authorization: 'Bearer keep' }, omittedFields: undefined },
        ],
      }),
      bundle({ mcpServers: [remote] }),
      'merge'
    );
    expect(keptHeaders.state.mcpServers).toContainEqual(
      expect.objectContaining({ id: 'remote', headers: { Authorization: 'Bearer keep' } })
    );
    const updated = planImport(
      current({ mcpServers: [existing] }),
      bundle({ mcpServers: [imported] }),
      'merge'
    );
    expect(updated.state.mcpServers).toContainEqual(
      expect.objectContaining({ args: ['local'], env: { TOKEN: 'keep' }, enabled: true })
    );

    const added = planImport(
      current(),
      bundle({ mcpServers: [{ ...imported, id: 'new' }] }),
      'merge'
    );
    expect(added.state.mcpServers).toContainEqual(
      expect.objectContaining({ id: 'new', enabled: false })
    );
  });

  it('包内 env 与已启用本机 MCP 不一致时保留本机 env、禁用并告警', () => {
    const imported: ConfigSyncMcpServer = {
      id: 'same',
      name: 'MCP',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'from-package' },
      source: 'import',
      enabled: true,
    };
    const result = planImport(
      current({
        mcpServers: [{ ...imported, env: { TOKEN: 'local-secret' }, source: undefined }],
      }),
      bundle({ mcpServers: [imported] }),
      'merge'
    );

    expect(result.state.mcpServers).toContainEqual(
      expect.objectContaining({ id: 'same', env: { TOKEN: 'local-secret' }, enabled: false })
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/MCP[\s\S]*env|env[\s\S]*MCP/i)])
    );
  });

  it('包内 env 与本机一致时不禁用也不告警', () => {
    const imported: ConfigSyncMcpServer = {
      id: 'same',
      name: 'MCP',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'shared' },
      source: 'import',
      enabled: true,
    };
    const result = planImport(
      current({ mcpServers: [{ ...imported, source: undefined }] }),
      bundle({ mcpServers: [imported] }),
      'merge'
    );

    expect(result.state.mcpServers).toContainEqual(
      expect.objectContaining({ id: 'same', env: { TOKEN: 'shared' }, enabled: true })
    );
    expect(result.warnings).not.toEqual(expect.arrayContaining([expect.stringMatching(/env/i)]));
  });

  it('导入启用的全局指令时关闭本机原选择', () => {
    const result = planImport(
      current({ instructions: [{ id: 'local', name: 'Local', enabled: true }] }),
      bundle({
        instructions: [
          {
            id: 'remote',
            name: 'Remote',
            source: 'import',
            sourcePath: '',
            local: false,
            bytes: 1,
            enabled: true,
          },
        ],
      }),
      'merge'
    );
    expect(result.state.instructions).toEqual([
      expect.objectContaining({ id: 'local', enabled: false }),
      expect.objectContaining({ id: 'remote', enabled: true }),
    ]);
  });

  it('关掉未匹配的本机指令时在摘要或警告中可见', () => {
    const result = planImport(
      current({ instructions: [{ id: 'local', name: 'Local', enabled: true }] }),
      bundle({
        instructions: [
          {
            id: 'remote',
            name: 'Remote',
            source: 'import',
            sourcePath: '',
            local: false,
            bytes: 1,
            enabled: true,
          },
        ],
      }),
      'merge'
    );

    const instructions = result.summary.find((entry) => entry.category === 'instructions');
    const disclosed =
      (instructions?.updated ?? 0) > 0 ||
      result.warnings.some((warning) => /instruction/i.test(warning));
    expect(disclosed).toBe(true);
  });

  it('匹配且已启用的本机指令不因互斥计数而增加 updated', () => {
    const instruction = {
      id: 'same',
      name: 'Same',
      source: 'import',
      sourcePath: '' as const,
      local: false,
      bytes: 1,
      enabled: true,
    };
    const result = planImport(
      current({ instructions: [instruction] }),
      bundle({ instructions: [instruction] }),
      'merge'
    );
    const instructions = result.summary.find((entry) => entry.category === 'instructions');
    expect(instructions?.updated ?? 0).toBe(0);
    expect(instructions?.skipped ?? 0).toBe(1);
  });

  it('同名但不同 endpoint 的 provider 不会静默覆盖本机配置', () => {
    expect(() =>
      planImport(
        current({
          providers: [{ ...provider('local', 'Shared'), baseUrl: 'https://local.example.test' }],
        }),
        bundle({
          providers: [{ ...provider('remote', 'Shared'), baseUrl: 'https://remote.example.test' }],
        }),
        'merge'
      )
    ).toThrow(/endpoint|ambiguous|conflict/i);
  });

  it('省略 provider 凭证时保留本机值，新增不完整 provider 自动禁用', () => {
    const omitted: ConfigSyncProvider = {
      ...provider('same', 'Updated'),
      omittedFields: ['apiKey'],
    };
    const updated = planImport(
      current({ providers: [provider('same', 'Old', 'keep')] }),
      bundle({ providers: [omitted] }),
      'merge'
    );
    expect(updated.state.providers).toContainEqual(
      expect.objectContaining({ id: 'same', apiKey: 'keep', enabled: true })
    );

    const added = planImport(
      current(),
      bundle({ providers: [{ ...omitted, id: 'new' }] }),
      'merge'
    );
    expect(added.state.providers).toContainEqual(
      expect.objectContaining({ id: 'new', enabled: false })
    );
  });
});

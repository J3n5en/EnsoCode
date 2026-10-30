import { describe, expect, it } from 'vitest';
import {
  decodeBundle,
  encodeBundle,
  isEncryptedBundle,
  redactBundle,
  validateBundle,
} from './codec';
import type { ConfigSyncBundle } from './types';

const bundle = () => ({
  format: 'enso-config' as const,
  version: 1 as const,
  createdAt: '2025-09-05T00:00:00.000Z',
  state: {
    providers: [],
    skills: [],
    mcpServers: [],
    instructions: [],
    presets: [],
    agentTypes: [],
    subagentModels: [],
  },
  resources: { skills: [], instructions: [] },
  secretsIncluded: false,
});
const skill = {
  id: 'skill-1',
  name: 'Test',
  description: '',
  path: '',
  source: 'import',
  enabled: true,
};

describe('config sync codec', () => {
  const subagentBundle = (): ConfigSyncBundle => ({
    ...bundle(),
    state: {
      ...bundle().state,
      providers: [
        {
          id: 'p1',
          name: 'P',
          api: 'openai-completions',
          baseUrl: 'https://example.test',
          enabled: true,
          models: [{ id: 'model' }],
        },
      ],
      subagentModels: [
        {
          id: 'sub1',
          providerId: 'p1',
          modelId: 'model',
          description: '保留选型说明',
          reasoning: 'off',
          thinkingLevel: 'high',
        },
      ],
    },
  });

  it.each([false, true])('子模型可用性在敏感配置=%s 的导出导入中无损保留', async (encrypted) => {
    const source = subagentBundle();
    source.secretsIncluded = encrypted;
    const entry = source.state.subagentModels[0];
    source.state.subagentModels = [
      { ...entry, enabled: false },
      { ...entry, id: 'sub2', enabled: true },
      { ...entry, id: 'legacy' },
    ];
    const original = structuredClone(source);
    const password = encrypted ? 'correct horse' : undefined;
    const decoded = await decodeBundle(await encodeBundle(source, password), password);
    expect(decoded.state.subagentModels).toEqual(original.state.subagentModels);
    expect(source).toEqual(original);
  });

  it.each(['false', 0, null])('拒绝非布尔子模型可用性 %s，而不是误当默认启用', (enabled) => {
    const source = subagentBundle();
    const state = source.state;
    expect(() =>
      validateBundle({
        ...source,
        state: { ...state, subagentModels: [{ ...state.subagentModels[0], enabled }] },
      })
    ).toThrow('Invalid subagent model.enabled');
  });

  it('旧配置包缺少子模型可用性时仍接受且不补写字段', () => {
    const source = subagentBundle();
    expect(validateBundle(source).state.subagentModels).toEqual(source.state.subagentModels);
    expect(validateBundle(source).state.subagentModels[0]).not.toHaveProperty('enabled');
  });

  it('拒绝技能资源中的路径穿越', () => {
    expect(() =>
      validateBundle({
        ...bundle(),
        state: { ...bundle().state, skills: [skill] },
        resources: {
          skills: [
            {
              id: skill.id,
              files: [
                { path: 'SKILL.md', content: '' },
                { path: '../escape', content: '' },
              ],
            },
          ],
          instructions: [],
        },
      })
    ).toThrow();
  });

  it('拒绝大小写不敏感的重复资源路径', () => {
    expect(() =>
      validateBundle({
        ...bundle(),
        state: { ...bundle().state, skills: [skill] },
        resources: {
          skills: [
            {
              id: skill.id,
              files: [
                { path: 'SKILL.md', content: '' },
                { path: 'skill.md', content: '' },
              ],
            },
          ],
          instructions: [],
        },
      })
    ).toThrow();
  });

  it('脱敏导出移除凭证且不修改输入 bundle', () => {
    const source = {
      ...bundle(),
      state: {
        ...bundle().state,
        providers: [
          {
            id: 'p1',
            name: 'P',
            api: 'openai-completions' as const,
            apiKey: 'secret',
            baseUrl: 'https://example.test',
            enabled: true,
            models: [],
          },
        ],
        mcpServers: [
          {
            id: 'm1',
            name: 'M',
            transport: 'http' as const,
            env: { TOKEN: 'secret' },
            headers: { Authorization: 'Bearer secret' },
            args: ['--token=secret'],
            url: 'https://user:pass@example.test/a?token=secret#frag',
            source: 'local',
            enabled: true,
          },
        ],
      },
    };
    const redacted = redactBundle(source);
    expect(JSON.stringify(redacted)).not.toContain('secret');
    expect(source.state.providers[0]).toHaveProperty('apiKey', 'secret');
    expect(source.state.mcpServers[0]).toHaveProperty('env.TOKEN', 'secret');
    expect(redacted.state.mcpServers[0]?.omittedFields).toContain('headers');
  });

  it('包含敏感信息时加密整个包并支持正确密码解密', async () => {
    const encrypted = await encodeBundle({ ...bundle(), secretsIncluded: true }, 'correct horse');
    expect(isEncryptedBundle(encrypted)).toBe(true);
    expect(encrypted.toString('utf8')).not.toContain(bundle().createdAt);
    await expect(decodeBundle(encrypted, 'correct horse')).resolves.toMatchObject({
      secretsIncluded: true,
    });
  });

  it('错误密码不能解密敏感配置包', async () => {
    const encrypted = await encodeBundle({ ...bundle(), secretsIncluded: true }, 'correct horse');
    await expect(decodeBundle(encrypted, 'wrong password')).rejects.toThrow();
  });

  it('允许与内置同名的自定义 Agent type（覆盖语义），仍拒绝保留名', () => {
    const agentType = (name: string) => ({
      id: '14478e0b-5089-4801-967e-0adeadfb4813',
      name,
      description: '',
      systemPrompt: 'x',
      tools: 'all',
    });
    const withAgent = (name: string) => ({
      ...bundle(),
      state: { ...bundle().state, agentTypes: [agentType(name)] },
    });
    expect(() => validateBundle(withAgent('worker'))).not.toThrow();
    expect(() => validateBundle(withAgent('enso'))).toThrow(/reserved/i);
    expect(() => validateBundle(withAgent('builtin:worker'))).toThrow(/reserved/i);
  });
});

import { describe, expect, it } from 'vitest';
import { decodeBundle, encodeBundle, redactBundle, validateBundle } from './codec';
import type { ConfigSyncBundle } from './types';

const minimalBundle = (): ConfigSyncBundle => ({
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
  },
  resources: { skills: [], instructions: [] },
  secretsIncluded: false,
});

const provider = () => ({
  id: 'provider-1',
  name: 'Provider',
  api: 'openai-completions' as const,
  apiKey: 'top-secret',
  baseUrl: 'https://example.test',
  enabled: true,
  models: [{ id: 'model-1' }],
});

const skill = () => ({
  id: 'skill-1',
  name: 'Skill',
  description: '',
  path: '' as const,
  source: 'import',
  enabled: true,
});

describe('config sync codec schema and crypto boundaries', () => {
  it('接受严格且引用完整的最小配置包', () => {
    const input = minimalBundle();
    expect(validateBundle(input)).toEqual(input);
  });

  it('拒绝缺少任何必需的状态数组', () => {
    const requiredStateArrays = [
      'providers',
      'skills',
      'mcpServers',
      'instructions',
      'presets',
      'agentTypes',
      'subagentModels',
    ] as const;

    for (const key of requiredStateArrays) {
      const input = minimalBundle();
      delete (input.state as unknown as Record<string, unknown>)[key];
      expect(() => validateBundle(input), `missing state.${key}`).toThrow();
    }
  });

  it('接受智能压缩设置并校验模型引用', () => {
    const input = minimalBundle();
    input.state.providers = [provider()];
    input.state.smartCompactEnabled = true;
    input.state.smartCompactModel = { providerId: 'provider-1', modelId: 'model-1' };
    expect(validateBundle(input).state).toMatchObject({
      smartCompactEnabled: true,
      smartCompactModel: { providerId: 'provider-1', modelId: 'model-1' },
    });

    input.state.smartCompactModel = { providerId: 'missing', modelId: 'model-1' };
    expect(() => validateBundle(input)).toThrow(/smartCompactModel|reference/i);
  });

  it('压缩策略与旧 smartCompactEnabled 一起往返，非法策略拒绝', () => {
    const input = minimalBundle();
    input.state.compactStrategy = 'continuous-memory';
    input.state.smartCompactEnabled = false;
    expect(validateBundle(input).state).toMatchObject({
      compactStrategy: 'continuous-memory',
      smartCompactEnabled: false,
    });
    delete input.state.compactStrategy;
    expect(validateBundle(input).state).not.toHaveProperty('compactStrategy');
    (input.state as unknown as Record<string, unknown>).compactStrategy = 'bogus';
    expect(() => validateBundle(input)).toThrow(/compactStrategy/);
  });

  it('拒绝缺少任何必需的资源数组', () => {
    for (const key of ['skills', 'instructions'] as const) {
      const input = minimalBundle();
      delete (input.resources as unknown as Record<string, unknown>)[key];
      expect(() => validateBundle(input), `missing resources.${key}`).toThrow();
    }
  });

  it('拒绝未知版本和额外顶层字段', () => {
    expect(() => validateBundle({ ...minimalBundle(), version: 2 })).toThrow();
    expect(() => validateBundle({ ...minimalBundle(), extra: true })).toThrow();
  });

  it('拒绝缺少 SKILL.md 或非规范 base64 的技能资源', () => {
    const base = minimalBundle();
    base.state.skills = [skill()];
    base.resources.skills = [{ id: 'skill-1', files: [{ path: 'readme.md', content: '' }] }];
    expect(() => validateBundle(base)).toThrow();

    base.resources.skills = [{ id: 'skill-1', files: [{ path: 'SKILL.md', content: '***' }] }];
    expect(() => validateBundle(base)).toThrow();
  });

  it('拒绝指向包内不存在实体的预设与模型引用', () => {
    const input = minimalBundle();
    input.state.presets = [
      { id: 'preset-1', name: 'Broken', skillIds: ['missing'], mcpServerIds: [] },
    ];
    expect(() => validateBundle(input)).toThrow();

    input.state.presets = [];
    input.state.defaultModel = { providerId: 'missing', modelId: 'missing' };
    expect(() => validateBundle(input)).toThrow();
  });

  it('明文编码拒绝携带技能正文，避免未加密资源泄露', async () => {
    const input = minimalBundle();
    input.state.skills = [skill()];
    input.resources.skills = [
      {
        id: 'skill-1',
        files: [{ path: 'SKILL.md', content: Buffer.from('private').toString('base64') }],
      },
    ];
    await expect(encodeBundle(input)).rejects.toThrow(/plaintext|resource|encrypt/i);
  });

  it('脱敏只移除结构化凭证，不改写技能和指令正文', () => {
    const input = minimalBundle();
    input.state.providers = [provider()];
    input.state.skills = [skill()];
    input.resources.skills = [
      {
        id: 'skill-1',
        files: [
          { path: 'SKILL.md', content: Buffer.from('literal top-secret').toString('base64') },
        ],
      },
    ];
    const redacted = redactBundle(input);
    expect(JSON.stringify(redacted)).not.toContain('"apiKey":"top-secret"');
    expect(JSON.stringify(redacted)).toContain(
      Buffer.from('literal top-secret').toString('base64')
    );
  });

  it('敏感包拒绝过短、缺失和超长密码', async () => {
    const input = { ...minimalBundle(), secretsIncluded: true };
    await expect(encodeBundle(input, 'short')).rejects.toThrow();
    await expect(encodeBundle(input)).rejects.toThrow();
    await expect(encodeBundle(input, 'x'.repeat(1025))).rejects.toThrow();
  });

  it('加密包缺少密码或密文被篡改时拒绝', async () => {
    const encrypted = await encodeBundle(
      { ...minimalBundle(), secretsIncluded: true },
      'correct horse'
    );
    await expect(decodeBundle(encrypted)).rejects.toThrow();
    const outer = JSON.parse(encrypted.toString('utf8')) as { ciphertext: string };
    outer.ciphertext = `${outer.ciphertext.slice(0, -4)}AAAA`;
    await expect(
      decodeBundle(Buffer.from(JSON.stringify(outer)), 'correct horse')
    ).rejects.toThrow();
  });

  it('拒绝伪装内置子代理和保留默认预设', () => {
    const input = minimalBundle();
    input.state.agentTypes = [
      {
        id: 'custom-enso',
        name: 'Enso',
        description: '',
        systemPrompt: '',
        tools: 'readonly',
      },
    ];
    expect(() => validateBundle(input)).toThrow();
    input.state.agentTypes[0] = { ...input.state.agentTypes[0], id: 'builtin:scout', name: 'x' };
    expect(() => validateBundle(input)).toThrow();

    input.state.agentTypes = [];
    input.state.presets = [{ id: 'default', name: 'Fake', skillIds: [], mcpServerIds: [] }];
    expect(() => validateBundle(input)).toThrow();
  });
});

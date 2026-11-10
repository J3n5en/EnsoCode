import { describe, expect, it } from 'vitest';
import { planImport } from './merge';
import type { ConfigSyncBundle } from './types';

const provider = (id: string, name: string, apiKey?: string) => ({
  id,
  name,
  api: 'openai-completions' as const,
  ...(apiKey === undefined ? {} : { apiKey }),
  baseUrl: 'https://example.test',
  enabled: true,
  models: [],
});
const bundle = (providers: ReturnType<typeof provider>[]) => ({
  format: 'enso-config' as const,
  version: 1 as const,
  createdAt: '2025-09-05T00:00:00.000Z',
  state: {
    providers,
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
const current = (providers: ReturnType<typeof provider>[]) => ({
  providers,
  skills: [],
  mcpServers: [],
  instructions: [],
  presets: [],
  agentTypes: [],
  subagentModels: [],
});

describe('config sync merge planning', () => {
  it('合并时保留本机独有条目并为导入条目生成新增摘要', () => {
    const result = planImport(
      current([provider('local', 'Local', 'keep')]),
      bundle([provider('imported', 'Imported')]),
      'merge'
    );
    expect(result.state.providers).toEqual([
      expect.objectContaining({ id: 'local', apiKey: 'keep' }),
      expect.objectContaining({ id: 'imported' }),
    ]);
    expect(result.summary).toContainEqual({
      category: 'providers',
      added: 1,
      updated: 0,
      skipped: 0,
    });
  });

  it('导入更新省略凭证时保留本机凭证', () => {
    const result = planImport(
      current([provider('same', 'Old', 'keep-secret')]),
      bundle([provider('same', 'New')]),
      'merge'
    );
    expect(result.state.providers).toContainEqual(
      expect.objectContaining({ id: 'same', name: 'New', apiKey: 'keep-secret' })
    );
    expect(result.summary).toContainEqual({
      category: 'providers',
      added: 0,
      updated: 1,
      skipped: 0,
    });
  });

  it('导入省略请求头时保留本机请求头', () => {
    const local = { ...provider('same', 'Old', 'keep-secret'), headers: { 'X-Local': 'keep' } };
    const imported = {
      ...provider('same', 'New', 'incoming'),
      omittedFields: ['headers' as const],
    };
    const result = planImport(current([local]), bundle([imported]), 'merge');
    expect(result.state.providers).toContainEqual(
      expect.objectContaining({
        id: 'same',
        name: 'New',
        apiKey: 'incoming',
        headers: { 'X-Local': 'keep' },
      })
    );
  });

  it('允许导入与内置同名的自定义 Agent type，仍拒绝保留名', () => {
    const agentType = (name: string) => ({
      id: '14478e0b-5089-4801-967e-0adeadfb4813',
      name,
      description: '',
      systemPrompt: 'x',
      tools: 'all',
    });
    const withAgent = (name: string) =>
      ({
        ...bundle([]),
        state: { ...bundle([]).state, agentTypes: [agentType(name)] },
      }) as unknown as ConfigSyncBundle;
    const result = planImport(current([]), withAgent('worker'), 'merge');
    expect(result.state.agentTypes).toContainEqual(expect.objectContaining({ name: 'worker' }));
    expect(() => planImport(current([]), withAgent('enso'), 'merge')).toThrow(/reserved/i);
  });
});

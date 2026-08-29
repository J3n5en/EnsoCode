import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { SpawnModelConfig } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { createSubagentTool, type SubagentDeps } from './subagent';

const cheapConfig: SpawnModelConfig = {
  api: 'openai-completions',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  modelId: 'gpt-cheap',
  settingsProviderId: 'p1',
};

function fakeSession(reply: string): AgentSession {
  return {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: reply }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession;
}

function makeDeps(overrides: Partial<SubagentDeps> = {}): SubagentDeps {
  return {
    createSubSession: vi.fn(async () => fakeSession('done')),
    modelId: 'parent-model',
    agentTypes: [],
    models: [{ name: 'OpenAI/gpt-cheap', config: cheapConfig, description: '便宜快' }],
    emitUpdate: vi.fn(),
    runGate: vi.fn(async () => 'PASSED'),
    notify: vi.fn(),
    ...overrides,
  };
}

describe('subagent tool model 参数', () => {
  it('未知 model 报错并列出可用项', async () => {
    const tool = createSubagentTool(makeDeps());
    await expect(
      tool.execute(
        't1',
        { description: 'x', prompt: 'do', model: 'nope' },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/OpenAI\/gpt-cheap/);
  });

  it('指定 model 时以该配置创建子会话并如实上报 modelId', async () => {
    const deps = makeDeps();
    const tool = createSubagentTool(deps);
    const result = await tool.execute(
      't1',
      { description: 'x', prompt: 'do', model: 'OpenAI/gpt-cheap' },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.createSubSession).toHaveBeenCalledWith(undefined, cheapConfig);
    expect((result.details as { modelId?: string }).modelId).toBe('gpt-cheap');
    const emitted = (deps.emitUpdate as ReturnType<typeof vi.fn>).mock.calls.map(
      ([info]) => info.modelId
    );
    expect(emitted).toContain('gpt-cheap');
  });

  it('未指定 model 时沿用现状(agent_type/父模型),不传 override', async () => {
    const deps = makeDeps();
    const tool = createSubagentTool(deps);
    await tool.execute('t1', { description: 'x', prompt: 'do' }, undefined, undefined, {} as never);
    expect(deps.createSubSession).toHaveBeenCalledWith(undefined, undefined);
  });

  it('model 参数说明携带用户写的选型描述', () => {
    const tool = createSubagentTool(makeDeps());
    const properties = (tool.parameters as { properties: Record<string, { description?: string }> })
      .properties;
    expect(properties.model?.description).toContain('OpenAI/gpt-cheap');
    expect(properties.model?.description).toContain('便宜快');
  });

  it('models 为空时 schema 不含 model 参数', () => {
    const tool = createSubagentTool(makeDeps({ models: [] }));
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect('model' in properties).toBe(false);
  });
});

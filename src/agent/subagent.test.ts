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

  it('promptSnippet 仅在有可选模型时提及 model 参数(开关关闭不泄露)', () => {
    expect(createSubagentTool(makeDeps()).promptSnippet).toMatch(/model parameter/);
    expect(createSubagentTool(makeDeps({ models: [] })).promptSnippet).not.toMatch(
      /model parameter/
    );
  });

  it('promptGuidelines 写入主动委派规则，含内置类型选型；无类型时不提类型', () => {
    const guidelines = createSubagentTool(
      makeDeps({
        agentTypes: [
          { name: 'scout', description: 'recon', systemPrompt: '', tools: 'readonly' },
          { name: 'worker', description: 'impl', systemPrompt: '', tools: 'all' },
          { name: 'reviewer', description: 'review', systemPrompt: '', tools: 'readonly' },
        ],
      })
    ).promptGuidelines;
    expect(guidelines?.join('\n')).toMatch(/independent.*same message/i);
    expect(guidelines?.join('\n')).toMatch(/scout.*worker.*reviewer/s);
    expect(createSubagentTool(makeDeps()).promptGuidelines?.join('\n')).not.toMatch(/scout/);
  });

  it('类型选型按类型逐个拼接，关掉一个不影响其余', () => {
    const text = createSubagentTool(
      makeDeps({
        agentTypes: [
          { name: 'scout', description: 'recon', systemPrompt: '', tools: 'readonly' },
          { name: 'worker', description: 'impl', systemPrompt: '', tools: 'all' },
        ],
      })
    ).promptGuidelines?.join('\n');
    expect(text).toMatch(/scout/);
    expect(text).toMatch(/worker/);
    expect(text).not.toMatch(/reviewer/);
  });

  it('description/promptSnippet 不再用保守措辞抢话', () => {
    const tool = createSubagentTool(makeDeps());
    expect(tool.description).not.toMatch(/parallelizable or context-heavy/);
    expect(tool.promptSnippet).toMatch(/default/i);
  });

  it('当 agent_type 锁定模型（allowModelOverride === false）时，主 agent 传 model 报错拒绝', async () => {
    const deps = makeDeps({
      agentTypes: [
        {
          name: 'fixed-worker',
          description: 'fixed',
          systemPrompt: '',
          tools: 'all',
          allowModelOverride: false,
        },
      ],
    });
    const tool = createSubagentTool(deps);
    await expect(
      tool.execute(
        't1',
        {
          description: 'x',
          prompt: 'do',
          agent_type: 'fixed-worker',
          model: 'OpenAI/gpt-cheap',
        },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/does not allow custom model selection/i);
  });

  it('当 agent_type 设为必须自选（allowModelOverride === true）时，允许指定 model', async () => {
    const deps = makeDeps({
      agentTypes: [
        {
          name: 'scout',
          description: 'scout',
          systemPrompt: '',
          tools: 'readonly',
          allowModelOverride: true,
        },
      ],
    });
    const tool = createSubagentTool(deps);
    const result = await tool.execute(
      't1',
      {
        description: 'x',
        prompt: 'do',
        agent_type: 'scout',
        model: 'OpenAI/gpt-cheap',
      },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.createSubSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scout' }),
      cheapConfig
    );
    expect((result.details as { modelId?: string }).modelId).toBe('gpt-cheap');
  });
});

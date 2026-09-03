import type { CoworkerInfo, SpawnModelConfig } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { type CoworkerToolDeps, createCoworkerTool } from './coworker';

const cheapConfig: SpawnModelConfig = {
  api: 'openai-completions',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  modelId: 'gpt-cheap',
  settingsProviderId: 'p1',
};

function makeDeps(overrides: Partial<CoworkerToolDeps> = {}): CoworkerToolDeps {
  return {
    agentTypes: [],
    models: [{ name: 'OpenAI/gpt-cheap', config: cheapConfig }],
    spawn: vi.fn(
      async (name: string): Promise<CoworkerInfo> => ({
        id: `s::cw-${name}`,
        name,
        status: 'idle',
        createdAt: 0,
      })
    ),
    send: vi.fn(async () => 'ok'),
    list: vi.fn(() => []),
    dismiss: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('coworker tool model 参数', () => {
  it('spawn 携未知 model 报错并列出可用项', async () => {
    const tool = createCoworkerTool(makeDeps());
    await expect(
      tool.execute(
        't1',
        { operation: 'spawn', name: 'bob', task: 'do', model: 'nope' },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/OpenAI\/gpt-cheap/);
  });

  it('spawn 携合法 model 透传给 deps.spawn', async () => {
    const deps = makeDeps();
    const tool = createCoworkerTool(deps);
    await tool.execute(
      't1',
      { operation: 'spawn', name: 'bob', task: 'do', model: 'OpenAI/gpt-cheap' },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.spawn).toHaveBeenCalledWith('bob', undefined, 'OpenAI/gpt-cheap');
  });

  it('models 为空时 schema 不含 model 参数', () => {
    const tool = createCoworkerTool(makeDeps({ models: [] }));
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect('model' in properties).toBe(false);
  });

  it('promptSnippet 仅在有可选模型时提及 model 参数(开关关闭不泄露)', () => {
    expect(createCoworkerTool(makeDeps()).promptSnippet).toMatch(/model parameter/);
    expect(createCoworkerTool(makeDeps({ models: [] })).promptSnippet).not.toMatch(
      /model parameter/
    );
  });

  it('当 agent_type 锁定模型（allowModelOverride === false）时，spawn 传 model 报错拒绝', async () => {
    const deps = makeDeps({
      agentTypes: [
        {
          name: 'reviewer',
          description: 'reviewer',
          systemPrompt: '',
          tools: 'readonly',
          allowModelOverride: false,
        },
      ],
    });
    const tool = createCoworkerTool(deps);
    await expect(
      tool.execute(
        't1',
        {
          operation: 'spawn',
          name: 'bob',
          task: 'do',
          agent_type: 'reviewer',
          model: 'OpenAI/gpt-cheap',
        },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/does not allow custom model selection/i);
  });
});

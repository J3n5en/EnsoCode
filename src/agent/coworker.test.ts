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
    wait: vi.fn(async () => 'waited'),
    report: vi.fn(() => 'full'),
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
    expect(deps.spawn).toHaveBeenCalledWith('bob', undefined, 'OpenAI/gpt-cheap', undefined);
  });

  it('spawn 解析 model:high 后缀，显式 thinking 优先', async () => {
    const deps = makeDeps();
    const tool = createCoworkerTool(deps);
    await tool.execute(
      't1',
      { operation: 'spawn', name: 'bob', task: 'do', model: 'OpenAI/gpt-cheap:high' },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.spawn).toHaveBeenCalledWith('bob', undefined, 'OpenAI/gpt-cheap', 'high');

    await tool.execute(
      't2',
      {
        operation: 'spawn',
        name: 'alice',
        task: 'do',
        model: 'OpenAI/gpt-cheap:high',
        thinking: 'off',
      },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.spawn).toHaveBeenLastCalledWith('alice', undefined, 'OpenAI/gpt-cheap', 'off');
  });

  it('spawn 的非法显式 thinking 在创建 coworker 前报错', async () => {
    const deps = makeDeps();
    const tool = createCoworkerTool(deps);
    await expect(
      tool.execute(
        't1',
        { operation: 'spawn', name: 'bob', task: 'do', thinking: 'ultra' },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(
      'unknown thinking "ultra". Available: [off, minimal, low, medium, high, xhigh, max] or omit to inherit.'
    );
    expect(deps.spawn).not.toHaveBeenCalled();
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

  it('promptGuidelines 把多轮闭环写成默认动作，task 不再自称 self-contained', () => {
    const tool = createCoworkerTool(makeDeps());
    const text = tool.promptGuidelines?.join('\n') ?? '';
    expect(text).toMatch(/finished a round.*send/is);
    expect(text).toMatch(/message_main_agent.*send/is);
    expect(text).toMatch(/dismiss/);
    const properties = (tool.parameters as { properties: Record<string, { description: string }> })
      .properties;
    expect(properties.task.description).not.toMatch(/self-contained/);
    expect(properties.task.description).toMatch(/send/);
  });

  it('何时雇 coworker 写在 coworker 自己的 guideline 首句，不依赖 agentTypes', () => {
    const first = createCoworkerTool(makeDeps({ agentTypes: [] })).promptGuidelines?.[0] ?? '';
    expect(first).toMatch(/^Hire a coworker when/);
    expect(first).toMatch(/multi-round|follow-up/i);
  });

  it('description/promptSnippet 与 guidelines 同向：不再劝省着用、不再劝先交差', () => {
    const tool = createCoworkerTool(makeDeps());
    expect(tool.description).not.toMatch(/return to the user/);
    expect(tool.promptSnippet).not.toMatch(/prefer few/);
    expect(tool.promptSnippet).toMatch(/multi-round/);
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

describe('coworker tool wait/report 操作', () => {
  it('wait 操作路由到 deps.wait,透传 name 与 gate', async () => {
    const deps = makeDeps();
    const tool = createCoworkerTool(deps);
    const result = await tool.execute(
      't1',
      { operation: 'wait', name: 'bob', gate: 'pnpm test' },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.wait).toHaveBeenCalledWith('bob', expect.objectContaining({ gate: 'pnpm test' }));
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/waited/);
  });

  it('report 操作路由到 deps.report,只传 name', async () => {
    const deps = makeDeps();
    const tool = createCoworkerTool(deps);
    const result = await tool.execute(
      't1',
      { operation: 'report', name: 'bob' },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.report).toHaveBeenCalledWith('bob');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/full/);
  });

  it('wait 缺 name 报错', async () => {
    const tool = createCoworkerTool(makeDeps());
    await expect(
      tool.execute('t1', { operation: 'wait' }, undefined, undefined, {} as never)
    ).rejects.toThrow(/name/i);
  });

  it('report 缺 name 报错', async () => {
    const tool = createCoworkerTool(makeDeps());
    await expect(
      tool.execute('t1', { operation: 'report' }, undefined, undefined, {} as never)
    ).rejects.toThrow(/name/i);
  });

  it('report 结果超 20000 字截断,尾注为 …(truncated at 20000 chars)', async () => {
    const longText = 'a'.repeat(20050);
    const deps = makeDeps({ report: vi.fn(() => longText) });
    const tool = createCoworkerTool(deps);
    const result = await tool.execute(
      't1',
      { operation: 'report', name: 'bob' },
      undefined,
      undefined,
      {} as never
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(longText.length);
    expect(text).toMatch(/…\(truncated at 20000 chars\)/);
  });

  it('send 结果超上限截断时,尾注提示用 coworker report 取全文', async () => {
    const longText = 'b'.repeat(5000);
    const deps = makeDeps({ send: vi.fn(async () => longText) });
    const tool = createCoworkerTool(deps);
    const result = await tool.execute(
      't1',
      { operation: 'send', name: 'bob', message: 'hi', wait: true },
      undefined,
      undefined,
      {} as never
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/coworker report/);
  });

  it('schema 的 operation enum 含 wait 与 report', () => {
    const tool = createCoworkerTool(makeDeps());
    const properties = (tool.parameters as { properties: { operation: { enum: string[] } } })
      .properties;
    expect(properties.operation.enum).toEqual(expect.arrayContaining(['wait', 'report']));
  });

  it('promptSnippet 提到 wait,并劝阻 sleep/poll', () => {
    const snippet = createCoworkerTool(makeDeps()).promptSnippet ?? '';
    expect(snippet).toMatch(/\bwait\b/);
    expect(snippet).toMatch(/sleep|poll/i);
  });
});

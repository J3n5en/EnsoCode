import { type ToolCall, validateToolArguments } from '@earendil-works/pi-ai';
import type { SpawnModelConfig } from '@shared/types';
import type { AgentControlToolResponse, AgentWorkerEvent } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import { AgentControlInvoker } from './agentControl';
import { createUnifiedSubagentTool, type UnifiedSubagentDeps } from './subagent';

const cheapConfig: SpawnModelConfig = {
  api: 'openai-completions',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  modelId: 'gpt-cheap',
  settingsProviderId: 'p1',
};

function setup(overrides: Partial<UnifiedSubagentDeps> = {}) {
  const deps: UnifiedSubagentDeps = {
    agentTypes: [],
    models: [{ name: 'OpenAI/gpt-cheap', config: cheapConfig }],
    invoke: vi.fn(async (request) => ({ ok: true as const, value: { request } })),
    ...overrides,
  };
  return { deps, tool: createUnifiedSubagentTool(deps) };
}

describe('unified subagent tool', () => {
  it('模型只看到 subagent，一个 schema 覆盖全部生命周期操作', () => {
    const { tool } = setup();
    expect(tool.name).toBe('subagent');
    const operation = (tool.parameters as { properties: { operation: { enum: string[] } } })
      .properties.operation;
    expect(operation.enum).toEqual([
      'spawn',
      'send',
      'wait',
      'report',
      'list',
      'message',
      'stop',
      'dismiss',
    ]);
    expect(`${tool.description}\n${tool.promptSnippet}`).not.toMatch(/coworker tool/i);
    expect(`${tool.description}\n${tool.promptSnippet}`).toMatch(
      /spawn requires non-empty description and prompt/i
    );
    const parameters = tool.parameters as {
      oneOf?: unknown;
      anyOf?: unknown;
      allOf?: unknown;
      properties: {
        description: { description?: string };
        prompt: { description?: string };
        runIds: { description?: string; uniqueItems?: boolean };
      };
    };
    const fields = parameters.properties;
    expect(parameters.oneOf).toBeUndefined();
    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.allOf).toBeUndefined();
    expect(JSON.stringify(parameters)).not.toMatch(/"uniqueItems"/);
    expect(fields.runIds.description).toMatch(/duplicate/i);
    expect(`${fields.description.description}\n${fields.prompt.description}`).toMatch(/spawn/i);
    expect(fields.description.description).toMatch(/required/i);
    expect(fields.prompt.description).toMatch(/required/i);
    expect(tool.promptGuidelines?.join('\n')).toMatch(
      /spawn requires non-empty description and prompt/i
    );
    const model = (
      tool.parameters as { properties: { model?: { enum?: string[]; description?: string } } }
    ).properties.model;
    expect(model?.enum).toEqual(['OpenAI/gpt-cheap']);
    expect(model?.description).toMatch(/exact/i);
    expect(tool.promptGuidelines?.join('\n')).toMatch(/model enum/i);
  });

  it('spawn 漏掉 description 时用 name 或 prompt 补标签，斜杠模型名仍然合法', async () => {
    const { deps, tool } = setup({
      agentTypes: [
        {
          name: 'reviewer',
          description: 'reviewer',
          systemPrompt: '',
          tools: 'readonly',
          allowModelOverride: true,
        },
      ],
    });
    await tool.execute(
      'call-missing-description',
      {
        operation: 'spawn',
        agent_type: 'reviewer',
        mode: 'task',
        model: 'OpenAI/gpt-cheap',
        name: 'issue98review',
        prompt: 'review this',
      },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'issue98review',
        prompt: 'review this',
        model: 'OpenAI/gpt-cheap',
      }),
      undefined
    );
    await tool.execute(
      'call-label-from-prompt',
      { operation: 'spawn', model: 'OpenAI/gpt-cheap', prompt: 'review the diff\nthen stop' },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description: 'review the diff',
        prompt: 'review the diff\nthen stop',
      }),
      undefined
    );
    await expect(
      tool.execute(
        'call-missing-prompt',
        {
          operation: 'spawn',
          model: 'OpenAI/gpt-cheap',
          description: '   ',
          prompt: '',
        },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/prompt/);
  });

  it('spawn 先归一化默认 task/异步，再交给 typed Main RPC', async () => {
    const { deps, tool } = setup();
    const result = await tool.execute(
      'call-1',
      { operation: 'spawn', description: 'review', prompt: 'review this' },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.invoke).toHaveBeenCalledWith(
      {
        operation: 'spawn',
        mode: 'task',
        description: 'review',
        prompt: 'review this',
        wait: false,
      },
      undefined
    );
    expect(result.details).toMatchObject({ request: { operation: 'spawn', mode: 'task' } });
  });

  it('schema 校验前：漏传 operation 但有 description 与 prompt 视为 spawn，否则给可读错误', async () => {
    const { deps, tool } = setup();
    const validate = (args: Record<string, unknown>) =>
      validateToolArguments(tool, {
        type: 'toolCall',
        id: 'call-op',
        name: tool.name,
        arguments: tool.prepareArguments!(args) as ToolCall['arguments'],
      }) as Record<string, unknown>;

    const args = validate({ description: 'review', prompt: 'review this' });
    expect(args.operation).toBe('spawn');
    await tool.execute('call-op', args, undefined, undefined, {} as never);
    expect(deps.invoke).toHaveBeenCalledWith(
      {
        operation: 'spawn',
        mode: 'task',
        description: 'review',
        prompt: 'review this',
        wait: false,
      },
      undefined
    );

    for (const bad of [{}, { description: 'review' }, { description: 'review', prompt: '  ' }]) {
      let message = '';
      try {
        validate(bad);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/requires operation.*operation:"spawn".*description and prompt/);
      expect(message).not.toMatch(/Validation failed/);
    }
    expect(() => validate({ operation: 'spwan', description: 'd', prompt: 'p' })).toThrow(
      'unknown operation "spwan". Expected one of: spawn, send, wait, report, list, message, stop, dismiss'
    );
    expect(validate({ operation: 'report', runId: 'r1' })).toEqual({
      operation: 'report',
      runId: 'r1',
    });
    expect(deps.invoke).toHaveBeenCalledTimes(1);
  });

  it('spawn/send 带 wait:true 被 abort 时只打断等待，仍返回 Main 的回执', async () => {
    const emitted: AgentWorkerEvent[] = [];
    const invoker = new AgentControlInvoker(
      { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' },
      (event) => emitted.push(event),
      () => 'req-wait'
    );
    const { tool } = setup({ invoke: (request, signal) => invoker.invoke(request, signal) });
    const controller = new AbortController();
    const running = tool.execute(
      'call-abort',
      { operation: 'send', agentId: 'agent-1', message: 'more', wait: true },
      controller.signal,
      undefined,
      {} as never
    );
    controller.abort();
    expect(emitted.at(-1)).toMatchObject({ type: 'agent-control-cancel', requestId: 'req-wait' });
    const receipt = {
      agentId: 'agent-1',
      runId: 'run-1',
      delivery: 'steer',
      status: 'running',
      report: { runs: [], timedOut: false, interrupted: true },
    };
    invoker.resolve('req-wait', { ok: true, value: receipt });
    await expect(running).resolves.toMatchObject({ details: receipt });
  });

  it('list/message normalize pagination and server-bound sender inputs', async () => {
    const { deps, tool } = setup();
    await tool.execute('list', { operation: 'list', limit: 5 }, undefined, undefined, {} as never);
    await tool.execute(
      'message',
      { operation: 'message', to: 'agent-1', text: 'status?' },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.invoke).toHaveBeenNthCalledWith(1, { operation: 'list', limit: 5 }, undefined);
    expect(deps.invoke).toHaveBeenNthCalledWith(
      2,
      { operation: 'message', to: 'agent-1', text: 'status?' },
      undefined
    );
  });

  it('send 默认 auto/异步，next 可冻结新一轮 schema/gate', async () => {
    const { deps, tool } = setup();
    const schema = { type: 'object' };
    await tool.execute(
      'call-2',
      {
        operation: 'send',
        agentId: 'agent-1',
        message: 'next task',
        delivery: 'next',
        schema,
        gate: { commandRef: 'tests' },
      },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'send',
        delivery: 'next',
        wait: false,
        schema,
        gate: { commandRef: 'tests' },
      }),
      undefined
    );
  });

  it('无效参数组合在 RPC 前拒绝，gate 不接受自由 shell 字符串', async () => {
    const { deps, tool } = setup();
    await expect(
      tool.execute(
        'call-3',
        { operation: 'wait', agentId: 'agent-1' },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/invalid/i);
    await expect(
      tool.execute(
        'call-4',
        {
          operation: 'spawn',
          description: 'x',
          prompt: 'x',
          gate: 'pnpm test',
        },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/invalid/i);
    await expect(
      tool.execute(
        'call-argv',
        {
          operation: 'spawn',
          description: 'x',
          prompt: 'x',
          gate: { argv: ['pnpm', 'test'] },
        },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/invalid/i);
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it('Main 结构化拒绝转成工具错误，不解析自然语言找 ID', async () => {
    const { tool } = setup({
      invoke: vi.fn(async () => ({
        ok: false as const,
        code: 'mode-disabled' as const,
        error: 'task mode disabled',
      })),
    });
    await expect(
      tool.execute(
        'call-5',
        { operation: 'spawn', description: 'x', prompt: 'x' },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/mode-disabled.*task mode disabled/i);
  });

  it('模型后缀先归一化 thinking，并严格校验模型目录', async () => {
    const { deps, tool } = setup();
    await tool.execute(
      'call-model',
      {
        operation: 'spawn',
        description: 'x',
        prompt: 'x',
        model: 'OpenAI/gpt-cheap:high',
      },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'OpenAI/gpt-cheap', thinking: 'high' }),
      undefined
    );
    await expect(
      tool.execute(
        'call-unknown-model',
        { operation: 'spawn', description: 'x', prompt: 'x', model: 'unknown' },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/unknown model/i);
  });

  it('agent_pick 类型漏传 model 时用第一个子代理模型并在回执注明；无可选模型仍报错', async () => {
    const required = setup({
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
    const result = await required.tool.execute(
      'call-required',
      { operation: 'spawn', description: 'x', prompt: 'x', agent_type: 'scout' },
      undefined,
      undefined,
      {} as never
    );
    expect(required.deps.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'OpenAI/gpt-cheap' }),
      undefined
    );
    expect(JSON.stringify(result.content)).toContain('OpenAI/gpt-cheap');

    const none = setup({
      models: [],
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
    await expect(
      none.tool.execute(
        'call-none',
        { operation: 'spawn', description: 'x', prompt: 'x', agent_type: 'scout' },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/requires a model/i);
    expect(none.deps.invoke).not.toHaveBeenCalled();

    const locked = setup({
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
    await expect(
      locked.tool.execute(
        'call-locked',
        {
          operation: 'spawn',
          description: 'x',
          prompt: 'x',
          agent_type: 'reviewer',
          model: 'OpenAI/gpt-cheap',
        },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/does not allow custom model/i);
    expect(locked.deps.invoke).not.toHaveBeenCalled();
  });

  it('无可选模型时不暴露 model 参数', () => {
    const { tool } = setup({ models: [] });
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(properties).not.toHaveProperty('model');
  });

  it('wait 超过上限的 timeoutMs 在 schema 校验前截到 5 分钟，不报错', async () => {
    const { tool, deps } = setup();
    expect(
      tool.prepareArguments?.({ operation: 'wait', runId: 'r', timeoutMs: 86_400_000 })
    ).toEqual({ operation: 'wait', runId: 'r', timeoutMs: 300_000 });
    await tool.execute(
      'call-clamp',
      { operation: 'wait', runId: 'r', timeoutMs: 3_600_000 },
      undefined,
      undefined,
      {} as never
    );
    expect(deps.invoke).toHaveBeenCalledWith(
      { operation: 'wait', runIds: ['r'], until: 'all', timeoutMs: 300_000 },
      undefined
    );
  });

  it('wait 默认 30 秒、上限 5 分钟，描述与 schema 同源', () => {
    const { tool } = setup();
    const timeoutMs = (
      tool.parameters as { properties: Record<string, { maximum?: number; description?: string }> }
    ).properties.timeoutMs;
    expect(timeoutMs.maximum).toBe(300_000);
    expect(timeoutMs.description).toContain('Default 30000');
    expect(tool.promptGuidelines?.join('\n')).toContain(
      'wait defaults to 30 seconds and is capped at 5 minutes'
    );
  });

  it('插话解除等待：回执带说明，子代理继续跑', async () => {
    const detach = new AbortController();
    let reason: 'steer' | undefined;
    const untrack = vi.fn();
    const { tool } = setup({
      trackWait: () => ({ signal: detach.signal, reason: () => reason, untrack }),
      invoke: vi.fn(
        async (_request, _signal, detachSignal?: AbortSignal) =>
          new Promise<AgentControlToolResponse>((resolve) => {
            detachSignal?.addEventListener('abort', () =>
              resolve({
                ok: true as const,
                value: {
                  runs: [],
                  timedOut: false,
                  interrupted: true,
                  pending: [{ agentId: 'a', runId: 'r', status: 'running', elapsedMs: 1 }],
                },
              })
            );
          })
      ),
    });
    const running = tool.execute(
      'call-steer',
      { operation: 'wait', runId: 'r' },
      undefined,
      undefined,
      {} as never
    );
    reason = 'steer';
    detach.abort();
    const result = await running;
    expect(untrack).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      interrupted: true,
      note: expect.stringContaining('the user sent a new message'),
    });
  });

  it('等待超时回执说明不算失败；不等待的操作不登记', async () => {
    const trackWait = vi.fn();
    const { tool } = setup({
      trackWait,
      invoke: vi.fn(async () => ({
        ok: true as const,
        value: {
          agentId: 'a',
          runId: 'r',
          report: { runs: [], timedOut: true, interrupted: false },
        },
      })),
    });
    trackWait.mockReturnValue({
      signal: new AbortController().signal,
      reason: () => undefined,
      untrack: () => {},
    });
    const waited = await tool.execute(
      'call-timeout',
      { operation: 'send', agentId: 'a', message: 'go', wait: true },
      undefined,
      undefined,
      {} as never
    );
    expect(waited.details).toMatchObject({ note: expect.stringContaining('not a failure') });
    await tool.execute(
      'call-async',
      { operation: 'send', agentId: 'a', message: 'go' },
      undefined,
      undefined,
      {} as never
    );
    expect(trackWait).toHaveBeenCalledTimes(1);
  });
});

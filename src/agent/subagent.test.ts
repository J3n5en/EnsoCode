import type { SpawnModelConfig } from '@shared/types';
import type { AgentControlToolRequest, AgentControlToolResponse } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import { CoworkerIdleReminder, createUnifiedSubagentTool } from './subagent';

const model: SpawnModelConfig = {
  api: 'openai-completions',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test',
  modelId: 'worker',
  settingsProviderId: 'provider',
};

describe('subagent unified control', () => {
  it('normalizes model thinking before the typed Main invocation', async () => {
    const invoke = vi.fn(async (request) => ({ ok: true as const, value: request }));
    const tool = createUnifiedSubagentTool({
      agentTypes: [],
      models: [{ name: 'Provider/worker', config: model }],
      invoke,
    });
    await tool.execute(
      'call-1',
      {
        operation: 'spawn',
        description: 'implement',
        prompt: 'implement',
        model: 'Provider/worker:high',
      },
      undefined,
      undefined,
      {} as never
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'Provider/worker', thinking: 'high', wait: false }),
      undefined
    );
  });

  it('后台 spawn / send 回执带知识边界 note；wait 拿到结果时不带', async () => {
    const invoke = vi.fn(async (request: AgentControlToolRequest) => ({
      ok: true as const,
      value:
        request.operation === 'spawn' && request.wait
          ? {
              agentId: 'a1',
              runId: 'r1',
              mode: 'task',
              status: 'running',
              report: { runs: [], timedOut: false, interrupted: false },
            }
          : { agentId: 'a1', runId: 'r1', mode: 'task', status: 'running' },
    }));
    const tool = createUnifiedSubagentTool({ agentTypes: [], models: [], invoke });
    const run = (params: Record<string, unknown>) =>
      tool.execute('call', params, undefined, undefined, {} as never);
    const spawned = await run({ operation: 'spawn', description: 'd', prompt: 'p' });
    expect(spawned.details).toMatchObject({
      agentId: 'a1',
      note: expect.stringContaining('You know nothing about its results'),
    });
    expect(JSON.stringify(spawned.content)).toContain('do not mention them to the user');
    const sent = await run({ operation: 'send', agentId: 'a1', message: 'more' });
    expect(sent.details).toMatchObject({
      note: expect.stringContaining('You know nothing about its results'),
    });
    const waited = await run({ operation: 'spawn', description: 'd', prompt: 'p', wait: true });
    expect(JSON.stringify(waited.details)).not.toContain('You know nothing');
  });

  it('工具指引写明不得编造结果、用户追问时报状态、不要重复委派的工作', () => {
    const tool = createUnifiedSubagentTool({ agentTypes: [], models: [], invoke: vi.fn() });
    const guidelines = (tool.promptGuidelines ?? []).join('\n');
    expect(guidelines).toMatch(/Never fabricate or predict/);
    expect(guidelines).toMatch(/still running/);
    expect(guidelines).toMatch(/Once you've delegated/);
    expect(guidelines).toMatch(/smart colleague/);
  });
});

describe('CoworkerIdleReminder', () => {
  type Child = { name: string; running: boolean };
  const spawn = (mode: 'task' | 'coworker'): AgentControlToolRequest => ({
    operation: 'spawn',
    mode,
    description: 'review',
    prompt: 'look',
    wait: false,
  });
  const receipt = (agentId: string, runId: string): AgentControlToolResponse => ({
    ok: true,
    value: { agentId, runId, mode: 'coworker', status: 'running' },
  });
  /** worker 按 Main 下发的 runId 找子会话 */
  const byRun = (children: Map<string, Child>) => (runIds: ReadonlySet<string>) =>
    [...runIds].map((runId) => children.get(runId)).find(Boolean) ?? null;
  const takeTimes = (
    reminder: CoworkerIdleReminder,
    times: number,
    lookup: (runIds: ReadonlySet<string>) => Child | null
  ) => Array.from({ length: times }, () => reminder.take(lookup)).flat();

  it('只提醒主 agent 自己雇的 coworker；task 与失败的 spawn 不登记', () => {
    const reminder = new CoworkerIdleReminder(2);
    reminder.observe(spawn('task'), {
      ok: true,
      value: { agentId: 't1', runId: 'r1', mode: 'task', status: 'running' },
    });
    reminder.observe(spawn('coworker'), { ok: false, code: 'mode-disabled', error: 'off' });
    expect(takeTimes(reminder, 5, () => ({ name: 'x', running: false }))).toEqual([]);
  });

  it('闲置超过阈值才提醒，带上队员名和 agentId；正在跑的不算闲置', () => {
    const reminder = new CoworkerIdleReminder(2);
    const child = { name: 'reviewer-1a2b3c4d', running: true };
    const lookup = byRun(new Map([['r1', child]]));
    reminder.observe(spawn('coworker'), receipt('a1', 'r1'));
    expect(takeTimes(reminder, 5, lookup)).toEqual([]);
    child.running = false;
    expect(takeTimes(reminder, 2, lookup)).toEqual([]);
    const [text] = reminder.take(lookup);
    expect(text).toContain('reviewer-1a2b3c4d');
    expect(text).toContain('agentId a1');
    expect(text).toContain('3 tool calls');
    expect(text).toContain('operation=dismiss');
  });

  it('发消息或读结果算使用并重新计数；提醒后又被使用，下次间隔翻倍', () => {
    const reminder = new CoworkerIdleReminder(2);
    const child = { name: 'reviewer-1a2b3c4d', running: false };
    const lookup = byRun(new Map([['r1', child]]));
    reminder.observe(spawn('coworker'), receipt('a1', 'r1'));
    takeTimes(reminder, 2, lookup);
    reminder.observe({ operation: 'report', runId: 'r1' }, { ok: true, value: {} });
    expect(takeTimes(reminder, 2, lookup)).toEqual([]);
    expect(reminder.take(lookup)).toHaveLength(1);
    reminder.observe(
      { operation: 'message', to: 'a1', text: 'next' },
      { ok: true, value: { agentId: 'a1', runId: 'r2', delivery: 'next', status: 'queued' } }
    );
    reminder.observe(
      { operation: 'wait', runIds: ['r2'], until: 'all' },
      { ok: true, value: { runs: [], timedOut: false, interrupted: false } }
    );
    expect(takeTimes(reminder, 6, lookup)).toEqual([]);
    expect(reminder.take(lookup)).toHaveLength(1);
  });

  it('解雇或子会话已不在后不再提醒；尚未对上子会话时先保留登记', () => {
    const reminder = new CoworkerIdleReminder(1);
    const children = new Map<string, Child>([
      ['r1', { name: 'a', running: false }],
      ['r2', { name: 'b', running: false }],
    ]);
    const lookup = byRun(children);
    reminder.observe(spawn('coworker'), receipt('a1', 'r1'));
    reminder.observe(spawn('coworker'), receipt('a2', 'r2'));
    reminder.observe(spawn('coworker'), receipt('a3', 'r3'));
    reminder.observe({ operation: 'dismiss', agentId: 'a1' }, { ok: true, value: {} });
    reminder.take(lookup);
    children.delete('r2');
    expect(takeTimes(reminder, 3, lookup)).toEqual([]);
    children.set('r3', { name: 'c', running: false });
    const texts = takeTimes(reminder, 2, lookup);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('agentId a3');
    expect(texts[0]).not.toMatch(/agentId a[12]/);
  });
});

describe('子代理模型选型描述', () => {
  const models = [
    { name: 'Max/claude-opus-5', config: model, description: '只读调研、大量读代码用这个' },
    { name: 'OpenAI/gpt-6', config: model, description: '   ' },
    { name: 'xAI/grok-4', config: model, description: '代码评审、架构设计用这个' },
    { name: 'Plain/no-note', config: model },
  ];

  it('model 参数说明和 promptGuidelines 带上有描述的模型，跳过空白描述', () => {
    const tool = createUnifiedSubagentTool({ agentTypes: [], models, invoke: vi.fn() });
    const expected =
      'Max/claude-opus-5: 只读调研、大量读代码用这个; xAI/grok-4: 代码评审、架构设计用这个';
    const schema = tool.parameters as {
      properties: { model: { description: string; enum: string[] } };
    };
    expect(schema.properties.model.enum).toEqual(models.map((entry) => entry.name));
    expect(schema.properties.model.description).toContain(expected);
    expect(schema.properties.model.description).not.toContain('Plain/no-note');
    expect(schema.properties.model.description).not.toContain('OpenAI/gpt-6:');
    const guidelines = (tool.promptGuidelines ?? []).join('\n');
    expect(guidelines).toContain(expected);
    const notes = guidelines.split('Short names are rejected. ')[1] ?? '';
    expect(notes).not.toContain('Plain/no-note');
    expect(notes).not.toContain('OpenAI/gpt-6');
  });
});

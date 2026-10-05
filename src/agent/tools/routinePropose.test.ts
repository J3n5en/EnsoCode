import { expect, it, vi } from 'vitest';
import { parseAgentWorkerEvent } from '../../shared/types/agent';
import { MemoryInvoker } from './memory';
import { createRoutineProposeTool, normalizeRoutineProposeParams } from './routinePropose';

it('schema 校验前归一化：别名键、去空白、@ 前缀、null 与空串删除、数字转串', () => {
  expect(
    normalizeRoutineProposeParams({
      name: '  早报 ',
      instructions: ' 汇总昨天的提交 ',
      cron: ' 0 9 * * 1-5 ',
      done_by: '@阿全',
    })
  ).toEqual({ title: '早报', prompt: '汇总昨天的提交', schedule: '0 9 * * 1-5', doneBy: '阿全' });
  expect(
    normalizeRoutineProposeParams({
      title: 'x',
      task: 'y',
      when: 'daily 9:00',
      executor: null,
      doneBy: '',
    })
  ).toEqual({ title: 'x', prompt: 'y', schedule: 'daily 9:00' });
  expect(normalizeRoutineProposeParams({ title: 1, prompt: 'p', schedule: 'hourly' })).toEqual({
    title: '1',
    prompt: 'p',
    schedule: 'hourly',
  });
  expect(normalizeRoutineProposeParams('bad')).toBe('bad');
});

it('声明完整类型的 schema 与 prepareArguments，并经 invoker 调用 routine_propose', async () => {
  const invoker = new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {});
  const invoke = vi.spyOn(invoker, 'invoke').mockResolvedValue({ ok: true });
  const tool = createRoutineProposeTool(invoker as never);
  expect(tool.name).toBe('routine_propose');
  const schema = tool.parameters as unknown as {
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, { type?: string }>;
  };
  expect(schema.type).toBe('object');
  expect(schema.required).toEqual(['title', 'prompt', 'schedule']);
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties).sort()).toEqual(
    ['doneBy', 'prompt', 'schedule', 'title'].sort()
  );
  for (const property of Object.values(schema.properties)) expect(property.type).toBe('string');
  expect(tool.prepareArguments).toBeDefined();
  await tool.execute(
    'id',
    { name: 'a', prompt: 'b', schedule: 'hourly' } as never,
    undefined,
    undefined as never,
    undefined as never
  );
  expect(invoke).toHaveBeenCalledWith(
    'routine_propose',
    { title: 'a', prompt: 'b', schedule: 'hourly' },
    undefined
  );
});

it('worker 事件协议接受 routine_propose op', () => {
  const event = {
    type: 'delegation-invoke',
    identity: { sessionId: 's', generation: '11111111-1111-4111-8111-111111111111' },
    seq: 1,
    requestId: 'r',
    op: 'routine_propose',
    params: { title: 'a' },
  };
  expect(parseAgentWorkerEvent(event)).toEqual(event);
  expect(parseAgentWorkerEvent({ ...event, op: 'routine_delete' })).toBeNull();
});

import { type ToolCall, validateToolArguments } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { createDelegationTools, normalizeDelegationParams } from './delegation';
import { MemoryInvoker } from './memory';

it('normalizes optional nulls and boolean text before full typed schema validation', () => {
  expect(normalizeDelegationParams({ id: null, cancel: 'false' })).toEqual({ cancel: false });
  expect(normalizeDelegationParams({ to: 'Bob', task: 't', taskId: 3 })).toEqual({
    to: 'Bob',
    task: 't',
    taskId: '3',
  });
  expect(normalizeDelegationParams({ to: 'Bob', task: 't', taskId: null })).toEqual({
    to: 'Bob',
    task: 't',
  });
  expect(normalizeDelegationParams({ to: 'Bob', task: 't', deadlineMinutes: '30' })).toEqual({
    to: 'Bob',
    task: 't',
    deadlineMinutes: 30,
  });
  expect(
    normalizeDelegationParams({ to: 'Bob', task: 't', deadlineMinutes: null, keep: null })
  ).toEqual({
    to: 'Bob',
    task: 't',
  });
  expect(normalizeDelegationParams({ to: 'Bob', task: 't', keep: 'true' })).toEqual({
    to: 'Bob',
    task: 't',
    keep: true,
  });
  expect(normalizeDelegationParams({ deadlineMinutes: 'soon' })).toEqual({
    deadlineMinutes: 'soon',
  });
  expect(normalizeDelegationParams({ to: 'Bob', task: 't', check: 'XYZ_PASS' })).toEqual({
    to: 'Bob',
    task: 't',
    check: { kind: 'output-contains', text: 'XYZ_PASS' },
  });
  expect(normalizeDelegationParams({ to: 'Bob', task: 't', check: null })).toEqual({
    to: 'Bob',
    task: 't',
  });
  const tools = createDelegationTools(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {})
  );
  expect(tools.map((tool) => tool.name)).toEqual([
    'delegate',
    'check_delegation',
    'retry_delegation',
  ]);
  expect(Object.keys((tools[0].parameters as { properties: object }).properties)).toEqual([
    'to',
    'task',
    'context',
    'deadlineMinutes',
    'keep',
    'check',
  ]);
  for (const tool of tools) {
    const schema = tool.parameters as unknown as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(tool.prepareArguments).toBeDefined();
    for (const property of Object.values(schema.properties))
      expect(property).toHaveProperty('type');
  }
});

it('describes auto-created board tasks only for group sessions', () => {
  const describe = (groupTasks: boolean) =>
    createDelegationTools(new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {}), {
      groupTasks,
    }).find((tool) => tool.name === 'delegate')?.description ?? '';
  expect(describe(true)).toContain('Without taskId, a new board task is created');
  expect(describe(true)).toContain('the task becomes blocked (run failed) with the same assignee');
  expect(describe(true)).toContain('status="blocked"');
  expect(describe(true)).toContain('appends to that run instead of starting a new one');
  expect(describe(true)).not.toContain('on failure/cancel it returns to todo');
  expect(describe(false)).not.toContain('board task');
  expect(describe(false)).not.toContain('appends to that run');
});

it('report_blocked 只挂在看板任务的委派会话，schema 带完整类型，waitFor: null 归一化掉', () => {
  const names = (delegationTask: boolean) =>
    createDelegationTools(new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {}), {
      delegationTask,
    }).map((tool) => tool.name);
  expect(names(false)).not.toContain('report_blocked');
  expect(names(true)).toContain('report_blocked');
  const tool = createDelegationTools(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {}),
    { delegationTask: true }
  ).find((item) => item.name === 'report_blocked')!;
  expect(tool.parameters).toMatchObject({
    type: 'object',
    properties: {
      need: { type: 'string', minLength: 1, maxLength: 300 },
      waitFor: { type: 'string', enum: ['parent', 'human'] },
    },
    required: ['need'],
  });
  expect(tool.description).toContain('does not count as blocked');
  expect(normalizeDelegationParams({ need: 'x', waitFor: null })).toEqual({ need: 'x' });
});

it('retry_delegation：完整类型的 schema，只要求 id；归一化在 schema 校验之前', () => {
  const tools = createDelegationTools(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {})
  );
  const retry = tools.find((tool) => tool.name === 'retry_delegation')!;
  const schema = retry.parameters as unknown as {
    properties: Record<string, { type: string; maxLength?: number }>;
    required: string[];
    additionalProperties: boolean;
  };
  expect(Object.keys(schema.properties)).toEqual(['id', 'note']);
  expect(schema.properties.id.type).toBe('string');
  expect(schema.properties.note).toMatchObject({ type: 'string', maxLength: 2000 });
  expect(schema.required).toEqual(['id']);
  expect(schema.additionalProperties).toBe(false);
  expect(retry.description).toMatch(/original child session/);
  expect(retry.description).toMatch(/3/);
  expect(normalizeDelegationParams({ id: 'd1', note: null })).toEqual({ id: 'd1' });
  expect(normalizeDelegationParams({ id: 'd1', note: '   ' })).toEqual({ id: 'd1' });
  expect(normalizeDelegationParams({ id: 'd1', note: ' 先读 README ' })).toEqual({
    id: 'd1',
    note: '先读 README',
  });
});

it('群聊里的 delegate 说明：讨论在群里接力，委派只用于耗时长的执行任务', () => {
  const [group] = createDelegationTools(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {}),
    { groupTasks: true }
  );
  expect(group.description).toMatch(/long-running execution/);
  const [direct] = createDelegationTools(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {})
  );
  expect(direct.description).not.toMatch(/long-running execution/);
});

it('retry_delegation 使用实际 schema 校验归一化后的参数，并拒绝错误类型和超长说明', () => {
  const retry = createDelegationTools(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {})
  ).find((tool) => tool.name === 'retry_delegation')!;
  const validate = (args: ToolCall['arguments']) =>
    validateToolArguments(retry, {
      type: 'toolCall',
      id: 'call-1',
      name: retry.name,
      arguments: retry.prepareArguments!(args) as ToolCall['arguments'],
    });
  expect(validate({ id: 'd1', note: null })).toEqual({ id: 'd1' });
  expect(validate({ id: 'd1', note: '   ' })).toEqual({ id: 'd1' });
  expect(validate({ id: 'd1', note: ' 继续验证 ' })).toEqual({ id: 'd1', note: '继续验证' });
  // pi 的真实校验器会将标量转换成 schema 类型；断言转换结果，而不是误报成校验绕过。
  expect(validate({ id: 'd1', note: 1 })).toEqual({ id: 'd1', note: '1' });
  const invalid: ToolCall['arguments'][] = [
    {},
    { id: [] },
    { id: 'd1', note: {} },
    { id: 'd1', note: 'x'.repeat(2001) },
  ];
  for (const args of invalid) expect(() => validate(args)).toThrow();
});

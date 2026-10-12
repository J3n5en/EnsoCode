import { type ToolCall, validateToolArguments } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { createDelegationTools, type DelegationOp, normalizeDelegationParams } from './delegation';
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

const BASE_DESCRIPTION =
  "Delegate a task to another member by name or id. Returns immediately; results arrive asynchronously. Context is truncated to 8000 characters. The delegation fails with a timeout after deadlineMinutes (capped by the member's own limit, 240 minutes by default). If the user stops or interrupts your current turn, delegations started in it are canceled unless keep is true. With check, the delegation passes only if one of the member's final tool outputs contains check.text; otherwise it ends as failed with 'acceptance check failed'.";
const DISCUSS_SENTENCE =
  ' In a group chat, handle discussion openly in the group with @mentions; delegate only long-running execution tasks that need a separate session.';
// 与 origin/main 群聊 delegate 看板说明逐字一致（讨论模式关时整段说明应与 main 相同）
const TASK_SENTENCE =
  ' Pass taskId (e.g. "#3") to hand a group board task to the member: the task becomes doing with them as assignee; when the delegation succeeds it goes to review (done directly only if the member created the task) for the task creator or a human to accept or reject with group_tasks; on cancel it returns to todo.' +
  ' If the run fails (error, timeout, interrupted, denied or check failed) the task becomes blocked (run failed) with the same assignee: delegate the same taskId to them again to retry, or to another member to hand it over.' +
  ' If the member reports they are blocked, the result has status="blocked" and says what they need; the task becomes blocked.' +
  ' Answer by delegating the same taskId to them again with the answer (they continue in the same session); if you are not sure of the answer, ask the human in the group instead of guessing.' +
  ' After 3 blocked reports in a row from the same member on a task, only a human can answer it (on the task card).' +
  ' The same member keeps one session per task: delegating a taskId they worked on before (retry, or adding to a task awaiting review) continues that session, so send only what is new; another member starts fresh with a summary of the earlier runs.' +
  ' Delegating a taskId that the same member is still queued on or running from this conversation appends to that run instead of starting a new one: the result returns once (with your latest turn; keep applies if either call set it), the deadline becomes the later of the two, check is ignored, and the reply has merged:true with delivery accepted (reached the member), deferred (runs later in the same run, or not confirmed within 10 seconds) or failed.' +
  ' Appends that do not finish before the run ends are listed in its result.' +
  ' From another conversation it is queued as the next run instead.' +
  ' Without taskId, a new board task is created for each delegate call (titled from the first line of task, created by you) and handled the same way; the result includes its taskId.';

it('群聊里的 delegate 说明（讨论模式开）：与 HEAD 文案逐字一致', () => {
  const [group] = createDelegationTools(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {}),
    { groupTasks: true, discussMode: true }
  );
  expect(group.description).toMatch(/long-running execution/);
  expect(group.description).toBe(BASE_DESCRIPTION + DISCUSS_SENTENCE + TASK_SENTENCE);
  const [direct] = createDelegationTools(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {})
  );
  expect(direct.description).not.toMatch(/long-running execution/);
  expect(direct.description).toBe(BASE_DESCRIPTION);
});

it('群聊里的 delegate 说明（讨论模式关）：不含讨论说明，与 main 一致；私聊即使带标志也不含', () => {
  const invoker = new MemoryInvoker<DelegationOp>({ sessionId: 's', generation: 'g' }, () => {});
  const [off] = createDelegationTools(invoker, { groupTasks: true });
  expect(off.description).not.toMatch(/handle discussion openly/);
  expect(off.description).toBe(BASE_DESCRIPTION + TASK_SENTENCE);
  const [explicitOff] = createDelegationTools(invoker, { groupTasks: true, discussMode: false });
  expect(explicitOff.description).toBe(off.description);
  const [direct] = createDelegationTools(invoker, { discussMode: true });
  expect(direct.description).toBe(BASE_DESCRIPTION);
  // 讨论开关只换文案，不改参数 schema
  const [on] = createDelegationTools(invoker, { groupTasks: true, discussMode: true });
  expect(on.parameters).toEqual(off.parameters);
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

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
  expect(tools.map((tool) => tool.name)).toEqual(['delegate', 'check_delegation']);
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

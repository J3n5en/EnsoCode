import { expect, it } from 'vitest';
import { createGroupTasksTool, normalizeGroupTaskParams } from './groupTasks';
import { MemoryInvoker } from './memory';

it('normalizes aliases, numeric ids and nulls before typed schema validation', () => {
  expect(normalizeGroupTaskParams({ action: ' Done ', id: 3, result: 'ok', detail: null })).toEqual(
    { action: 'complete', id: '3', result: 'ok' }
  );
  expect(normalizeGroupTaskParams({ action: 'create', task_id: '#2', title: 'x' })).toEqual({
    action: 'add',
    id: '#2',
    title: 'x',
  });
  expect(normalizeGroupTaskParams({ action: 'take', taskId: 7 })).toEqual({
    action: 'claim',
    id: '7',
  });
  expect(normalizeGroupTaskParams('bad')).toBe('bad');
  expect(normalizeGroupTaskParams({ action: 'add', title: 'x', check: 'OK' })).toEqual({
    action: 'add',
    title: 'x',
    check: { kind: 'output-contains', text: 'OK' },
  });
  expect(normalizeGroupTaskParams({ action: 'add', title: 'x', check: null })).toEqual({
    action: 'add',
    title: 'x',
  });
});

it('declares a fully typed schema with prepareArguments', () => {
  const tool = createGroupTasksTool(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {})
  );
  expect(tool.name).toBe('group_tasks');
  const schema = tool.parameters as unknown as {
    type: string;
    required: string[];
    properties: Record<string, { type?: string; enum?: string[] }>;
  };
  expect(schema.type).toBe('object');
  expect(schema.required).toEqual(['action']);
  expect(schema.properties.action.enum).toEqual([
    'list',
    'add',
    'claim',
    'update',
    'complete',
    'cancel',
  ]);
  for (const property of Object.values(schema.properties)) expect(property).toHaveProperty('type');
  expect(schema.properties.check).toMatchObject({ type: 'object' });
  expect(tool.prepareArguments).toBeDefined();
});

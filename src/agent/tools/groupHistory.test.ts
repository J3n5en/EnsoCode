import { expect, it } from 'vitest';
import { createGroupHistoryTool, normalizeGroupHistoryParams } from './groupHistory';
import { MemoryInvoker } from './memory';

it('normalizes aliases, numeric strings, nulls and limit bounds before schema validation', () => {
  expect(
    normalizeGroupHistoryParams({
      before: '#42',
      after_seq: ' 3 ',
      count: '250',
      keyword: '  Redis ',
      speaker: '@Alice',
    })
  ).toEqual({ beforeSeq: 42, afterSeq: 3, limit: 100, query: 'Redis', from: 'Alice' });
  expect(
    normalizeGroupHistoryParams({
      beforeSeq: 12.7,
      limit: 0,
      query: '',
      from: null,
      afterSeq: null,
    })
  ).toEqual({ beforeSeq: 12, limit: 1 });
  expect(normalizeGroupHistoryParams({ beforeSeq: 'abc' })).toEqual({ beforeSeq: 'abc' });
  expect(normalizeGroupHistoryParams('bad')).toBe('bad');
});

it('declares a fully typed schema with prepareArguments', () => {
  const tool = createGroupHistoryTool(
    new MemoryInvoker({ sessionId: 's', generation: 'g' }, () => {})
  );
  expect(tool.name).toBe('group_history');
  const schema = tool.parameters as unknown as {
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, { type?: string; maximum?: number }>;
  };
  expect(schema.type).toBe('object');
  expect(schema.required).toEqual([]);
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties).sort()).toEqual(
    ['afterSeq', 'beforeSeq', 'from', 'limit', 'query'].sort()
  );
  expect(schema.properties.beforeSeq.type).toBe('integer');
  expect(schema.properties.limit.maximum).toBe(100);
  for (const property of Object.values(schema.properties)) expect(property).toHaveProperty('type');
  expect(tool.prepareArguments).toBeDefined();
});

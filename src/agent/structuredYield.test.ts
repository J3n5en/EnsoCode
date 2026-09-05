import { describe, expect, it } from 'vitest';
import {
  collectStructuredYield,
  extractJsonValue,
  parseAgentUri,
  parseJsonFromAssistant,
  pointerGet,
  validateAgainstSchema,
  withAgentRead,
} from './structuredYield';

describe('structuredYield', () => {
  it('parses fenced or raw JSON from the last assistant text', () => {
    expect(parseJsonFromAssistant('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(parseJsonFromAssistant('here:\n{"a":1}\n')).toEqual({ a: 1 });
    expect(parseJsonFromAssistant('not json')).toBeUndefined();
  });

  it('validates a JSON Schema subset (type / required / properties)', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' }, n: { type: 'number' } },
    };
    expect(validateAgainstSchema({ name: 'x', n: 1 }, schema)).toEqual({ ok: true });
    expect(validateAgainstSchema({ n: 1 }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ name: 1 }, schema).ok).toBe(false);
  });

  it('resolves JSON Pointer queries', () => {
    const data = { user: { name: 'ada' }, tags: ['a', 'b'] };
    expect(pointerGet(data, '/user/name')).toBe('ada');
    expect(pointerGet(data, '/tags/1')).toBe('b');
    expect(() => pointerGet(data, '/nope')).toThrow(/pointer/i);
  });

  it('parses agent://id and optional ?q= pointer', () => {
    expect(parseAgentUri('agent://agent-1-abc')).toEqual({ id: 'agent-1-abc', pointer: undefined });
    expect(parseAgentUri('agent://agent-1-abc?q=/user/name')).toEqual({
      id: 'agent-1-abc',
      pointer: '/user/name',
    });
    expect(parseAgentUri('/tmp/file.ts')).toBeUndefined();
  });

  it('nudges up to twice then fails if still invalid', async () => {
    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
    let text = 'nope';
    const prompts: string[] = [];
    await expect(
      collectStructuredYield({
        text,
        schema,
        prompt: async (nudge) => {
          prompts.push(nudge);
          text = prompts.length === 1 ? '{"ok":"no"}' : 'still no';
        },
        reread: () => text,
      })
    ).rejects.toThrow(/after 2 nudges/);
    expect(prompts).toHaveLength(2);
  });

  it('accepts valid JSON after one nudge', async () => {
    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
    let text = 'nope';
    const got = await collectStructuredYield({
      text,
      schema,
      prompt: async () => {
        text = '{"ok":true}';
      },
      reread: () => text,
    });
    expect(got.value).toEqual({ ok: true });
  });

  it('extracts a stored yield by agent uri', () => {
    const store = new Map<string, unknown>([['agent-1-abc', { user: { name: 'ada' } }]]);
    expect(extractJsonValue(store, 'agent://agent-1-abc?q=/user/name')).toBe('ada');
    expect(extractJsonValue(store, 'agent://missing')).toBeUndefined();
  });

  it('withAgentRead serves agent:// and falls through otherwise', async () => {
    const store = new Map<string, unknown>([['agent-1', { a: 1 }]]);
    const inner = {
      execute: async () => ({ content: [{ type: 'text', text: 'file' }] }),
    };
    const wrapped = withAgentRead(inner as { execute: (...args: never[]) => unknown }, () => store);
    const run = wrapped.execute as (id: string, params: unknown) => Promise<unknown>;
    const hit = await run('t', { path: 'agent://agent-1?q=/a' });
    expect((hit as { content: Array<{ text: string }> }).content[0].text).toBe('1');
    const miss = await run('t', { path: '/tmp/x.ts' });
    expect((miss as { content: Array<{ text: string }> }).content[0].text).toBe('file');
  });
});

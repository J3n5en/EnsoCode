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

  // 审计 D7：截断或带尾逗号的长 JSON 会让 sliceFirstJson 从末尾逐字符缩短、反复 JSON.parse（O(n²)），
  // 60K 字符要数秒；worker（coworker 结构化收尾）与 Main（agentRunValidation）主线程都会被冻住
  it('截断的长 JSON 很快判定为不可解析，不冻结线程', () => {
    const items = Array.from({ length: 4000 }, (_, i) => `{"k":${i},"v":"x"}`).join(',');
    const truncated = `结果如下：{"items":[${items}`.slice(0, 60_000);
    const startedAt = performance.now();
    expect(parseJsonFromAssistant(truncated)).toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('带尾逗号的长 JSON 很快判定为不可解析，不冻结线程', () => {
    const items = Array.from({ length: 4000 }, (_, i) => `{"k":${i},"v":"x"}`).join(',');
    const startedAt = performance.now();
    expect(parseJsonFromAssistant(`{"items":[${items}],}`)).toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('取首个 JSON 值时不被字符串里的括号、转义引号或尾随文字干扰', () => {
    expect(
      parseJsonFromAssistant('result: {"s":"a}\\"]b","n":[1,{"x":"]"}]} 后面还有 } 与 ] 文字')
    ).toEqual({ s: 'a}"]b', n: [1, { x: ']' }] });
    expect(parseJsonFromAssistant('items: [1, 2, 3] done')).toEqual([1, 2, 3]);
    // 只认第一个括号起的值：开头的方括号注释不是 JSON 时整体判为不可解析（沿用原有语义）
    expect(parseJsonFromAssistant('[draft] {"a":1}')).toBeUndefined();
    expect(parseJsonFromAssistant('{"a":[1}] tail')).toBeUndefined();
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

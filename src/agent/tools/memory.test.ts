import type { JsonSchema } from '@shared/capabilities/types';
import { parseMemoryCaptureRequest } from '@shared/memory/toolParams';
import { describe, expect, it, vi } from 'vitest';
import { matchesJsonSchema } from '../../tooling/productCapabilityCoverage.fixture';
import { createMemoryTools, MemoryInvoker } from './memory';

const identity = { sessionId: 's1', generation: '11111111-1111-4111-8111-111111111111' };
const exec = (tool: { execute: (...args: never[]) => Promise<unknown> }, params: unknown) =>
  (tool.execute as (...a: unknown[]) => Promise<{ content: { text?: string }[] }>)(
    'c1',
    params,
    undefined,
    undefined,
    undefined
  );

describe('MemoryInvoker', () => {
  it('发 memory-invoke 并等 result；成功/失败按 ok 分派；未知 requestId 丢弃', async () => {
    const emit = vi.fn();
    const invoker = new MemoryInvoker(identity, emit);
    const p1 = invoker.invoke('search', { query: 'q' });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ identity, op: 'search', params: { query: 'q' } })
    );
    const requestId = emit.mock.calls[0]?.[0]?.requestId as string;
    expect(invoker.resolve({ requestId, ok: true, result: { results: [] } })).toBe(true);
    await expect(p1).resolves.toEqual({ results: [] });

    const p2 = invoker.invoke('capture', { content: 'c' });
    const id2 = emit.mock.calls[1]?.[0]?.requestId as string;
    invoker.resolve({ requestId: id2, ok: false, error: 'invalid_space' });
    await expect(p2).rejects.toThrow('invalid_space');
    expect(invoker.resolve({ requestId: 'nope', ok: true })).toBe(false);
  });

  it('abort / 超时 / cancelAll 都以拒绝收尾', async () => {
    vi.useFakeTimers();
    const invoker = new MemoryInvoker(identity, () => {}, { timeoutMs: 1000 });
    const controller = new AbortController();
    const aborted = invoker.invoke('search', {}, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toThrow(/abort/i);

    const timed = invoker.invoke('search', {});
    vi.advanceTimersByTime(1001);
    await expect(timed).rejects.toThrow(/timed out/i);

    const cancelled = invoker.invoke('capture', {});
    invoker.cancelAll();
    await expect(cancelled).rejects.toThrow(/cancel/i);
    expect(invoker.pendingCount).toBe(0);
    vi.useRealTimers();
  });
});

describe('createMemoryTools', () => {
  it('三个工具，schema 每个属性都声明 type，且 additionalProperties=false', () => {
    const tools = createMemoryTools(new MemoryInvoker(identity, () => {}));
    expect(tools.map((t) => t.name)).toEqual([
      'memory_search',
      'memory_capture',
      'memory_crystallize',
    ]);
    for (const tool of tools) {
      const schema = tool.parameters as unknown as {
        type: string;
        properties: Record<string, { type?: string; enum?: unknown[] }>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      for (const prop of Object.values(schema.properties)) expect(prop.type).toBeDefined();
      expect(tool.description).toMatch(/when/i);
    }
    const search = tools[0].parameters as unknown as {
      required: string[];
      properties: { mode: { type: string; enum: string[] } };
    };
    const capture = tools[1].parameters as unknown as { required: string[] };
    expect(search.required).toEqual(['query']);
    expect(search.properties.mode).toMatchObject({ type: 'string', enum: ['fast', 'deep'] });
    expect(tools[0].description).toMatch(/mode=fast/);
    expect(tools[0].description).toMatch(/mode=deep/);
    expect(capture.required).toEqual(['content']);
    const crystallize = tools[2].parameters as unknown as {
      required: string[];
      properties: { sourceIds: { type: string; items: { type: string }; minItems: number } };
    };
    expect(crystallize.required).toEqual(['sourceIds', 'title', 'content']);
    expect(crystallize.properties.sourceIds).toMatchObject({
      type: 'array',
      items: { type: 'string' },
      minItems: 3,
    });
    // 描述必须说清什么时候不该用：结晶不是每次检索后的常规动作
    expect(tools[2].description).toMatch(/Do not use/);
  });

  // pi 在 prepareArguments 之后才做 schema 校验：归一产物多出 schema 未声明的键就会被
  // additionalProperties=false 拒掉，真机全挂而直接调 execute 的测试全绿。
  it('memory_search 描述告知记忆的存储语言，并要求保留专有名词', () => {
    // 存储语言与提问语言不一致时 FTS 通道会整条哑火（trigram 对中文查英文零命中），
    // 模型必须从工具描述里知道该用哪种语言查
    const invoker = new MemoryInvoker(identity, () => {});
    const desc = (language?: string) =>
      createMemoryTools(invoker, { language })[0].description ?? '';
    expect(desc('en')).toContain('written in English');
    expect(desc('zh')).toContain('written in Chinese');
    expect(desc('auto')).toContain("the user's own language");
    // 未传 / 非法值回退英文，不能没有这段提示
    expect(desc()).toContain('written in English');
    expect(desc('klingon')).toContain('written in English');
    expect(desc('en')).toContain('verbatim');
  });

  it('prepareArguments 的输出必须通过本工具自己的 JSON schema', () => {
    const tools = createMemoryTools(new MemoryInvoker(identity, () => {}));
    const cases: Record<string, unknown[]> = {
      memory_search: [
        { query: 'pg' },
        { query: 'pg', limit: '5', spaceId: 'global' },
        { query: 'pg', eventDateFrom: '2020', eventDateTo: ' 2021-03 ' },
        { query: 'pg', recordedDateFrom: '2024-01-01', recordedDateTo: '' },
        { query: 'pg', mode: 'deep' },
        { query: 'pg', mode: 'FAST' },
      ],
      memory_capture: [
        { content: 'c' },
        { content: 'c', unitType: 'vibe' },
        { content: 'c', title: 't', unitType: 'decision', importance: 0.9, eventStart: '2020' },
        { content: 'c', force: 'true' },
        { content: 'c', evolvesFromId: 'm1', evolvesRelation: ' Replaces ' },
        { content: 'c', force: true, evolvesFromId: 'm1', evolvesRelation: 'challenges' },
        {
          content: 'c',
          title: 't',
          unitType: 'preference',
          importance: 0.6,
          spaceId: 'project',
          eventStart: '',
          eventEnd: '',
          force: false,
          evolvesFromId: '',
          evolvesRelation: 'enriches',
        },
      ],
      memory_crystallize: [
        { content: 'c', title: 't', sourceIds: ['a', 'b', 'c'] },
        { content: 'c', title: 't', sourceIds: '["a","b","c"]', force: 'true' },
        { content: 'c', title: 't', sourceIds: 'a, b, c' },
      ],
    };
    for (const tool of tools) {
      const schema = tool.parameters as unknown as JsonSchema;
      const prepare = tool.prepareArguments as unknown as (a: unknown) => unknown;
      for (const input of cases[tool.name]) {
        const prepared = prepare(input);
        expect(
          matchesJsonSchema(schema, prepared),
          `${tool.name} ${JSON.stringify(prepared)}`
        ).toBe(true);
      }
    }
  });

  it('prepareArguments 在 schema 校验前归一：缺省值、非法 unitType 回退、字符串化 JSON', () => {
    const tools = createMemoryTools(new MemoryInvoker(identity, () => {}));
    const prep = (i: number, args: unknown) =>
      (tools[i].prepareArguments as unknown as (a: unknown) => unknown)(args);
    expect(prep(0, { query: 'pg', limit: '5' })).toEqual({
      query: 'pg',
      limit: 5,
      spaceId: 'all',
      mode: 'fast',
    });
    expect(prep(1, '{"content":"c","unitType":" Vibe "}')).toEqual({
      content: 'c',
      unitType: 'vibe',
      importance: 0.6,
      spaceId: 'project',
    });
    const placeholder = prep(1, {
      content: 'c',
      title: 't',
      unitType: 'preference',
      importance: 0.6,
      spaceId: 'project',
      eventStart: '',
      eventEnd: '',
      force: false,
      evolvesFromId: '',
      evolvesRelation: 'enriches',
    });
    expect(placeholder).toEqual({
      content: 'c',
      title: 't',
      unitType: 'preference',
      importance: 0.6,
      spaceId: 'project',
    });
  });

  it('execute 把归一后的参数发上桥，并把 Main 结果以文本回给模型', async () => {
    const emit = vi.fn();
    const invoker = new MemoryInvoker(identity, emit);
    const [search, capture] = createMemoryTools(invoker);
    const pending = exec(search, { query: 'pg' });
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      op: 'search',
      params: { query: 'pg', limit: 10, spaceId: 'all' },
    });
    invoker.resolve({
      requestId: emit.mock.calls[0]?.[0]?.requestId as string,
      ok: true,
      result: { results: [{ id: 'm1' }] },
    });
    const out = await pending;
    expect(JSON.parse(out.content[0].text ?? '')).toEqual({ results: [{ id: 'm1' }] });

    const pending2 = exec(capture, { content: 'c', unitType: 'decision' });
    expect(emit.mock.calls[1]?.[0]).toMatchObject({
      op: 'capture',
      params: { content: 'c', unitType: 'decision' },
    });
    invoker.resolve({
      requestId: emit.mock.calls[1]?.[0]?.requestId as string,
      ok: true,
      result: { status: 'inserted', id: 'm2' },
    });
    await pending2;
  });

  it('execute 占位演进字段：prepare 后再归一与直接 execute 上桥 params 均可被 Main parse', async () => {
    const emit = vi.fn();
    const invoker = new MemoryInvoker(identity, emit);
    const capture = createMemoryTools(invoker)[1];
    const raw = {
      content: 'c',
      title: 't',
      unitType: 'preference',
      importance: 0.6,
      spaceId: 'project',
      eventStart: '',
      eventEnd: '',
      force: false,
      evolvesFromId: '',
      evolvesRelation: 'enriches',
    };
    const prepare = capture.prepareArguments as unknown as (a: unknown) => unknown;

    const run = async (params: unknown, id: string) => {
      const pending = exec(capture, params);
      const sent = emit.mock.calls.at(-1)?.[0] as { requestId: string; params: unknown };
      expect(sent.params).not.toHaveProperty('evolvesFromId');
      expect(sent.params).not.toHaveProperty('evolvesRelation');
      const parsed = parseMemoryCaptureRequest(sent.params);
      expect(parsed).toMatchObject({ content: 'c', title: 't', unitType: 'preference' });
      expect(parsed).not.toHaveProperty('evolvesFromId');
      expect(parsed).not.toHaveProperty('evolvesRelation');
      invoker.resolve({ requestId: sent.requestId, ok: true, result: { status: 'inserted', id } });
      const out = await pending;
      expect(JSON.parse(out.content[0].text ?? '')).toEqual({ status: 'inserted', id });
    };

    await run(prepare(raw), 'm-prep');
    await run(raw, 'm-direct');
  });

  it('search 缺 query / capture 缺 content / crystallize 缺 content 直接抛错，不上桥', async () => {
    const emit = vi.fn();
    const [search, capture, crystallize] = createMemoryTools(new MemoryInvoker(identity, emit));
    await expect(exec(search, { query: '  ' })).rejects.toThrow(/query/);
    await expect(exec(capture, {})).rejects.toThrow(/content/);
    await expect(exec(crystallize, { title: 't', sourceIds: ['a', 'b', 'c'] })).rejects.toThrow(
      /content/
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('crystallize 把归一后的 sourceIds 数组发上桥（op=crystallize）', async () => {
    const emit = vi.fn();
    const invoker = new MemoryInvoker(identity, emit);
    const [, , crystallize] = createMemoryTools(invoker);
    const pending = exec(crystallize, { content: 'c', title: 't', sourceIds: 'a, b, c' });
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      op: 'crystallize',
      params: { content: 'c', title: 't', sourceIds: ['a', 'b', 'c'] },
    });
    invoker.resolve({
      requestId: emit.mock.calls[0]?.[0]?.requestId as string,
      ok: true,
      result: { status: 'inserted' },
    });
    await pending;
  });
});

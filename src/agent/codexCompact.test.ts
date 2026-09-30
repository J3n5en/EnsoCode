import { describe, expect, it, vi } from 'vitest';
import {
  applyCodexCheckpoints,
  createCodexCompactHandler,
  extractCompactionItem,
} from './codexCompact';

const sse = (...events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
const done = (item: unknown) => ({ type: 'response.output_item.done', item });
const checkpoint = (encrypted: string) => ({ type: 'compaction', encrypted_content: encrypted });
const summaryText = (summary: string) =>
  `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;

describe('extractCompactionItem', () => {
  it('只取唯一的 compaction 条目并去掉服务端元数据', () => {
    const raw = sse(
      done({ type: 'reasoning', id: 'rs_1' }),
      done({ ...checkpoint('enc'), id: 'cmp_1' }),
      { type: 'response.completed', response: { output: [{ ...checkpoint('enc'), id: 'cmp_1' }] } }
    );
    expect(extractCompactionItem(raw)).toEqual(checkpoint('enc'));
  });

  it('错误事件抛出，缺失或多个 checkpoint 返回 undefined', () => {
    expect(() =>
      extractCompactionItem(
        sse({ type: 'response.failed', response: { error: { message: 'bad' } } })
      )
    ).toThrow('bad');
    expect(extractCompactionItem(sse(done({ type: 'message' })))).toBeUndefined();
    expect(
      extractCompactionItem(sse(done(checkpoint('a')), done(checkpoint('b'))))
    ).toBeUndefined();
  });
});

describe('applyCodexCheckpoints', () => {
  const entries = [
    {
      type: 'compaction',
      summary: 'S1',
      details: { codexCheckpoint: { provider: 'openai-codex', item: checkpoint('enc1') } },
    },
  ];
  const summaryItem = { role: 'user', content: [{ type: 'input_text', text: summaryText('S1') }] };
  const other = { role: 'user', content: [{ type: 'input_text', text: 'hi' }] };

  it('同 provider 时把可读摘要替换为 Codex checkpoint', () => {
    const payload = { model: 'gpt', input: [summaryItem, other] };
    expect(applyCodexCheckpoints(payload, entries, 'openai-codex')).toEqual({
      model: 'gpt',
      input: [checkpoint('enc1'), other],
    });
  });

  it('provider 不同或无匹配时保持原 payload', () => {
    const payload = { input: [summaryItem, other] };
    expect(applyCodexCheckpoints(payload, entries, 'other-codex')).toBe(payload);
    const plain = { input: [other] };
    expect(applyCodexCheckpoints(plain, entries, 'openai-codex')).toBe(plain);
  });
});

const codexModel = { id: 'gpt-5', provider: 'openai-codex', api: 'openai-codex-responses' };
const entry = (id: string, parentId: string | null, role: string, text: string) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2025-01-01T00:00:00.000Z',
  message:
    role === 'user'
      ? { role, content: text, timestamp: 0 }
      : {
          role,
          content: [{ type: 'text', text }],
          api: codexModel.api,
          provider: codexModel.provider,
          model: codexModel.id,
          usage: {},
          stopReason: 'stop',
          timestamp: 0,
        },
});
const branch = [
  entry('u1', null, 'user', 'first'),
  entry('a1', 'u1', 'assistant', 'answer one'),
  entry('u2', 'a1', 'user', 'second'),
  entry('a2', 'u2', 'assistant', 'answer two'),
];

function setup(options: {
  model?: typeof codexModel;
  smartKept?: string;
  smartResult?: unknown;
  response?: string;
}) {
  const smart = vi.fn(
    async () =>
      options.smartResult ?? {
        compaction: {
          summary: 'readable',
          firstKeptEntryId: options.smartKept ?? 'u2',
          tokensBefore: 100,
        },
      }
  );
  const requests: Array<{ input: unknown[]; transport?: unknown }> = [];
  const fetchImpl = vi.fn(
    async () => new Response(options.response ?? sse(done(checkpoint('enc'))))
  ) as unknown as typeof fetch;
  const complete = vi.fn(
    async (model: unknown, context: { messages: Array<{ role: string }> }, opts: any) => {
      const base = { model: 'gpt-5', input: context.messages.map(({ role }) => ({ role })) };
      const body = (await opts.onPayload(base, model)) as { input: unknown[] };
      requests.push({ input: body.input, transport: opts.transport });
      await (await opts.fetch('https://example.test/codex/responses', {})).text();
      return { role: 'assistant', content: [] };
    }
  );
  const handler = createCodexCompactHandler({ fetch: fetchImpl }, smart as never);
  const ctx = {
    model: options.model ?? codexModel,
    getSystemPrompt: () => 'system',
    sessionManager: { getBranch: () => branch },
    modelRegistry: { complete },
  };
  const event = {
    type: 'session_before_compact',
    reason: 'manual',
    branchEntries: branch,
    preparation: { firstKeptEntryId: 'u2', tokensBefore: 100 },
    signal: new AbortController().signal,
  };
  return { run: () => handler(event as never, ctx as never), smart, complete, requests };
}

describe('createCodexCompactHandler', () => {
  it('非 Codex 模型直接用 smart 结果', async () => {
    const t = setup({ model: { ...codexModel, api: 'openai-responses' } });
    expect(await t.run()).toEqual({
      compaction: { summary: 'readable', firstKeptEntryId: 'u2', tokensBefore: 100 },
    });
    expect(t.complete).not.toHaveBeenCalled();
  });

  it('Codex 模型压缩切点前缀并在 details 附带 checkpoint', async () => {
    const t = setup({});
    const result = (await t.run()) as { compaction: Record<string, unknown> };
    expect(result.compaction).toMatchObject({
      summary: 'readable',
      firstKeptEntryId: 'u2',
      details: { codexCheckpoint: { provider: 'openai-codex', item: checkpoint('enc') } },
    });
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.transport).toBe('sse');
    expect(t.requests[0]!.input).toEqual([
      { role: 'user' },
      { role: 'assistant' },
      { type: 'compaction_trigger' },
    ]);
  });

  it('smart 后移切点时按新切点重新压缩', async () => {
    const t = setup({ smartKept: 'a2' });
    const result = (await t.run()) as { compaction: Record<string, unknown> };
    expect(result.compaction.firstKeptEntryId).toBe('a2');
    expect(result.compaction.details).toBeDefined();
    expect(t.requests.at(-1)!.input).toHaveLength(4);
  });

  it('远端失败时退回纯可读摘要', async () => {
    const t = setup({ response: sse({ type: 'error', message: 'nope' }) });
    const result = (await t.run()) as { compaction: Record<string, unknown> };
    expect(result.compaction.summary).toBe('readable');
    expect(result.compaction.details).toBeUndefined();
  });

  it('smart 取消或让位时不附加 checkpoint', async () => {
    expect(await setup({ smartResult: { cancel: true } }).run()).toEqual({ cancel: true });
  });
});

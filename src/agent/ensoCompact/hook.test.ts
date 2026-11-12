import { describe, expect, it } from 'vitest';
import { sendBudget } from './budget';
import { takeCompactCancel } from './cancel';
import { createEnsoCompactFactory } from './extension';

type Hook = (event: unknown, ctx: unknown) => unknown;
type Result = { compaction?: { summary?: string; tokensBefore?: number } } | undefined;
const answer = (text: string) => ({ content: [{ type: 'text', text }] });
const promptText = (request: unknown) =>
  ((request as { messages?: Array<{ content?: unknown }> }).messages ?? [])
    .flatMap((m) =>
      Array.isArray(m.content)
        ? m.content
            .filter((b: { type?: string }) => b.type === 'text')
            .map((b: { text?: string }) => b.text ?? '')
        : [String(m.content ?? '')]
    )
    .join('\n');
const hookFor = (options: unknown) => {
  let handler: Hook | undefined;
  createEnsoCompactFactory(options as never)({
    on(name: string, fn: (...args: never[]) => unknown) {
      if (name === 'session_before_compact') handler = fn as Hook;
    },
  } as never);
  return () => handler;
};
const bigMessages = () =>
  Array.from({ length: 30 }, (_, i) => [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'z'.repeat(3000) },
        { type: 'toolCall', id: `r${i}`, name: 'read', arguments: { path: `${i}.ts` } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: `r${i}`,
      toolName: 'read',
      content: [{ type: 'text', text: 'ok' }],
    },
  ]).flat();
const isChunk = (prompt: string) => /CHUNK \d+\/\d+/.test(prompt) && !prompt.includes('IMMUTABLE');
async function run(
  messages: unknown[],
  respond: (prompt: string) => unknown,
  previousSummary?: string,
  signal = new AbortController().signal
) {
  const handler = hookFor({ mode: 'fast', summaryModel: { provider: 'enso-test', id: 'cheap' } })();
  const branch = Array.from({ length: 3 }, (_, i) => ({
    type: 'message',
    message: { role: 'user', content: `dummy-${i}` },
  }));
  const prompts: string[] = [];
  const result = await handler?.(
    {
      reason: 'manual',
      branchEntries: branch,
      preparation: {
        tokensBefore: 1000,
        firstKeptEntryId: 'keep',
        messagesToSummarize: messages,
        previousSummary,
      },
      signal,
    },
    {
      sessionManager: { getBranch: () => branch },
      model: { id: 'session' },
      modelRegistry: {
        find: () => ({ id: 'cheap', provider: 'enso-test' }),
        complete: async (_model: unknown, request: unknown) => {
          const prompt = promptText(request);
          prompts.push(prompt);
          return respond(prompt);
        },
      },
    }
  );
  return { prompts, result: result as Result };
}

describe('enso compact hook', () => {
  it('过短会话让出原生', async () => {
    const handler = hookFor({ mode: 'balanced' })();
    const result = await handler?.(
      {
        reason: 'manual',
        branchEntries: [{ type: 'message', message: { role: 'user', content: 'hi' } }],
        preparation: { tokensBefore: 100, firstKeptEntryId: 'keep' },
        signal: new AbortController().signal,
      },
      {
        sessionManager: { getBranch: () => [] },
        modelRegistry: { find: () => undefined, complete: async () => ({}) },
      }
    );
    expect(result).toBeUndefined();
  });
  it('手动 compact 不因占用低而让出，并交 fromHook 摘要', async () => {
    const handler = hookFor({
      mode: 'fast',
      summaryModel: { provider: 'enso-test', id: 'cheap' },
    })();
    const branch = [
      {
        type: 'message',
        message: { role: 'user', content: 'MUST keep dark mode. Goal: ship checkout.' },
      },
      { type: 'message', message: { role: 'assistant', content: 'Error: boom' } },
      { type: 'message', message: { role: 'user', content: 'fix src/app.ts' } },
    ];
    const result = (await handler?.(
      {
        reason: 'manual',
        branchEntries: branch,
        preparation: { tokensBefore: 800, firstKeptEntryId: 'keep-1' },
        signal: new AbortController().signal,
      },
      {
        sessionManager: { getBranch: () => branch },
        model: { id: 'session' },
        modelRegistry: {
          find: () => ({ id: 'cheap', provider: 'enso-test' }),
          complete: async () => answer('# Progress\n- started'),
        },
      }
    )) as Result;
    expect(result?.compaction?.tokensBefore).toBe(800);
    expect(result?.compaction?.summary).toMatch(/Goal/);
    expect(result?.compaction?.summary).toMatch(/dark mode/);
  });
  it('使用顶层消息全量正文和上次摘要', async () => {
    const messages = [
      { role: 'user', content: 'Goal: fix compaction' },
      { role: 'assistant', content: [{ type: 'text', text: 'checked serialize' }] },
      { role: 'user', content: 'LAST-USER-LINE' },
    ];
    const { prompts, result } = await run(
      messages,
      () => answer('## Goal\nfix\n## Progress\n### Done\n- [x] a'),
      'PREV-SUMMARY-TEXT'
    );
    expect(prompts).toHaveLength(1);
    for (const text of ['LAST-USER-LINE', 'checked serialize', 'PREV-SUMMARY-TEXT'])
      expect(prompts[0]).toContain(text);
    expect(result?.compaction?.summary).toContain('## Progress');
  });
  it('超出单趟预算时分块后组装', async () => {
    const { prompts, result } = await run(bigMessages(), (prompt) =>
      answer(
        isChunk(prompt) ? '### CHUNK ok' : '## Goal\nassembled\n## Progress\n### Done\n- [x] a'
      )
    );
    const chunks = prompts.filter(isChunk).length;
    expect(prompts.length).toBe(chunks + 1);
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    expect(result?.compaction?.summary).toContain('assembled');
  });
  it('首个分块失败仍返回摘要', async () => {
    let failed = false;
    const { result } = await run(bigMessages(), (prompt) => {
      if (isChunk(prompt) && !failed) {
        failed = true;
        throw new Error('chunk failed');
      }
      return answer(isChunk(prompt) ? '### CHUNK ok' : '## Goal\nassembled\n## Progress');
    });
    expect(failed).toBe(true);
    expect(result).toBeDefined();
    expect(result?.compaction?.summary).toContain('## Goal');
  });
  it('组装失败时返回确定性摘要', async () => {
    const { result } = await run(bigMessages(), (prompt) => {
      if (!isChunk(prompt)) throw new Error('assemble failed');
      return answer('### CHUNK ok');
    });
    expect(result?.compaction?.summary).toContain('## Goal');
    expect(result?.compaction?.summary).toContain('## Progress');
  });
  it('显式空压缩区不回退到分支', async () => {
    const { prompts, result } = await run([], () => answer('unexpected'));
    expect(prompts).toHaveLength(0);
    expect(result).toBeUndefined();
  });
  it('异常消息形状不会抛错', async () => {
    const messages = [
      { role: 'assistant' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'read' }] },
      { role: 'user', content: 'Goal: odd shapes' },
    ];
    const { result } = await run(messages, () => answer('## Goal\nodd\n## Progress'));
    expect(result).toBeDefined();
    expect(result?.compaction?.summary).toContain('Goal');
  });
  it('已取消时不返回兜底摘要', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await run(
      [{ role: 'user', content: 'Goal: stop' }],
      () => {
        throw new Error('aborted');
      },
      undefined,
      controller.signal
    );
    expect(result).toBeUndefined();
  });
  it('单趟模型空输出时返回确定性摘要', async () => {
    const { result } = await run([{ role: 'user', content: 'Goal: empty output' }], () =>
      answer('')
    );
    expect(result).toBeDefined();
    expect(result?.compaction?.summary).toContain('## Goal');
  });
  it('overflow 图片超预算时推进切点并记录移出内容', async () => {
    const contextWindow = 19_384;
    const branch = [
      {
        id: 'call',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'img', name: 'read', arguments: { path: 'shot.jpg' } }],
        },
      },
      {
        id: 'result',
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'img',
          toolName: 'read',
          content: [{ type: 'image', data: 'x'.repeat((sendBudget(contextWindow) + 1) * 4) }],
        },
      },
      { id: 'later', type: 'message', message: { role: 'user', content: 'look' } },
    ];
    const prompts: string[] = [];
    const handler = hookFor({
      mode: 'fast',
      summaryModel: { provider: 'enso-test', id: 'cheap' },
    })();
    const result = (await handler?.(
      {
        reason: 'overflow',
        branchEntries: branch,
        preparation: {
          tokensBefore: 5_000,
          firstKeptEntryId: 'call',
          messagesToSummarize: [{ role: 'user', content: 'dummy' }],
        },
        signal: new AbortController().signal,
      },
      {
        sessionManager: { getBranch: () => branch },
        model: { id: 'session', contextWindow },
        modelRegistry: {
          find: () => ({ id: 'cheap', provider: 'enso-test' }),
          complete: async (_model: unknown, request: unknown) => {
            prompts.push(promptText(request));
            return answer('## Goal\nimage\n## Progress');
          },
        },
      }
    )) as { compaction?: { firstKeptEntryId?: string; summary?: string } };
    expect(result.compaction?.firstKeptEntryId).toBe('later');
    expect([result.compaction?.summary, ...prompts].join('\n')).toMatch(
      /## Evicted from context|shot\.jpg|read image/
    );
  });
  it('单趟 complete 抛 Input token limit exceeded 时仍返回 compaction', async () => {
    const messages = [{ role: 'user', content: 'Goal: ship checkout' }];
    const { result } = await run(messages, (prompt) => {
      if (isChunk(prompt)) return answer('### CHUNK ok');
      if (prompt.includes('IMMUTABLE'))
        return answer('## Goal\nship checkout\n## Progress\n### Done\n- [x] a');
      throw new Error('Input token limit exceeded');
    });
    expect(result).toBeDefined();
    expect(result?.compaction?.summary).toContain('## Goal');
  });
  it('单趟失败且分层也全挂时 assembleFallback 仍交 compaction', async () => {
    const messages = [{ role: 'user', content: 'Goal: ship checkout' }];
    const { result } = await run(messages, () => {
      throw new Error('Input token limit exceeded');
    });
    expect(result).toBeDefined();
    expect(result?.compaction?.summary).toContain('## Goal');
  });
  it('钩子失败但用户未取消时不得 return undefined', async () => {
    const messages = [{ role: 'user', content: 'Goal: ship checkout' }];
    const { result } = await run(
      messages,
      () => {
        throw new Error('Input token limit exceeded');
      },
      undefined,
      new AbortController().signal
    );
    expect(result).not.toBeUndefined();
    expect(result?.compaction?.summary).toContain('## Goal');
  });
  it('调用前已 abort 时仍可让出原生（保持现有语义）', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await run(
      [{ role: 'user', content: 'Goal: stop' }],
      () => {
        throw new Error('Input token limit exceeded');
      },
      undefined,
      controller.signal
    );
    expect(result).toBeUndefined();
  });
  it('摘要模型 contextWindow 很小时强制切块', async () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'user',
      content: `Goal: ship. Step ${i}: ${'x'.repeat(3000)}`,
    }));
    const prompts: string[] = [];
    const handler = hookFor({
      mode: 'fast',
      summaryModel: { provider: 'enso-test', id: 'cheap' },
    })();
    const result = (await handler?.(
      {
        reason: 'manual',
        branchEntries: Array.from({ length: 3 }, (_, i) => ({
          type: 'message',
          message: { role: 'user', content: `dummy-${i}` },
        })),
        preparation: {
          tokensBefore: 1000,
          firstKeptEntryId: 'keep',
          messagesToSummarize: messages,
        },
        signal: new AbortController().signal,
      },
      {
        sessionManager: { getBranch: () => [] },
        model: { id: 'session' },
        modelRegistry: {
          find: () => ({ id: 'cheap', provider: 'enso-test', contextWindow: 4000 }),
          complete: async (_model: unknown, request: unknown) => {
            const prompt = promptText(request);
            prompts.push(prompt);
            return answer(isChunk(prompt) ? '### CHUNK ok' : '## Goal\nassembled\n## Progress');
          },
        },
      }
    )) as Result;
    expect(prompts.some(isChunk)).toBe(true);
    expect(result?.compaction?.summary).toContain('## Goal');
  });
  it('overflow 的最小尾巴仍超预算时明确取消', async () => {
    const branch = [
      { id: 'old-1', type: 'message', message: { role: 'user', content: 'old' } },
      { id: 'old-2', type: 'message', message: { role: 'assistant', content: 'old' } },
      { id: 'last', type: 'message', message: { role: 'user', content: 'x'.repeat(100) } },
    ];
    const handler = hookFor({
      mode: 'fast',
      summaryModel: { provider: 'enso-test', id: 'cheap' },
    })();
    const sessionManager = { getBranch: () => branch };
    const result = await handler?.(
      {
        reason: 'overflow',
        branchEntries: branch,
        preparation: {
          tokensBefore: 5_000,
          firstKeptEntryId: 'last',
          messagesToSummarize: [{ role: 'user', content: 'dummy' }],
        },
        signal: new AbortController().signal,
      },
      {
        sessionManager,
        model: { id: 'session', contextWindow: 16_384 },
        modelRegistry: {
          find: () => ({ id: 'cheap', provider: 'enso-test' }),
          complete: async () => answer('## Goal\nno\n## Progress'),
        },
      }
    );
    expect(result).toEqual({ cancel: true });
    expect(takeCompactCancel(sessionManager)).toEqual({
      reason: 'uncompressible',
      budget: 0,
      estimatedAfter: 2073,
      tokensBefore: 5_000,
      contextWindow: 16_384,
    });
    expect(takeCompactCancel(sessionManager)).toBeUndefined();
  });
  it('同一会话连续两次阈值压缩都能完成，不因摘要变长判成无节省', async () => {
    const branch = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`,
      type: 'message',
      message: { role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(400) },
    }));
    const handler = hookFor({
      mode: 'fast',
      summaryModel: { provider: 'enso-test', id: 'cheap' },
    })();
    const sessionManager = { getBranch: () => branch };
    const ctx = {
      sessionManager,
      model: { id: 'session', contextWindow: 200_000 },
      modelRegistry: {
        find: () => ({ id: 'cheap', provider: 'enso-test' }),
        complete: async () => answer('## Goal\nship\n## Progress'),
      },
    };
    const compactOnce = (previousSummary?: string) =>
      handler?.(
        {
          reason: 'threshold',
          branchEntries: branch,
          preparation: {
            tokensBefore: 50_000,
            firstKeptEntryId: 'e6',
            messagesToSummarize: [{ role: 'user', content: 'old' }],
            previousSummary,
          },
          signal: new AbortController().signal,
        },
        ctx
      ) as Promise<Result>;
    expect((await compactOnce())?.compaction).toBeDefined();
    expect((await compactOnce('S'.repeat(4000)))?.compaction).toBeDefined();
    expect(takeCompactCancel(sessionManager)).toBeUndefined();
  });
});

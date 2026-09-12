import { describe, expect, it, vi } from 'vitest';
import { chunkObservationSources, createContinuousMemoryFactory } from './extension';
import { rawMessage } from './fixtures/session';
import type { Entry } from './session-ledger';

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
};

function harness(
  branch: Entry[],
  complete: (prompt: string, signal: AbortSignal) => Promise<unknown>
) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let sequence = 0;
  const manager = { getBranch: () => branch };
  const tools: Array<{ execute: (...args: any[]) => Promise<any> }> = [];
  createContinuousMemoryFactory()({
    on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
    registerTool: (tool: { execute: (...args: any[]) => Promise<any> }) => tools.push(tool),
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: 'custom', id: `ledger-${++sequence}`, customType, data });
    },
  } as never);
  const ctx = {
    sessionManager: manager,
    model: { id: 'observer', contextWindow: 6000 },
    modelRegistry: {
      find: () => undefined,
      complete: async (_model: unknown, request: any, options: { signal: AbortSignal }) => {
        const prompt = request.messages[0].content[0].text as string;
        return complete(prompt, options.signal);
      },
    },
  };
  return { handlers, ctx, manager, tools };
}

function completeCoverage(prompt: string) {
  const ids = [...prompt.matchAll(/\[([^\]]+)\]/g)]
    .map((match) => match[1])
    .filter((id) => id.startsWith('raw-'));
  return Promise.resolve({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          observations: ids.map((id) => ({ content: `fact ${id}`, sourceEntryIds: [id] })),
        }),
      },
    ],
  });
}

describe('continuous-memory runtime', () => {
  it('按模型窗口 oldest-first 分块，成功后逐块推进 coverage', async () => {
    const branch = Array.from({ length: 3 }, (_, index) =>
      rawMessage(`raw-${index}`, `${index}${'x'.repeat(15_000)}`)
    ) as Entry[];
    const prompts: string[] = [];
    const h = harness(branch, async (prompt) => {
      prompts.push(prompt);
      return completeCoverage(prompt);
    });
    h.handlers.get('turn_end')?.({}, h.ctx);
    await tick();
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => prompt.length < 7000)).toBe(true);
    const ledger = branch.filter((entry) => entry.customType === 'om.observations.recorded');
    expect(ledger).toHaveLength(3);
    expect((ledger.at(-1)?.data as { coversUpToId?: string } | undefined)?.coversUpToId).toBe(
      'raw-2'
    );
  });

  it('模型空内容时用确定性证据推进 coverage', async () => {
    const branch = [rawMessage('raw-1', 'x'.repeat(50_000))] as Entry[];
    const complete = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const h = harness(branch, complete);
    h.handlers.get('turn_end')?.({}, h.ctx);
    await tick();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(branch.some((entry) => entry.customType === 'om.observations.recorded')).toBe(true);
  });

  it('release abort 后不晚写；新 session controller 仍可正常追加', async () => {
    const branch = [rawMessage('raw-1', 'x'.repeat(50_000))] as Entry[];
    let resolve!: (value: unknown) => void;
    const h = harness(
      branch,
      (_prompt, signal) =>
        new Promise((done) => {
          resolve = done;
          signal.addEventListener('abort', () => done({ content: [] }), { once: true });
        })
    );
    h.handlers.get('turn_end')?.({}, h.ctx);
    h.handlers.get('session_shutdown')?.({}, h.ctx);
    resolve(await completeCoverage('[raw-1]'));
    await tick();
    expect(branch.some((entry) => entry.customType === 'om.observations.recorded')).toBe(false);

    const next = [rawMessage('raw-2', 'y'.repeat(50_000))] as Entry[];
    const nextHarness = harness(next, completeCoverage);
    nextHarness.handlers.get('turn_end')?.({}, nextHarness.ctx);
    await tick();
    expect(next.some((entry) => entry.customType === 'om.observations.recorded')).toBe(true);
  });

  it('达到阈值会写 reflection，并把超预算 observations 压实为常数大小边界', async () => {
    const observations = Array.from({ length: 20 }, (_, index) => ({
      id: index.toString(16).padStart(12, '0'),
      content: `old-${index}`,
      timestamp: '2026-01-01 00:00',
      relevance: 'medium' as const,
      sourceEntryIds: [`old-${index}`],
      tokenCount: 1500,
    }));
    const branch = [
      ...observations.map((_, index) => rawMessage(`old-${index}`, 'old')),
      {
        type: 'custom',
        id: 'old-ledger',
        customType: 'om.observations.recorded',
        data: { observations, coversUpToId: 'old-19' },
      },
      rawMessage('raw-new', 'x'.repeat(50_000)),
    ] as Entry[];
    const h = harness(branch, async (prompt) => {
      if (prompt.includes('"reflections"')) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                reflections: [
                  { content: 'stable rule', supportingObservationIds: [observations[0].id] },
                ],
              }),
            },
          ],
        };
      }
      return completeCoverage(prompt);
    });
    h.handlers.get('turn_end')?.({}, h.ctx);
    await tick();
    expect(branch.some((entry) => entry.customType === 'om.reflections.recorded')).toBe(true);
    expect(branch.some((entry) => entry.customType === 'om.observations.dropped')).toBe(true);
    const records = branch.filter((entry) => entry.customType === 'om.observations.recorded');
    const compacted = (
      records.at(-1)?.data as
        | { observations?: Array<{ sourceEntryIds: string[]; tokenCount: number }> }
        | undefined
    )?.observations?.[0];
    expect(compacted?.sourceEntryIds).toHaveLength(1);
    expect(compacted?.tokenCount).toBe(24);
  });

  it('observer 失败后退避，退避期内不重试，到期后恢复', async () => {
    const branch = [rawMessage('raw-1', 'x'.repeat(50_000))] as Entry[];
    let fail = true;
    const complete = vi.fn(async (prompt: string) => {
      if (fail) throw new Error('observer down');
      return completeCoverage(prompt);
    });
    const h = harness(branch, complete);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      h.handlers.get('turn_end')?.({}, h.ctx);
      await tick();
      expect(complete).toHaveBeenCalledTimes(1);
      fail = false;
      h.handlers.get('turn_end')?.({}, h.ctx);
      await tick();
      expect(complete).toHaveBeenCalledTimes(1);
      expect(branch.some((entry) => entry.customType === 'om.observations.recorded')).toBe(false);
      clock.mockReturnValue(now + 31_000);
      h.handlers.get('turn_end')?.({}, h.ctx);
      await tick();
      expect(complete).toHaveBeenCalledTimes(2);
      expect(branch.some((entry) => entry.customType === 'om.observations.recorded')).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('recall 工具冷启动仅凭 ledger 重建证据，未知 id 明确 not found', async () => {
    const branch = [rawMessage('raw-1', `the exact evidence ${'x'.repeat(50_000)}`)] as Entry[];
    const h = harness(branch, completeCoverage);
    h.handlers.get('turn_end')?.({}, h.ctx);
    await tick();
    const recorded = branch.find((entry) => entry.customType === 'om.observations.recorded');
    const id =
      (recorded?.data as { observations: Array<{ id: string }> } | undefined)?.observations[0].id ??
      '';
    const cold = harness([...branch], completeCoverage);
    const hit = await cold.tools[0].execute('call', { id }, undefined, undefined, cold.ctx);
    expect(hit.content[0].text).toContain('the exact evidence');
    expect(hit.details).toEqual({ memoryId: id, partial: false });
    const miss = await cold.tools[0].execute(
      'call',
      { id: '000000000000' },
      undefined,
      undefined,
      cold.ctx
    );
    expect(miss.details).toEqual({ memoryId: '000000000000', partial: false });
    expect(miss.content[0].text).toContain('carried memory boundary');
    const unknown = await cold.tools[0].execute(
      'call',
      { id: 'ffffffffffff' },
      undefined,
      undefined,
      cold.ctx
    );
    expect(unknown.content[0].text).toContain('No continuous memory');
  });

  it('provider 错误回复（stopReason=error）不落兜底观察，而是退避', async () => {
    const branch = [rawMessage('raw-1', 'x'.repeat(50_000))] as Entry[];
    const complete = vi.fn(async () => ({
      content: [],
      stopReason: 'error',
      errorMessage: 'usage limit reached',
    }));
    const h = harness(branch, complete);
    h.handlers.get('turn_end')?.({}, h.ctx);
    await tick();
    expect(branch.some((entry) => entry.customType === 'om.observations.recorded')).toBe(false);
    h.handlers.get('turn_end')?.({}, h.ctx);
    await tick();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('thinking 部分含花括号时仍能从 text 部分解析 JSON 观察', async () => {
    const branch = [rawMessage('raw-1', 'x'.repeat(50_000))] as Entry[];
    const h = harness(branch, async () => ({
      content: [
        { type: 'thinking', thinking: 'Plan: build {"observations": partial} then ```json' },
        {
          type: 'text',
          text: JSON.stringify({
            observations: [
              { content: 'parsed fact', relevance: 'high', sourceEntryIds: ['raw-1'] },
            ],
          }),
        },
      ],
    }));
    h.handlers.get('turn_end')?.({}, h.ctx);
    await tick();
    const recorded = branch.find((entry) => entry.customType === 'om.observations.recorded');
    const observations = (
      recorded?.data as { observations: Array<{ content: string }> } | undefined
    )?.observations;
    expect(observations?.map((item) => item.content)).toEqual(['parsed fact']);
  });

  it('超长单条被显式截断且不超过输入预算', () => {
    const chunks = chunkObservationSources(
      [rawMessage('raw-long', 'x'.repeat(100_000)) as Entry],
      512
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('[entry truncated]');
    expect(chunks[0].text.length).toBeLessThan(2200);
  });
});

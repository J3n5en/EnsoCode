import { describe, expect, it } from 'vitest';
import {
  compactionBoundaryStart,
  continuousMemoryProjection,
  createContinuousMemoryFactory,
} from './extension';
import { observation, observationsRecordedEntry, rawMessage } from './fixtures/session';
import type { Entry } from './session-ledger';

const asEntries = (items: unknown[]): Entry[] => items as Entry[];

type CompactResult = { compaction?: { summary: string; details: unknown } } | undefined;

const priorOf = (result: CompactResult) =>
  (result?.compaction?.details as { priorSummary?: string } | undefined)?.priorSummary;

function compactHook() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  createContinuousMemoryFactory()({
    on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
    registerTool: () => undefined,
    appendEntry: () => undefined,
  } as never);
  return (branch: Entry[], firstKeptEntryId: string, previousSummary?: string) =>
    handlers.get('session_before_compact')?.(
      {
        branchEntries: branch,
        signal: new AbortController().signal,
        preparation: { firstKeptEntryId, tokensBefore: 1000, previousSummary },
      },
      { sessionManager: { getBranch: () => branch } }
    ) as Promise<CompactResult>;
}

/** 模拟 Pi 把上一次 compaction 结果写回 branch，并追加一轮已观察的新消息。 */
function nextRound(branch: Entry[], round: number, result: CompactResult, keptId: string) {
  return asEntries([
    ...branch,
    {
      type: 'compaction',
      id: `compact-${round}`,
      firstKeptEntryId: keptId,
      summary: result?.compaction?.summary,
      details: result?.compaction?.details,
    },
    rawMessage(`raw-${round}`, `round ${round}`),
    observationsRecordedEntry(`ledger-${round}`, {
      observations: [
        observation(`${round}`.repeat(12), {
          sourceEntryIds: [keptId, `raw-${round}`],
          content: `fact ${round}`,
        }),
      ],
      coversUpToId: `raw-${round}`,
    }),
    rawMessage(`keep-${round}`, 'tail'),
  ]);
}

describe('continuous memory compaction safety', () => {
  it('boundaryStart 与 Pi 的三种分支一致', () => {
    expect(compactionBoundaryStart(asEntries([rawMessage('a', 'a')]))).toBe(0);
    expect(
      compactionBoundaryStart(
        asEntries([
          rawMessage('a', 'a'),
          { type: 'compaction', id: 'c', firstKeptEntryId: 'a' },
          rawMessage('b', 'b'),
        ])
      )
    ).toBe(0);
    expect(
      compactionBoundaryStart(
        asEntries([
          rawMessage('a', 'a'),
          { type: 'compaction', id: 'c', firstKeptEntryId: 'missing' },
          rawMessage('b', 'b'),
        ])
      )
    ).toBe(2);
  });
  it('未观察的待驱逐消息存在时拒绝 memory 投影', () => {
    const branch = asEntries([
      rawMessage('raw-1', 'one'),
      rawMessage('raw-2', 'two'),
      observationsRecordedEntry('ledger-1', {
        observations: [observation('aaaaaaaaaaaa', { sourceEntryIds: ['raw-1'] })],
        coversUpToId: 'raw-2',
      }),
      rawMessage('keep', 'tail'),
    ]);
    expect(continuousMemoryProjection(branch, 'keep')).toBeUndefined();
  });

  it('所有待驱逐消息都有来源证据时生成 branch-local 投影', () => {
    const branch = asEntries([
      rawMessage('raw-1', 'one'),
      rawMessage('raw-2', 'two'),
      observationsRecordedEntry('ledger-1', {
        observations: [observation('aaaaaaaaaaaa', { sourceEntryIds: ['raw-1', 'raw-2'] })],
        coversUpToId: 'raw-2',
      }),
      rawMessage('keep', 'tail'),
    ]);
    expect(continuousMemoryProjection(branch, 'keep')?.observations).toHaveLength(1);
  });

  it('memory→memory 合并上次 details 与本轮 ledger，旧内容仍可 recall', () => {
    const old = observation('aaaaaaaaaaaa', { sourceEntryIds: ['raw-old'], content: 'old fact' });
    const recent = observation('bbbbbbbbbbbb', {
      sourceEntryIds: ['raw-new'],
      content: 'new fact',
    });
    const branch = asEntries([
      rawMessage('raw-old', 'old'),
      {
        type: 'compaction',
        id: 'compact-1',
        firstKeptEntryId: 'raw-new',
        details: {
          type: 'om.folded',
          version: 1,
          fullFold: false,
          observations: [old],
          reflections: [],
        },
      },
      rawMessage('raw-new', 'new'),
      observationsRecordedEntry('ledger-new', { observations: [recent], coversUpToId: 'raw-new' }),
      rawMessage('keep', 'tail'),
    ]);
    const projection = continuousMemoryProjection(branch, 'keep');
    expect(projection?.observations.map((item) => item.content)).toEqual(['old fact', 'new fact']);
  });

  it('smart→memory 首次压缩保留 previousSummary', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    createContinuousMemoryFactory()({
      on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      registerTool: () => undefined,
      appendEntry: () => undefined,
    } as never);
    const branch = asEntries([
      rawMessage('raw-1', 'one'),
      observationsRecordedEntry('ledger-1', {
        observations: [observation('aaaaaaaaaaaa', { sourceEntryIds: ['raw-1'] })],
        coversUpToId: 'raw-1',
      }),
      rawMessage('keep', 'tail'),
    ]);
    const result = (await handlers.get('session_before_compact')?.(
      {
        branchEntries: branch,
        signal: new AbortController().signal,
        preparation: {
          firstKeptEntryId: 'keep',
          tokensBefore: 1000,
          previousSummary: 'SMART OLD HISTORY',
        },
      },
      { sessionManager: { getBranch: () => branch } }
    )) as { compaction?: { summary?: string } };
    expect(result.compaction?.summary).toContain('SMART OLD HISTORY');
    expect(result.compaction?.summary).toContain('aaaaaaaaaaaa');
  });

  it('smart→memory→memory→memory 链路前向携带 smart 期前史且不重复拼接', async () => {
    const compact = compactHook();
    let branch = asEntries([
      { type: 'compaction', id: 'compact-smart', firstKeptEntryId: 'keep-0', summary: 'SMART' },
      rawMessage('keep-0', 'zero'),
      observationsRecordedEntry('ledger-0', {
        observations: [observation('aaaaaaaaaaaa', { sourceEntryIds: ['keep-0'] })],
        coversUpToId: 'keep-0',
      }),
      rawMessage('keep-1', 'tail'),
    ]);
    let result = await compact(branch, 'keep-1', 'SMART OLD HISTORY');
    const summaries = [result?.compaction?.summary ?? ''];
    for (let round = 2; round <= 4; round++) {
      branch = nextRound(branch, round, result, `keep-${round - 1}`);
      result = await compact(branch, `keep-${round}`, summaries.at(-1));
      summaries.push(result?.compaction?.summary ?? '');
    }
    for (const summary of summaries) {
      expect(summary.split('SMART OLD HISTORY')).toHaveLength(2);
      expect(summary).toContain('aaaaaaaaaaaa');
      expect(summary.indexOf('SMART OLD HISTORY')).toBeLessThan(summary.indexOf('## Observations'));
    }
    expect(summaries.at(-1)).toContain('fact 2');
    expect(summaries.at(-1)).toContain('fact 4');
    const priorLengths = summaries.map((summary) => summary.indexOf('These are condensed'));
    expect(new Set(priorLengths).size).toBe(1);
    expect(priorOf(result)).toBe('SMART OLD HISTORY');
  });

  it('previousSummary 超预算时截断为常数大小并标记', async () => {
    const branch = asEntries([
      rawMessage('raw-1', 'one'),
      observationsRecordedEntry('ledger-1', {
        observations: [observation('aaaaaaaaaaaa', { sourceEntryIds: ['raw-1'] })],
        coversUpToId: 'raw-1',
      }),
      rawMessage('keep', 'tail'),
    ]);
    const result = await compactHook()(branch, 'keep', 'H'.repeat(40_000));
    const prior = priorOf(result) ?? '';
    expect(prior.length).toBeLessThanOrEqual(16_000);
    expect(prior.endsWith('[prior history truncated]')).toBe(true);
    expect(result?.compaction?.summary).toContain('[prior history truncated]');
  });

  it('memory→smart→memory 反向切换时以 smart 摘要为前史', async () => {
    const branch = asEntries([
      {
        type: 'compaction',
        id: 'compact-memory',
        firstKeptEntryId: 'raw-1',
        details: {
          type: 'om.folded',
          version: 1,
          fullFold: false,
          observations: [],
          reflections: [],
          priorSummary: 'ANCIENT',
        },
      },
      rawMessage('raw-1', 'one'),
      { type: 'compaction', id: 'compact-smart', firstKeptEntryId: 'raw-2', summary: 'SMART' },
      rawMessage('raw-2', 'two'),
      observationsRecordedEntry('ledger-1', {
        observations: [observation('aaaaaaaaaaaa', { sourceEntryIds: ['raw-2'] })],
        coversUpToId: 'raw-2',
      }),
      rawMessage('keep', 'tail'),
    ]);
    const result = await compactHook()(branch, 'keep', 'SMART SUMMARY WITH ANCIENT');
    expect(result?.compaction?.summary).toContain('SMART SUMMARY WITH ANCIENT');
    expect(priorOf(result)).toBe('SMART SUMMARY WITH ANCIENT');
  });

  it('连续多轮超限压缩仍走 memory 路径且 summary 收敛在上限内', async () => {
    const compact = compactHook();
    let branch = asEntries([rawMessage('keep-0', 'zero')]);
    let result: CompactResult;
    for (let round = 1; round <= 3; round++) {
      const raws = Array.from({ length: 25 }, (_, index) =>
        rawMessage(`raw-${round}-${index}`, 'source')
      );
      branch = asEntries([
        ...branch,
        ...(round > 1
          ? [
              {
                type: 'compaction',
                id: `compact-${round}`,
                firstKeptEntryId: `keep-${round - 1}`,
                details: result?.compaction?.details,
              },
            ]
          : []),
        ...raws,
        observationsRecordedEntry(`ledger-${round}`, {
          observations: raws.map((raw, index) =>
            observation(`${round}${index.toString(16)}`.padStart(12, '0'), {
              content: `fact-${round}-${index}-${'x'.repeat(4000)}`,
              sourceEntryIds: index === 0 ? [`keep-${round - 1}`, raw.id] : [raw.id],
              tokenCount: 1001,
            })
          ),
          coversUpToId: raws.at(-1)?.id ?? '',
        }),
        rawMessage(`keep-${round}`, 'tail'),
      ]);
      result = await compact(branch, `keep-${round}`, result?.compaction?.summary);
      expect(result?.compaction).toBeDefined();
      expect(Math.ceil((result?.compaction?.summary.length ?? 0) / 4)).toBeLessThanOrEqual(24_000);
    }
    expect(result?.compaction?.summary).toContain('[carried boundary]');
    expect(result?.compaction?.summary).not.toContain('000000000000');
  });

  it('split-turn：切点前的 turn prefix 条目同样计入覆盖分母', () => {
    const branch = asEntries([
      rawMessage('raw-1', 'user turn start'),
      observationsRecordedEntry('ledger-1', {
        observations: [observation('aaaaaaaaaaaa', { sourceEntryIds: ['raw-1'] })],
        coversUpToId: 'raw-1',
      }),
      rawMessage('prefix', 'assistant prefix inside split turn', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'prefix' }] },
      }),
      rawMessage('keep', 'tool result cut point'),
    ]);
    expect(continuousMemoryProjection(branch, 'keep')).toBeUndefined();
    const covered = asEntries([
      ...branch.slice(0, 3),
      observationsRecordedEntry('ledger-2', {
        observations: [observation('bbbbbbbbbbbb', { sourceEntryIds: ['prefix'] })],
        coversUpToId: 'prefix',
      }),
      branch[3],
    ]);
    expect(continuousMemoryProjection(covered, 'keep')?.observations).toHaveLength(2);
  });

  it('失败象限：覆盖不全走 Enso fallback 且 memory 摘要不丢；用户 abort 让位；内部异常自 catch', async () => {
    const compact = compactHook();
    const uncovered = asEntries([
      rawMessage('raw-1', 'one'),
      rawMessage('raw-2', 'two'),
      rawMessage('keep', 'tail'),
    ]);
    const ctx = {
      sessionManager: { getBranch: () => uncovered },
      model: { id: 'm', contextWindow: 200_000 },
      modelRegistry: { find: () => undefined, complete: async () => ({ content: [] }) },
    };
    const handlers = new Map<string, (...args: any[]) => unknown>();
    createContinuousMemoryFactory()({
      on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      registerTool: () => undefined,
      appendEntry: () => undefined,
    } as never);
    const hook = handlers.get('session_before_compact');
    const messages = uncovered.slice(0, 2).map((entry) => entry.message);
    const fallback = (await hook?.(
      {
        branchEntries: uncovered,
        signal: new AbortController().signal,
        reason: 'overflow',
        preparation: {
          firstKeptEntryId: 'keep',
          tokensBefore: 100_000,
          previousSummary: 'MEMORY SUMMARY FROM CONTINUOUS PATH',
          messagesToSummarize: messages,
          turnPrefixMessages: [],
          isSplitTurn: false,
        },
      },
      ctx
    )) as CompactResult;
    expect(fallback?.compaction?.summary).toContain('MEMORY SUMMARY FROM CONTINUOUS PATH');
    expect(fallback?.compaction?.details).toBeUndefined();

    const aborted = new AbortController();
    aborted.abort();
    expect(
      await hook?.(
        {
          branchEntries: uncovered,
          signal: aborted.signal,
          preparation: { firstKeptEntryId: 'keep' },
        },
        ctx
      )
    ).toBeUndefined();

    const crashed = await compact(null as unknown as Entry[], 'keep', 'x');
    expect(crashed?.compaction).toBeUndefined();
  });

  it('从未 compaction 的超限 ledger 可收敛并连续走 memory', () => {
    const raws = Array.from({ length: 30 }, (_, index) => rawMessage(`raw-${index}`, 'source'));
    const observations = raws.map((entry, index) =>
      observation(index.toString(16).padStart(12, '0'), {
        content: `fact-${index}-${'x'.repeat(4000)}`,
        sourceEntryIds: [entry.id],
        tokenCount: 1001,
      })
    );
    const first = asEntries([
      ...raws,
      observationsRecordedEntry('ledger-all', { observations, coversUpToId: 'raw-29' }),
      rawMessage('keep-1', 'tail'),
    ]);
    const projection = continuousMemoryProjection(first, 'keep-1');
    expect(projection).toBeDefined();
    expect(projection?.details.coveredThroughEntryId).toBe('raw-10');
    expect(
      projection?.observations.reduce((sum, item) => sum + item.tokenCount, 0)
    ).toBeLessThanOrEqual(20_000);

    const second = asEntries([
      ...first,
      {
        type: 'compaction',
        id: 'compact-1',
        firstKeptEntryId: 'keep-1',
        details: projection?.details,
      },
      rawMessage('raw-next', 'next'),
      observationsRecordedEntry('ledger-next', {
        observations: [
          observation('dddddddddddd', { sourceEntryIds: ['keep-1'] }),
          observation('eeeeeeeeeeee', { sourceEntryIds: ['raw-next'] }),
        ],
        coversUpToId: 'raw-next',
      }),
      rawMessage('keep-2', 'tail'),
    ]);
    expect(continuousMemoryProjection(second, 'keep-2')).toBeDefined();
  });

  it('rewind 后切点 id 不在当前 branch 时拒绝旧投影', () => {
    const oldBranch = asEntries([
      rawMessage('raw-1', 'one'),
      observationsRecordedEntry('ledger-1', {
        observations: [observation('aaaaaaaaaaaa', { sourceEntryIds: ['raw-1'] })],
        coversUpToId: 'raw-1',
      }),
    ]);
    expect(continuousMemoryProjection(oldBranch, 'old-keep')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { type RunResult, RunTranscript, renderResult } from './output';
import { usageSummaryRecord } from './usageLog';

const result = (partial: Partial<RunResult> = {}): RunResult => ({
  status: 'success',
  exitCode: 0,
  exitReason: 'finished',
  sessionId: 's',
  finalMessage: 'hello',
  turns: 1,
  durationMs: 5,
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: null },
  ...partial,
});

describe('run transcript', () => {
  it('emits text deltas, one tool call per change, and usage when the step settles', () => {
    const now = () => Date.parse('2026-01-01T00:00:00Z');
    const transcript = new RunTranscript(
      'enso-run',
      { 'stub-model': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      now
    );
    const first = transcript.ingest(
      'm0',
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'he' }],
        model: 'stub-model',
      },
      true
    );
    const second = transcript.ingest(
      'm0',
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
        ],
        stopReason: 'toolUse',
        usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 1 },
        model: 'stub-model',
      },
      true
    );
    expect(first).toEqual([{ type: 'assistant.delta', text: 'he' }]);
    expect(second.map((record) => record.type)).toEqual(['assistant.delta', 'tool.call']);
    expect(second[1]).toMatchObject({ id: 'c1', name: 'bash' });
    expect(transcript.flushTurn().map((record) => record.type)).toEqual(['usage']);
    expect(transcript.calls[0]).toMatchObject({
      provider: 'enso-run',
      model: 'stub-model',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      costUsd: (10 * 1 + 4 * 2) / 1_000_000,
    });
    const again = transcript.ingest(
      'm0',
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
        ],
        stopReason: 'toolUse',
        usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 1 },
        model: 'stub-model',
      },
      true
    );
    expect(again).toEqual([]);
    expect(transcript.finalText).toBe('hello');
  });

  it('flushes usage that never received a stop reason and renders text or json', () => {
    const transcript = new RunTranscript('p', {});
    transcript.ingest(
      'm1',
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        model: 'm',
      },
      true
    );
    expect(transcript.flushTurn()).toEqual([
      expect.objectContaining({ type: 'usage', costUsd: null, outputTokens: 1 }),
    ]);
    expect(transcript.flushTurn()).toEqual([]);
    expect(renderResult(result(), 'text')).toBe('hello\n');
    expect(renderResult(result({ finalMessage: '' }), 'text')).toBe('');
    expect(JSON.parse(renderResult(result(), 'json'))).toMatchObject({
      sessionId: 's',
      finalMessage: 'hello',
    });
  });

  it('logs a call once the next message shows it ended, even when an index is reused', () => {
    const transcript = new RunTranscript('p', {});
    const assistant = (index: number, timestamp: number, output: number) =>
      transcript.ingest(
        `parent:${index}`,
        {
          role: 'assistant',
          content: [{ type: 'text', text: `step ${timestamp}` }],
          stopReason: 'stop',
          usage: { input: 1, output, cacheRead: 0, cacheWrite: 0 },
          model: 'm',
          timestamp,
        },
        true
      );
    const types = (records: Record<string, unknown>[]) => records.map((record) => record.type);
    // 流式中途也带 stopReason 和零用量，不能当成定稿
    expect(types(assistant(3, 1, 0))).not.toContain('usage');
    expect(types(assistant(3, 1, 2))).not.toContain('usage');
    const result = transcript.ingest('parent:4', { role: 'toolResult', content: [] }, true);
    expect(types(result)).toContain('usage');
    expect(types(assistant(3, 1, 2))).not.toContain('usage');
    // 压缩或重试后同一下标换了一条新消息，仍是一次独立调用
    expect(types(assistant(3, 2, 5))).not.toContain('usage');
    expect(types(transcript.flushTurn())).toEqual(['usage']);
    expect(transcript.calls.map((call) => call.outputTokens)).toEqual([2, 5]);
  });

  it('reports null cost when any call has no known price', () => {
    const transcript = new RunTranscript('p', {
      priced: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    for (const [model, timestamp] of [
      ['priced', 1],
      ['unpriced', 2],
    ] as const) {
      transcript.ingest(
        `parent:${timestamp}`,
        {
          role: 'assistant',
          content: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          model,
          timestamp,
        },
        true
      );
    }
    transcript.flushTurn();
    expect(transcript.calls).toHaveLength(2);
    expect(transcript.usage().costUsd).toBeNull();
    expect(usageSummaryRecord(transcript.calls, 'now').costUsd).toBeNull();
  });

  it('summarizes calls and leaves cost null until every priced call is known', () => {
    const summary = usageSummaryRecord(
      [
        {
          timestamp: 't',
          provider: 'p',
          model: 'm',
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 5,
          costUsd: null,
        },
      ],
      'later'
    );
    expect(summary).toMatchObject({
      type: 'summary',
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      costUsd: null,
      calls: 1,
    });
  });
});

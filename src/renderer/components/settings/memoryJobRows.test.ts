import type { DistillJobDto, KgJobDto, MemoryJobsSnapshot } from '@shared/memory/dto';
import { describe, expect, it } from 'vitest';
import { toJobRows } from './memoryJobRows';

function distill(over: Partial<DistillJobDto> = {}): DistillJobDto {
  return {
    id: 1,
    sessionId: 'abcdef123456',
    sessionTitle: null,
    projectId: null,
    status: 'done',
    attempts: 1,
    total: 2,
    done: 2,
    failed: 0,
    error: null,
    notes: [],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...over,
  };
}

function kg(over: Partial<KgJobDto> = {}): KgJobDto {
  return {
    id: 2,
    memoryId: 'mem12345678',
    memoryTitle: null,
    status: 'done',
    attempts: 1,
    total: 4,
    done: 3,
    error: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    failed: 0,
    ...over,
  };
}

const snapshot = (over: Partial<MemoryJobsSnapshot> = {}): MemoryJobsSnapshot => ({
  distill: [],
  kg: [],
  reembed: null,
  kgFailed: 0,
  ...over,
});

describe('toJobRows', () => {
  it('shows what each job produced, not just a count', () => {
    const rows = toJobRows(
      snapshot({
        distill: [distill({ sessionTitle: 'Fix retry loop', done: 2 })],
        kg: [kg({ memoryTitle: 'Use Postgres', total: 4, done: 3 })],
      })
    );
    expect(rows.find((r) => r.kind === 'distill')?.target).toBe('Fix retry loop');
    expect(rows.find((r) => r.kind === 'distill')?.detail).toBe('2 stored');
    expect(rows.find((r) => r.kind === 'kg')?.detail).toBe('4 entities · 3 links');
  });

  it('shows the error of a failed entity extraction', () => {
    const rows = toJobRows(
      snapshot({
        kg: [
          kg({
            status: 'done',
            failed: 1,
            error: 'kg extraction failed: model output is not parseable JSON',
          }),
        ],
      })
    );
    expect(rows[0]).toMatchObject({
      kind: 'kg',
      state: 'failed',
      detail: 'kg extraction failed: model output is not parseable JSON',
    });
  });

  it('falls back to a short id when the title is gone', () => {
    const rows = toJobRows(snapshot({ distill: [distill({ sessionTitle: null })] }));
    expect(rows[0].target).toBe('abcdef12');
  });

  it('surfaces per-memory discard reasons instead of hiding them', () => {
    // notes 是「为什么没写入」的结构化原因，之前完全没展示
    const rows = toJobRows(
      snapshot({
        distill: [
          distill({
            done: 0,
            notes: [
              { kind: 'low_importance', title: 'Some chatter', detail: '' },
              { kind: 'candidates_found', title: 'Postgres again', detail: '' },
            ],
          }),
        ],
      })
    );
    expect(rows[0].notes).toEqual([
      'Some chatter — importance too low',
      'Postgres again — similar memory already exists',
    ]);
  });

  it('separates failure from cancellation', () => {
    const rows = toJobRows(
      snapshot({
        distill: [
          distill({ id: 1, status: 'done', error: 'provider down' }),
          distill({ id: 2, status: 'cancelled', error: 'transcript changed' }),
        ],
      })
    );
    const failed = rows.find((r) => r.key === 'distill:1');
    const cancelled = rows.find((r) => r.key === 'distill:2');
    expect(failed?.state).toBe('failed');
    expect(failed?.detail).toBe('provider down');
    // 作废不是失败：不该标红，也不该把内部错误文案抛给用户
    expect(cancelled?.state).toBe('cancelled');
    expect(cancelled?.detail).toBe('superseded');
  });

  it('puts running jobs first, then failures, then the rest by recency', () => {
    const rows = toJobRows(
      snapshot({
        distill: [
          distill({ id: 1, status: 'done', updatedAt: '2025-01-01T00:00:00.000Z' }),
          distill({ id: 2, status: 'done', error: 'boom' }),
          distill({ id: 3, status: 'running' }),
          distill({ id: 4, status: 'done', updatedAt: '2025-06-01T00:00:00.000Z' }),
        ],
      })
    );
    expect(rows.map((r) => r.key)).toEqual(['distill:3', 'distill:2', 'distill:4', 'distill:1']);
  });

  it('reports retry attempts while a job is still pending', () => {
    const rows = toJobRows(snapshot({ distill: [distill({ status: 'pending', attempts: 3 })] }));
    expect(rows[0].detail).toBe('retry 3');
  });

  it('includes the re-embed job with progress and failure count', () => {
    const running = toJobRows(
      snapshot({
        reembed: {
          id: 9,
          target: 'local:qwen3-0.6b',
          status: 'running',
          cursor: 0,
          total: 10,
          done: 4,
          failed: 0,
          error: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      })
    );
    expect(running[0].detail).toBe('4/10');
    expect(running[0].target).toBe('local:qwen3-0.6b');
  });

  it('is empty when nothing ever ran', () => {
    expect(toJobRows(snapshot())).toEqual([]);
  });
});

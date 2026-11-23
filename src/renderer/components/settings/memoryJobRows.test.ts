import { translate } from '@shared/i18n';
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

  it('translates queued, running, retry, done, cancelled and failed job details into zh and en', () => {
    const zh = (key: string, params?: Record<string, string | number>) =>
      translate('zh', key, params);
    const en = (key: string, params?: Record<string, string | number>) =>
      translate('en', key, params);

    const data = snapshot({
      distill: [
        distill({ id: 1, status: 'pending', attempts: 0 }),
        distill({ id: 2, status: 'running', attempts: 1 }),
        distill({ id: 3, status: 'pending', attempts: 3 }),
        distill({
          id: 4,
          status: 'done',
          done: 2,
          notes: [{ kind: 'low_importance', title: 'Chatter', detail: '' }],
        }),
        distill({ id: 5, status: 'cancelled' }),
        distill({ id: 6, status: 'done', error: 'provider down' }),
      ],
      kg: [
        kg({ id: 10, status: 'pending' }),
        kg({ id: 11, status: 'running' }),
        kg({ id: 12, status: 'done', total: 3, done: 2 }),
        kg({ id: 13, status: 'cancelled' }),
      ],
      reembed: {
        id: 20,
        target: 'local:embed',
        status: 'done',
        cursor: 5,
        total: 5,
        done: 4,
        failed: 1,
        error: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });

    const zhRows = toJobRows(data, zh);
    const zhDetail = (key: string) => zhRows.find((r) => r.key === key)?.detail;
    expect(zhDetail('distill:1')).toBe('排队中');
    expect(zhDetail('distill:2')).toBe('进行中');
    expect(zhDetail('distill:3')).toBe('第 3 次重试');
    expect(zhDetail('distill:4')).toBe('已存 2 条');
    expect(zhRows.find((r) => r.key === 'distill:4')?.notes).toEqual(['Chatter — 重要度过低']);
    expect(zhDetail('distill:5')).toBe('已替代');
    expect(zhDetail('distill:6')).toBe('provider down');
    expect(zhDetail('kg:10')).toBe('排队中');
    expect(zhDetail('kg:11')).toBe('抽取中');
    expect(zhDetail('kg:12')).toBe('3 个实体 · 2 条关系');
    expect(zhDetail('kg:13')).toBe('记忆已变更');
    expect(zhDetail('reembed:20')).toBe('已向量化 4 条 · 1 条失败');

    const enRows = toJobRows(data, en);
    const enDetail = (key: string) => enRows.find((r) => r.key === key)?.detail;
    expect(enDetail('distill:1')).toBe('queued');
    expect(enDetail('distill:2')).toBe('running');
    expect(enDetail('distill:3')).toBe('retry 3');
    expect(enDetail('distill:4')).toBe('2 stored');
    expect(enDetail('distill:5')).toBe('superseded');
    expect(enDetail('distill:6')).toBe('provider down');
    expect(enDetail('kg:10')).toBe('queued');
    expect(enDetail('kg:11')).toBe('extracting');
    expect(enDetail('kg:12')).toBe('3 entities · 2 links');
    expect(enDetail('kg:13')).toBe('memory changed');
    expect(enDetail('reembed:20')).toBe('4 vectorized · 1 failed');

    const cancelledReembed = toJobRows(
      snapshot({
        reembed: {
          id: 21,
          target: 'local:embed',
          status: 'cancelled',
          cursor: 0,
          total: 5,
          done: 0,
          failed: 0,
          error: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      }),
      zh
    );
    expect(cancelledReembed[0].detail).toBe('已取消');
    const cancelledReembedEn = toJobRows(
      snapshot({
        reembed: {
          id: 21,
          target: 'local:embed',
          status: 'cancelled',
          cursor: 0,
          total: 5,
          done: 0,
          failed: 0,
          error: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      }),
      en
    );
    expect(cancelledReembedEn[0].detail).toBe('cancelled');
  });
});

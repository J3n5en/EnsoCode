import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from './db';
import {
  chunkTranscript,
  type DistillPayload,
  distillFingerprint,
  ensureDistillJob,
  lastDistillWatermark,
} from './distill';
import {
  buildBatchTranscript,
  claimDistillQueue,
  type DistillUnit,
  distillUnits,
  dueDistillGroups,
  enqueueDistill,
  nextDistillDueAt,
  planDistillBatches,
} from './distillQueue';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-distill-queue-'));
  db = openMemoryDb(path.join(dir, 'memory.db'), { vecExtensionPath: null });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2025-01-01T00:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const payload = (sessionId: string, extra: Partial<DistillPayload> = {}): DistillPayload => ({
  sessionId,
  sessionFile: `/fake/${sessionId}.jsonl`,
  projectId: 'p1',
  language: 'en',
  ...extra,
});
const queue = (p: DistillPayload, minute: number, windowMinutes = 5) =>
  enqueueDistill(
    db,
    p,
    distillFingerprint(p.sessionId, `${p.sessionId}:${p.toEntryId}`, p.language),
    at(minute + windowMinutes),
    at(minute)
  );
const unit = (sessionId: string, endedMinute: number, transcript: string, ids = [0]) => ({
  member: {
    sessionId,
    sessionFile: `/fake/${sessionId}.jsonl`,
    toEntryId: `${sessionId}-e2`,
    endedAt: at(endedMinute).toISOString(),
  },
  transcript,
  ids,
});

describe('distillQueue 待办落库', () => {
  it('同会话同内容只排一次；到期前不出队，到期后整组出队（含组内未到期的）', () => {
    expect(queue(payload('a', { toEntryId: 'a2' }), 0)).toBe(true);
    expect(queue(payload('a', { toEntryId: 'a2' }), 1)).toBe(false);
    expect(queue(payload('b', { toEntryId: 'b2' }), 3)).toBe(true);
    expect(nextDistillDueAt(db)).toBe(at(5).toISOString());
    expect(dueDistillGroups(db, at(4))).toEqual([]);
    const groups = dueDistillGroups(db, at(5));
    expect(groups).toHaveLength(1);
    expect(groups[0].map((item) => item.payload.sessionId)).toEqual(['a', 'b']);
  });

  it('不同项目 / 不同语言各成一组，各自按自己的到期时间出队', () => {
    queue(payload('a'), 0);
    queue(payload('b', { projectId: 'p2' }), 0);
    queue(payload('c', { language: 'zh' }), 0);
    queue(payload('d', { projectId: 'p3' }), 10);
    const groups = dueDistillGroups(db, at(6));
    expect(groups.map((g) => g.map((item) => item.payload.sessionId))).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
  });

  it('认领是原子且只成功一次：重复认领同一批返回 claimed=false，不重复执行回调', () => {
    queue(payload('a'), 0);
    queue(payload('b'), 0);
    const ids = dueDistillGroups(db, at(6))[0].map((item) => item.id);
    let runs = 0;
    expect(claimDistillQueue(db, ids, 'done', () => ++runs)).toEqual({ claimed: true, value: 1 });
    expect(claimDistillQueue(db, ids, 'done', () => ++runs)).toEqual({ claimed: false });
    expect(runs).toBe(1);
    expect(dueDistillGroups(db, at(60))).toEqual([]);
    expect(nextDistillDueAt(db)).toBeNull();
  });

  it('回调抛错时认领整体回滚：待办仍在，下次还能接上', () => {
    queue(payload('a'), 0);
    const ids = dueDistillGroups(db, at(6))[0].map((item) => item.id);
    expect(() =>
      claimDistillQueue(db, ids, 'done', () => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(dueDistillGroups(db, at(6))).toHaveLength(1);
  });

  it('续作水位能看到尚未提炼的待办：压缩触发后会话结束只排新增部分', () => {
    queue(payload('a', { toEntryId: 'a2' }), 0);
    expect(lastDistillWatermark(db, 'a')).toBe('a2');
    queue(payload('a', { fromEntryId: 'a2', toEntryId: 'a4' }), 1);
    expect(lastDistillWatermark(db, 'a')).toBe('a4');
    // 立即提炼的任务排在后面时以它为准
    const p = payload('a', { fromEntryId: 'a4', toEntryId: 'a6' });
    ensureDistillJob(db, p, distillFingerprint('a', 'x', 'en'));
    expect(lastDistillWatermark(db, 'a')).toBe('a6');
  });
});

describe('distillUnits：同会话多条待办合并成一个区间', () => {
  it('区间取首条起点到末条终点；不同会话各自一个单元', () => {
    queue(payload('a', { toEntryId: 'a2' }), 0);
    queue(payload('b', { toEntryId: 'b2' }), 1);
    queue(payload('a', { fromEntryId: 'a2', toEntryId: 'a4' }), 2);
    const units = distillUnits(dueDistillGroups(db, at(6))[0]);
    expect(
      units.map((u) => [u.member.sessionId, u.member.fromEntryId, u.member.toEntryId, u.ids.length])
    ).toEqual([
      ['a', undefined, 'a4', 2],
      ['b', undefined, 'b2', 1],
    ]);
    expect(units[0].member.endedAt).toBe(at(2).toISOString());
  });
});

describe('buildBatchTranscript / planDistillBatches', () => {
  const base = { projectId: 'p1', language: 'en' };

  it('每个会话前有清晰分隔（序号 · 会话 id · 时间），按结束时间排序', () => {
    const text = buildBatchTranscript([
      unit('b', 3, 'User: second'),
      unit('a', 1, 'User: first\n\nAssistant: ok'),
    ]);
    expect(text).toBe(
      [
        '## Session 1/2 · a · 2025-01-01T00:01Z\nUser: first\n\nAssistant: ok',
        '## Session 2/2 · b · 2025-01-01T00:03Z\nUser: second',
      ].join('\n\n')
    );
  });

  it('分块边界落在会话分隔处，分隔头与该会话首条消息不被拆开', () => {
    const long = `User: ${'x'.repeat(30)}`;
    const text = buildBatchTranscript([unit('a', 1, long), unit('b', 2, long)]);
    const chunks = chunkTranscript(text, 80);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].startsWith('## Session 1/2 · a')).toBe(true);
    expect(chunks[1].startsWith('## Session 2/2 · b')).toBe(true);
    expect(chunks.join('\n\n')).toBe(text);
  });

  it('指纹稳定：输入顺序打乱不影响拼接结果与指纹', () => {
    const units = [unit('a', 1, 'User: a'), unit('b', 2, 'User: b'), unit('c', 2, 'User: c')];
    const one = planDistillBatches(units, base);
    const two = planDistillBatches([units[2], units[0], units[1]], base);
    expect(one).toHaveLength(1);
    expect(two[0].fingerprint).toBe(one[0].fingerprint);
    expect(two[0].transcript).toBe(one[0].transcript);
    expect(one[0].payload.sessions?.map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
    expect(one[0].payload.sessionId.startsWith('batch:')).toBe(true);
  });

  it('单会话退化为普通任务：不造聚合结构，指纹与立即提炼一致', () => {
    const [plan] = planDistillBatches([unit('a', 1, 'User: only')], base);
    expect(plan.payload).toEqual({
      sessionId: 'a',
      sessionFile: '/fake/a.jsonl',
      projectId: 'p1',
      language: 'en',
      toEntryId: 'a-e2',
    });
    expect(plan.transcript).toBe('User: only');
    expect(plan.fingerprint).toBe(distillFingerprint('a', 'User: only', 'en'));
  });

  it('超过单批上限时按会话切成多批，不截断内容；单个超长会话独占一批', () => {
    const units: (DistillUnit & { ids: number[] })[] = [
      unit('a', 1, `User: ${'a'.repeat(40)}`, [1]),
      unit('b', 2, `User: ${'b'.repeat(40)}`, [2]),
      unit('c', 3, `User: ${'c'.repeat(200)}`, [3]),
      unit('d', 4, `User: ${'d'.repeat(10)}`, [4]),
    ];
    const plans = planDistillBatches(units, base, 120);
    expect(plans.map((p) => p.ids)).toEqual([[1, 2], [3], [4]]);
    expect(plans[1].payload.sessions).toBeUndefined();
    for (const u of units) {
      expect(plans.some((p) => p.transcript.includes(u.transcript))).toBe(true);
    }
  });
});

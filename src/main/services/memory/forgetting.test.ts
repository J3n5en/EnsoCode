import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_FORGETTING_SETTINGS, type ForgettingSettings } from '@shared/memory/forgetting';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryAuditEntry } from './audit';
import { openMemoryDb } from './db';
import {
  archiveCandidatesConfirmed,
  getForgettingState,
  listArchiveCandidates,
  runForgettingPass,
} from './forgetting';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let dir: string;
let db: Database.Database;
let audit: MemoryAuditEntry[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-forget-'));
  db = openMemoryDb(path.join(dir, 'memory.db'));
  audit = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 直接落库，绕过创建路径的去重，便于构造确定的库状态 */
function put(
  id: string,
  opts: {
    createdAt?: string;
    lastHitAt?: string | null;
    hitCount?: number;
    importance?: number;
    isCrystal?: boolean;
    lifecycleState?: 'active' | 'archived';
  } = {}
): string {
  const at = opts.createdAt ?? daysAgo(200);
  db.prepare(
    `INSERT INTO memories (id, title, content, semantic_field, space_id, importance, is_crystal,
       lifecycle_state, created_at, updated_at, last_accessed_at, last_hit_at, hit_count)
     VALUES (?, ?, ?, ?, 'global', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    id,
    `body ${id}`,
    `${id}\nbody ${id}`,
    opts.importance ?? 0.5,
    opts.isCrystal ? 1 : 0,
    opts.lifecycleState ?? 'active',
    at,
    at,
    at,
    opts.lastHitAt === undefined ? null : opts.lastHitAt,
    opts.hitCount ?? 0
  );
  return id;
}

const settings = (patch: Partial<ForgettingSettings> = {}): ForgettingSettings => ({
  ...DEFAULT_FORGETTING_SETTINGS,
  archiveCandidates: true,
  ...patch,
});

const run = (patch: Partial<ForgettingSettings> = {}) =>
  runForgettingPass(db, settings(patch), { now: NOW, audit: (entry) => audit.push(entry) });

const candidateIds = () =>
  (
    db
      .prepare('SELECT id FROM memories WHERE archive_candidate_at IS NOT NULL ORDER BY id')
      .all() as { id: string }[]
  ).map((row) => row.id);

const lifecycleOf = (id: string) =>
  (db.prepare('SELECT lifecycle_state AS s FROM memories WHERE id = ?').get(id) as { s: string }).s;

describe('runForgettingPass', () => {
  it('写入真实衰减分：命中的记忆分高于从未命中的', () => {
    put('fresh', { createdAt: daysAgo(200), lastHitAt: daysAgo(0), hitCount: 5 });
    put('cold', { createdAt: daysAgo(200), lastHitAt: daysAgo(200), hitCount: 0 });
    const summary = run();
    expect(summary.scored).toBe(2);
    const score = (id: string) =>
      (
        db.prepare('SELECT decay_score_cached AS s FROM memories WHERE id = ?').get(id) as {
          s: number;
        }
      ).s;
    expect(score('fresh')).toBeGreaterThan(score('cold'));
    // 不再是建表时的恒 1.0
    expect(score('cold')).toBeLessThan(1);
    expect(score('cold')).toBeCloseTo(0.4, 6); // floor = 0.3 + 0.2*0.5
  });

  it('开关关掉时什么都不写', () => {
    put('cold');
    const summary = run({ enabled: false });
    expect(summary.scored).toBe(0);
    expect(candidateIds()).toEqual([]);
    const score = (
      db.prepare("SELECT decay_score_cached AS s FROM memories WHERE id = 'cold'").get() as {
        s: number;
      }
    ).s;
    expect(score).toBe(1);
  });

  it('默认设置只降权：不标记候选、不改状态', () => {
    put('cold');
    const summary = runForgettingPass(db, DEFAULT_FORGETTING_SETTINGS, { now: NOW });
    expect(summary.scored).toBe(1);
    expect(summary.candidates).toBe(0);
    expect(summary.archived).toBe(0);
    expect(candidateIds()).toEqual([]);
    expect(lifecycleOf('cold')).toBe('active');
  });

  it('标记冷且不重要的记忆，重要度高的不标', () => {
    put('cold-low', { lastHitAt: daysAgo(120), importance: 0.5 });
    put('cold-high', { lastHitAt: daysAgo(120), importance: 0.8 });
    put('warm-low', { lastHitAt: daysAgo(10), importance: 0.5 });
    const summary = run();
    expect(candidateIds()).toEqual(['cold-low']);
    expect(summary.candidates).toBe(1);
    // 只标记，不归档
    expect(lifecycleOf('cold-low')).toBe('active');
  });

  it('阈值边界：staleDays 当天不算冷，多一天才算；重要度含等号', () => {
    put('exactly-90', { lastHitAt: daysAgo(90), importance: 0.5 });
    put('over-90', {
      lastHitAt: new Date(NOW.getTime() - 90 * DAY - 1).toISOString(),
      importance: 0.5,
    });
    put('just-over-importance', { lastHitAt: daysAgo(120), importance: 0.51 });
    run({ staleDays: 90, maxImportance: 0.5 });
    expect(candidateIds()).toEqual(['over-90']);
  });

  it('从未命中的按创建时间算', () => {
    put('never-hit-old', { createdAt: daysAgo(120), lastHitAt: null, importance: 0.5 });
    put('never-hit-new', { createdAt: daysAgo(5), lastHitAt: null, importance: 0.5 });
    run();
    expect(candidateIds()).toEqual(['never-hit-old']);
  });

  it('crystal / 版本链 / crystal 来源永不进候选', () => {
    put('crystal', { isCrystal: true });
    put('older', {});
    put('newer', {});
    put('source', {});
    put('plain', {});
    db.prepare(
      `INSERT INTO evolves (id, older_id, newer_id, content_relation, confidence, created_at)
       VALUES ('e1', 'older', 'newer', 'replaces', 0.9, ?)`
    ).run(daysAgo(10));
    db.prepare(
      `INSERT INTO crystallized_from (crystal_id, source_id, contribution_weight, created_at)
       VALUES ('crystal', 'source', 1.0, ?)`
    ).run(daysAgo(10));
    run();
    expect(candidateIds()).toEqual(['plain']);
  });

  it('重新被检索到就撤销候选标记', () => {
    put('cold', { lastHitAt: daysAgo(120) });
    run();
    expect(candidateIds()).toEqual(['cold']);
    db.prepare('UPDATE memories SET last_hit_at = ? WHERE id = ?').run(daysAgo(1), 'cold');
    run();
    expect(candidateIds()).toEqual([]);
  });

  it('关掉标记后旧标记一起撤掉', () => {
    put('cold');
    run();
    expect(candidateIds()).toEqual(['cold']);
    run({ archiveCandidates: false, autoArchive: false });
    expect(candidateIds()).toEqual([]);
  });

  it('autoArchive 关闭时只标记，不归档', () => {
    put('cold');
    const summary = run({ archiveCandidates: true, autoArchive: false });
    expect(summary.archived).toBe(0);
    expect(lifecycleOf('cold')).toBe('active');
    expect(candidateIds()).toEqual(['cold']);
  });

  it('autoArchive 打开时归档候选，但绝不删除', () => {
    put('cold');
    put('keep', { lastHitAt: daysAgo(0) });
    const summary = run({ archiveCandidates: true, autoArchive: true });
    expect(summary.archived).toBe(1);
    expect(lifecycleOf('cold')).toBe('archived');
    expect(lifecycleOf('keep')).toBe('active');
    // 行还在：归档不是删除
    expect((db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n).toBe(2);
    expect(candidateIds()).toEqual([]);
  });

  it('归档后可以还原回 active', () => {
    put('cold');
    run({ autoArchive: true });
    expect(lifecycleOf('cold')).toBe('archived');
    db.prepare("UPDATE memories SET lifecycle_state = 'active' WHERE id = 'cold'").run();
    expect(lifecycleOf('cold')).toBe('active');
  });

  it('每次运行记一条 memory.decay 审计，归档另记一条', () => {
    put('cold');
    run({ autoArchive: true });
    const decay = audit.filter((entry) => entry.action === 'memory.decay');
    const archived = audit.filter((entry) => entry.action === 'memory.archive');
    expect(decay).toHaveLength(1);
    expect(archived).toHaveLength(1);
    expect(decay[0]).toMatchObject({ actor: 'system' });
    expect(archived[0]).toMatchObject({ actor: 'system', reason: 'auto', ids: ['cold'] });
  });

  it('记录上次运行时间与摘要', () => {
    put('cold');
    run();
    const state = getForgettingState(db, settings(), NOW);
    expect(state.lastRunAt).toBe(NOW.toISOString());
    expect(state.lastRun?.scored).toBe(1);
    expect(state.candidates).toBe(1);
  });
});

describe('listArchiveCandidates', () => {
  it('与标记同一条件：看到的就是会被归档的', () => {
    put('cold');
    put('warm', { lastHitAt: daysAgo(0) });
    run();
    const { items, total } = listArchiveCandidates(db, settings(), { now: NOW });
    expect(total).toBe(1);
    expect(items.map((memory) => memory.id)).toEqual(['cold']);
    expect(items[0].archiveCandidateAt).toBe(NOW.toISOString());
  });
});

describe('archiveCandidatesConfirmed', () => {
  it('确认时重算条件：期间被命中的行跳过', () => {
    put('cold');
    put('rescued');
    run();
    db.prepare('UPDATE memories SET last_hit_at = ? WHERE id = ?').run(daysAgo(0), 'rescued');
    const result = archiveCandidatesConfirmed(db, settings(), ['cold', 'rescued'], {
      now: NOW,
      audit: (entry) => audit.push(entry),
    });
    expect(result.archived).toBe(1);
    expect(result.skipped).toBe(1);
    expect(lifecycleOf('cold')).toBe('archived');
    expect(lifecycleOf('rescued')).toBe('active');
    expect(audit.filter((entry) => entry.action === 'memory.archive')[0]).toMatchObject({
      actor: 'user',
      reason: 'candidates',
      ids: ['cold'],
    });
  });

  it('不删除任何行', () => {
    put('cold');
    run();
    archiveCandidatesConfirmed(db, settings(), ['cold'], { now: NOW });
    expect((db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n).toBe(1);
  });
});

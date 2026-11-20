import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasVec, openMemoryDb } from './db';
import type { Complete } from './distill';
import { findReconcilePairs, parseReconcileVerdict, runReconcile } from './reconcile';
import { createMemory, getMemory, listEvolves } from './store';
import { type Embedder, projectSpaceId } from './types';

/** 正文里出现 marker 就给对应向量；用来构造可预测的余弦相似度 */
function markerEmbedder(table: [string, number[]][]): Embedder {
  return {
    model: 'marker',
    dim: 3,
    embed: async (text) => {
      const hit = table.find(([marker]) => text.includes(marker));
      return Float32Array.from(hit ? hit[1] : [0, 0, 1]);
    },
  };
}

const embedder = markerEmbedder([
  ['Jenkins 已下线', [1, 0.2, 0]],
  ['Jenkins', [1, 0, 0]],
  ['MySQL 已弃用', [0, 1, 0.1]],
  ['MySQL', [0, 1, 0]],
  ['GitLab', [0.9, 0.1, 0.1]],
  ['午饭', [0, 0, 1]],
]);

const challenges = (reason = 'newer says the old tool is gone') =>
  JSON.stringify({ relation: 'challenges', confidence: 0.9, reason });
const none = JSON.stringify({ relation: 'none', confidence: 0.9, reason: 'compatible' });

/** 假模型：按 user 文本里同时出现的关键词返回预置 JSON */
function fakeModel(rules: [string[], string | Error][]) {
  const fn = vi.fn(async (_system: string, user: string) => {
    const rule = rules.find(([keys]) => keys.every((k) => user.includes(k)));
    if (!rule) return none;
    if (rule[1] instanceof Error) throw rule[1];
    return rule[1];
  });
  return fn as typeof fn & Complete;
}

describe.each([
  ['sqlite-vec KNN', undefined],
  ['无扩展时扫 BLOB', null],
] as const)('runReconcile（%s）', (_label, vecExtensionPath) => {
  let dir: string;
  let db: Database.Database;
  let tick = 0;
  beforeEach(() => {
    tick = 0;
    dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-reconcile-'));
    db = openMemoryDb(path.join(dir, 'memory.db'), { vecExtensionPath });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('连接模式与预期一致', () => {
    expect(hasVec(db)).toBe(vecExtensionPath === undefined);
  });

  const add = async (
    content: string,
    opts: { importance?: number; spaceId?: string; at?: string } = {}
  ) => {
    tick += 1;
    const r = await createMemory(
      db,
      { content, importance: opts.importance ?? 0.8, spaceId: opts.spaceId ?? 'global' },
      { embedder, now: new Date(opts.at ?? `2025-01-${String(tick).padStart(2, '0')}T00:00:00Z`) }
    );
    if (r.status !== 'inserted') throw new Error(r.status);
    return r.memory;
  };

  it('找到矛盾配对写 challenges：older=较旧、newer=较新，待审阅，置信度与理由来自模型', async () => {
    const older = await add('部署流水线使用 Jenkins', { at: '2025-01-01T00:00:00Z' });
    const newer = await add('部署流水线迁到 GitHub Actions，Jenkins 已下线', {
      at: '2025-03-01T00:00:00Z',
    });
    const complete = fakeModel([[['Jenkins 已下线', '使用 Jenkins'], challenges()]]);
    const summary = await runReconcile(db, { complete });
    expect(summary).toMatchObject({ pairs: 1, judged: 1, challenges: 1, failed: 0, capped: false });
    const edges = listEvolves(db, older.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      olderId: older.id,
      newerId: newer.id,
      relation: 'challenges',
      reviewState: 'pending',
      confidence: 0.9,
      reason: 'newer says the old tool is gone',
    });
    // prompt 里旧在前、新在后，与时间无关的插入顺序不影响方向
    const user = complete.mock.calls[0][1];
    expect(user.indexOf('使用 Jenkins')).toBeLessThan(user.indexOf('Jenkins 已下线'));
  });

  it('方向按 created_at 而不是 KNN 源：较新的那条先被扫到也写成 older→newer', async () => {
    const newer = await add('部署流水线迁到 GitHub Actions，Jenkins 已下线', {
      at: '2025-03-01T00:00:00Z',
      importance: 0.9,
    });
    const older = await add('部署流水线使用 Jenkins', {
      at: '2025-01-01T00:00:00Z',
      importance: 0.5,
    });
    await runReconcile(db, { complete: fakeModel([[['Jenkins'], challenges()]]) });
    expect(listEvolves(db, older.id)[0]).toMatchObject({ olderId: older.id, newerId: newer.id });
  });

  it('模型判 replaces 也只写 challenges：旧记忆保持 is_latest，不被隐藏', async () => {
    const older = await add('部署流水线使用 Jenkins');
    await add('部署流水线迁到 GitHub Actions，Jenkins 已下线');
    const complete = fakeModel([
      [['Jenkins'], JSON.stringify({ relation: 'replaces', confidence: 0.95, reason: 'migrated' })],
    ]);
    await runReconcile(db, { complete });
    expect(listEvolves(db, older.id).map((e) => e.relation)).toEqual(['challenges']);
    expect(getMemory(db, older.id)?.isLatest).toBe(true);
  });

  it('不矛盾 / 置信度不足的配对不写边', async () => {
    const a = await add('部署流水线使用 Jenkins');
    await add('部署流水线迁到 GitHub Actions，Jenkins 已下线');
    const b = await add('报表库使用 MySQL');
    await add('报表库 MySQL 已弃用，换成 ClickHouse');
    const complete = fakeModel([
      [['Jenkins'], none],
      [['MySQL'], JSON.stringify({ relation: 'challenges', confidence: 0.4, reason: 'maybe' })],
    ]);
    const summary = await runReconcile(db, { complete });
    expect(summary).toMatchObject({ judged: 2, challenges: 0 });
    expect(listEvolves(db, a.id)).toEqual([]);
    expect(listEvolves(db, b.id)).toEqual([]);
  });

  it('幂等：重复运行不重复建边，也不再为已判过的配对调模型（含判为 none 的）', async () => {
    const a = await add('部署流水线使用 Jenkins');
    await add('部署流水线迁到 GitHub Actions，Jenkins 已下线');
    await add('报表库使用 MySQL');
    await add('报表库 MySQL 已弃用，换成 ClickHouse');
    const complete = fakeModel([[['Jenkins'], challenges()]]);
    await runReconcile(db, { complete });
    expect(complete).toHaveBeenCalledTimes(2);
    const again = await runReconcile(db, { complete });
    expect(again).toMatchObject({ pairs: 0, judged: 0 });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(listEvolves(db, a.id)).toHaveLength(1);
  });

  it('任一端改了正文后重新判定', async () => {
    const a = await add('部署流水线使用 Jenkins');
    await add('部署流水线迁到 GitHub Actions，Jenkins 已下线');
    const complete = fakeModel([]);
    await runReconcile(db, { complete });
    db.prepare('UPDATE memories SET content_hash = ? WHERE id = ?').run('edited', a.id);
    await runReconcile(db, { complete });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('两端已有 evolves 边（任意关系 / 方向）时跳过', async () => {
    const older = await add('部署流水线使用 Jenkins');
    tick += 1;
    const r = await createMemory(
      db,
      {
        content: '部署流水线迁到 GitHub Actions，Jenkins 已下线',
        importance: 0.8,
        spaceId: 'global',
        evolvesFromId: older.id,
        evolvesRelation: 'enriches',
      },
      { embedder, now: new Date('2025-02-01T00:00:00Z') }
    );
    expect(r.status).toBe('inserted');
    const complete = fakeModel([[['Jenkins'], challenges()]]);
    const summary = await runReconcile(db, { complete });
    expect(summary.pairs).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(listEvolves(db, older.id).map((e) => e.relation)).toEqual(['enriches']);
  });

  it('单条判定抛错 / 输出不可解析不影响其余配对，失败的下次重试', async () => {
    await add('部署流水线使用 Jenkins');
    await add('部署流水线迁到 GitHub Actions，Jenkins 已下线');
    const b = await add('报表库使用 MySQL');
    await add('报表库 MySQL 已弃用，换成 ClickHouse');
    const complete = fakeModel([
      [['Jenkins'], new Error('provider down')],
      [['MySQL'], challenges('mysql is gone')],
    ]);
    const summary = await runReconcile(db, { complete });
    expect(summary).toMatchObject({ pairs: 2, judged: 1, failed: 1, challenges: 1 });
    expect(listEvolves(db, b.id)).toHaveLength(1);
    const garbled = fakeModel([[['Jenkins'], 'not json at all']]);
    expect(await runReconcile(db, { complete: garbled })).toMatchObject({ pairs: 1, failed: 1 });
  });

  it('单次上限：超过 maxPairs 只处理前 N 对，下一轮接着处理剩下的', async () => {
    await add('部署流水线使用 Jenkins');
    await add('部署流水线迁到 GitHub Actions，Jenkins 已下线');
    await add('报表库使用 MySQL');
    await add('报表库 MySQL 已弃用，换成 ClickHouse');
    const complete = fakeModel([]);
    const first = await runReconcile(db, { complete, maxPairs: 1 });
    expect(first).toMatchObject({ pairs: 1, judged: 1, capped: true });
    expect(complete).toHaveBeenCalledTimes(1);
    const second = await runReconcile(db, { complete, maxPairs: 1 });
    expect(second).toMatchObject({ pairs: 1, judged: 1 });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0][1]).not.toBe(complete.mock.calls[1][1]);
  });

  it('候选门槛：两端都不重要且没被命中过不判；任一端被检索命中过就判', async () => {
    const a = await add('部署流水线使用 Jenkins', { importance: 0.5 });
    await add('部署流水线迁到 GitHub Actions，Jenkins 已下线', { importance: 0.5 });
    const complete = fakeModel([]);
    expect(await runReconcile(db, { complete })).toMatchObject({ pairs: 0 });
    db.prepare('UPDATE memories SET hit_count = 3 WHERE id = ?').run(a.id);
    expect(await runReconcile(db, { complete })).toMatchObject({ pairs: 1 });
  });

  it('不跨 space、不配相似度低于阈值的、不配非 active 的', async () => {
    await add('部署流水线使用 Jenkins', { spaceId: projectSpaceId('p1') });
    await add('部署流水线迁到 GitHub Actions，Jenkins 已下线', {
      spaceId: projectSpaceId('p2'),
    });
    await add('报表库使用 MySQL');
    await add('午饭吃面');
    const archived = await add('代码托管在 GitLab');
    await add('代码托管迁到 GitHub，Jenkins 不再用');
    db.prepare("UPDATE memories SET lifecycle_state = 'archived' WHERE id = ?").run(archived.id);
    expect(findReconcilePairs(db)).toMatchObject({ pairs: [] });
  });

  it('同一对只出现一次（A 找到 B、B 找到 A 去重）', async () => {
    await add('部署流水线使用 Jenkins');
    await add('部署流水线迁到 GitHub Actions，Jenkins 已下线');
    const { pairs } = findReconcilePairs(db);
    expect(pairs).toHaveLength(1);
  });
});

describe('parseReconcileVerdict', () => {
  it('容错：剥 think / 围栏，关系名大小写不敏感，置信度夹到 [0,1]', () => {
    expect(
      parseReconcileVerdict(
        '<think>{"relation":"none"</think>```json\n{"relation":"Challenges","confidence":"1.5","reason":" x "}\n```'
      )
    ).toEqual({ relation: 'challenges', confidence: 1, reason: 'x' });
  });

  it('缺置信度按自动推断门限处理；未知关系 / 非 JSON 返回 null', () => {
    expect(parseReconcileVerdict('{"relation":"replaces"}')).toMatchObject({
      relation: 'replaces',
      confidence: 0.7,
      reason: null,
    });
    expect(parseReconcileVerdict('{"relation":"maybe"}')).toBeNull();
    expect(parseReconcileVerdict('no json')).toBeNull();
  });
});

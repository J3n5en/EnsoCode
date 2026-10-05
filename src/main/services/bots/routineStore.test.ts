import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotRoutineStore } from './routineStore';

const BOT = '22222222-2222-4222-8222-222222222222';
const BOT2 = '55555555-5555-4555-8555-555555555555';
const CHAT = '33333333-3333-4333-8333-333333333333';

let root: string;
let clock = 1000;
const now = () => ++clock;
let store: BotRoutineStore;
const draft = { title: '早报', prompt: '汇总昨天的提交', schedule: '0 9 * * 1-5', chatId: CHAT };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-routines-'));
  store = new BotRoutineStore(root, now);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('BotRoutineStore', () => {
  it('新建后落盘到 <botId>/routines.json，重开仍在', () => {
    const saved = store.save(BOT, draft);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.routine).toMatchObject({
      ...draft,
      botId: BOT,
      status: 'enabled',
      procedureVersion: 1,
      approvedVersion: 1,
      catchUp: true,
      cursor: saved.routine.updatedAt,
      createdAt: saved.routine.updatedAt,
    });
    expect(JSON.parse(readFileSync(join(root, BOT, 'routines.json'), 'utf8'))).toBeTruthy();
    expect(new BotRoutineStore(root, now).list(BOT)).toEqual([saved.routine]);
  });

  it('更新保留 createdAt 与运行记录；未知 id → not-found', () => {
    const created = store.save(BOT, draft);
    if (!created.ok) throw new Error('setup');
    const id = created.routine.id;
    store.markRun(BOT, id, 'ok');
    const updated = store.save(BOT, { ...draft, id, title: '周报', enabled: false });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.routine).toMatchObject({
      id,
      title: '周报',
      status: 'paused',
      procedureVersion: 2,
      approvedVersion: 2,
      createdAt: created.routine.createdAt,
      lastResult: 'ok',
    });
    expect(updated.routine.updatedAt).toBeGreaterThan(created.routine.updatedAt);
    expect(store.save(BOT, { ...draft, id: '99999999-9999-4999-8999-999999999999' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('非法输入拒绝：空标题 / 空 prompt / 坏 cron / 坏 chatId / 坏 botId', () => {
    for (const bad of [
      { ...draft, title: '  ' },
      { ...draft, prompt: '' },
      { ...draft, schedule: '61 * * * *' },
      { ...draft, chatId: '../x' },
      { ...draft, doneBy: '../x' },
    ]) {
      expect(store.save(BOT, bad)).toEqual({ ok: false, reason: 'invalid' });
      expect(store.propose(BOT, bad).ok).toBe(false);
    }
    expect(store.save('../evil', draft)).toEqual({ ok: false, reason: 'invalid' });
    expect(store.list('../evil')).toEqual([]);
    expect(store.remove('../evil', 'x')).toBe(false);
    expect(store.list(BOT)).toEqual([]);
  });

  it('markRun 记录时间、结果与错过次数；错过次数截断到 99', () => {
    const created = store.save(BOT, draft);
    if (!created.ok) throw new Error('setup');
    const ran = store.markRun(BOT, created.routine.id, 'skipped', 500);
    expect(ran).toMatchObject({ lastResult: 'skipped', missed: 99 });
    expect(ran?.lastRunAt).toBeGreaterThan(created.routine.createdAt);
    const ok = store.markRun(BOT, created.routine.id, 'ok');
    expect(ok?.lastResult).toBe('ok');
    expect(ok?.missed).toBe(99);
    expect(store.markRun(BOT, created.routine.id, 'ok', 0)).not.toHaveProperty('missed');
    expect(store.markRun(BOT, 'nope', 'ok')).toBeUndefined();
  });

  it('remove 删单条；listAll 汇总所有成员', () => {
    const a = store.save(BOT, draft);
    const b = store.save(BOT2, { ...draft, title: 'B' });
    if (!a.ok || !b.ok) throw new Error('setup');
    expect(
      store
        .listAll()
        .map((r) => r.id)
        .sort()
    ).toEqual([a.routine.id, b.routine.id].sort());
    expect(store.remove(BOT, a.routine.id)).toBe(true);
    expect(store.remove(BOT, a.routine.id)).toBe(false);
    expect(store.listAll().map((r) => r.id)).toEqual([b.routine.id]);
  });

  it('坏文件当空；单条坏记录丢弃；botId 与目录不符的记录丢弃', () => {
    mkdirSync(join(root, BOT), { recursive: true });
    writeFileSync(join(root, BOT, 'routines.json'), '{not json');
    expect(store.list(BOT)).toEqual([]);
    const good = {
      ...draft,
      id: '66666666-6666-4666-8666-666666666666',
      botId: BOT,
      status: 'enabled',
      procedureVersion: 1,
      approvedVersion: 1,
      catchUp: true,
      createdAt: 1,
      updatedAt: 1,
    };
    writeFileSync(
      join(root, BOT, 'routines.json'),
      JSON.stringify({
        routines: [
          good,
          { ...good, id: 'x' },
          { ...good, id: '77777777-7777-4777-8777-777777777777', botId: BOT2 },
        ],
      })
    );
    expect(store.list(BOT).map((r) => r.id)).toEqual([good.id]);
    mkdirSync(join(root, 'not-a-bot'));
    expect(store.listAll().map((r) => r.id)).toEqual([good.id]);
  });

  it('只有流程变更（标题 / 提示词 / 执行者 / 调度 / 聊天）才升版本；补跑开关不升', () => {
    const created = store.save(BOT, draft);
    if (!created.ok) throw new Error('setup');
    const id = created.routine.id;
    const same = store.save(BOT, { ...draft, id, catchUp: false });
    expect(same.ok && same.routine).toMatchObject({ procedureVersion: 1, catchUp: false });
    const doneBy = store.save(BOT, { ...draft, id, doneBy: BOT2 });
    expect(doneBy.ok && doneBy.routine).toMatchObject({ procedureVersion: 2, doneBy: BOT2 });
    const cleared = store.save(BOT, { ...draft, id, doneBy: null });
    expect(cleared.ok && cleared.routine.procedureVersion).toBe(3);
    expect(cleared.ok && cleared.routine).not.toHaveProperty('doneBy');
    const self = store.save(BOT, { ...draft, id, doneBy: BOT });
    expect(self.ok && self.routine).not.toHaveProperty('doneBy');
  });

  it('成员提议为待批准草稿；批准即启用，拒绝从未批准的直接删除', () => {
    const proposed = store.propose(BOT, draft);
    if (!proposed.ok) throw new Error('setup');
    expect(proposed.created).toBe(true);
    expect(proposed.routine).toMatchObject({
      status: 'draft',
      procedureVersion: 1,
      proposedBy: BOT,
    });
    expect(proposed.routine).not.toHaveProperty('approvedVersion');
    const approved = store.review(BOT, proposed.routine.id, true);
    expect(approved).toMatchObject({
      ok: true,
      routine: { status: 'enabled', approvedVersion: 1, cursor: expect.any(Number) },
    });
    expect(store.review(BOT, proposed.routine.id, true)).toEqual({ ok: false, reason: 'invalid' });

    const other = store.propose(BOT, { ...draft, title: '另一个' });
    if (!other.ok) throw new Error('setup');
    expect(store.review(BOT, other.routine.id, false)).toEqual({ ok: true, removed: true });
    expect(store.list(BOT).map((r) => r.id)).toEqual([proposed.routine.id]);
    expect(store.review(BOT, 'nope', true)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('成员改动已批准的同名例程：升版本回到待批准；拒绝后暂停且不再视为已批准', () => {
    const created = store.save(BOT, draft);
    if (!created.ok) throw new Error('setup');
    const same = store.propose(BOT, { ...draft, title: ` ${draft.title} ` });
    expect(same).toMatchObject({ ok: true, created: false, unchanged: true });
    const changed = store.propose(BOT, { ...draft, prompt: '改成汇总上周' });
    expect(changed).toMatchObject({
      ok: true,
      created: false,
      routine: {
        id: created.routine.id,
        status: 'draft',
        procedureVersion: 2,
        approvedVersion: 1,
        prompt: '改成汇总上周',
      },
    });
    const rejected = store.review(BOT, created.routine.id, false);
    expect(rejected).toMatchObject({ ok: true, routine: { status: 'paused', approvedVersion: 1 } });
  });

  it('用户编辑草稿 / 阻塞的例程即视为批准并清除阻塞原因', () => {
    const proposed = store.propose(BOT, draft);
    if (!proposed.ok) throw new Error('setup');
    const blocked = store.block(BOT, proposed.routine.id, 'not-in-chat');
    expect(blocked).toMatchObject({ status: 'blocked', blockedReason: 'not-in-chat' });
    const saved = store.save(BOT, { ...draft, id: proposed.routine.id });
    expect(saved.ok && saved.routine).toMatchObject({ status: 'enabled', approvedVersion: 1 });
    expect(saved.ok && saved.routine).not.toHaveProperty('blockedReason');
  });

  it('advance 只前移游标并记录错过次数', () => {
    const created = store.save(BOT, draft);
    if (!created.ok) throw new Error('setup');
    const id = created.routine.id;
    expect(store.advance(BOT, id, 5_000_000, 3)).toMatchObject({ cursor: 5_000_000, missed: 3 });
    expect(store.advance(BOT, id, 10)?.cursor).toBe(5_000_000);
  });
});

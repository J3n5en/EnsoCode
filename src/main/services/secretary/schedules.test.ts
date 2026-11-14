import { parseProfile } from '@shared/secretary/parse';
import type {
  SecretaryAuditEntry,
  SecretaryProfile,
  SecretarySchedule,
  SecretaryTodo,
} from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import {
  createSecretaryScheduleHandlers,
  DAILY_BRIEF_ID,
  fireDue,
  listSchedules,
  nextRunAt,
  removeSchedule,
  type SchedulePorts,
  skipMissedCron,
  syncSystemSchedules,
  todoReminderId,
} from './schedules';

/** 本地时间构造，cron 按本地时区解释 */
const at = (hour: number, minute = 0, day = 13): number =>
  new Date(2026, 10, day, hour, minute, 0, 0).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();

function profile(extra: Partial<SecretaryProfile> = {}): SecretaryProfile {
  const base = parseProfile({});
  if (!base) throw new Error('default profile');
  return { ...base, ...extra };
}

function todo(extra: Partial<SecretaryTodo> = {}): SecretaryTodo {
  return { id: 't1', text: '交周报', createdAt: 0, updatedAt: 0, ...extra };
}

interface Harness {
  ports: SchedulePorts;
  state: {
    schedules: SecretarySchedule[];
    audit: SecretaryAuditEntry[];
    now: number;
    saves: number;
    published: number;
  };
}

function harness(schedules: SecretarySchedule[] = [], now = at(9)): Harness {
  const state: Harness['state'] = {
    schedules: structuredClone(schedules),
    audit: [],
    now,
    saves: 0,
    published: 0,
  };
  let seq = 0;
  const ports: SchedulePorts = {
    schedules: () => structuredClone(state.schedules),
    saveSchedules: (list) => {
      state.schedules = structuredClone(list);
      state.saves += 1;
    },
    audit: (entry) => state.audit.push(entry),
    newId: () => `id-${++seq}`,
    now: () => state.now,
    publish: () => {
      state.published += 1;
    },
  };
  return { ports, state };
}

function once(extra: Partial<SecretarySchedule> = {}): SecretarySchedule {
  return {
    id: 's1',
    name: '提醒',
    prompt: '看看进展',
    createdAt: at(8),
    at: iso(at(10)),
    ...extra,
  } as SecretarySchedule;
}

function cron(extra: Partial<SecretarySchedule> = {}): SecretarySchedule {
  return {
    id: 's2',
    name: '每日简报',
    prompt: '写简报',
    createdAt: at(8),
    cron: '0 10 * * *',
    ...extra,
  } as SecretarySchedule;
}

describe('到点触发', () => {
  it('一次性定时到点投递一次并从列表删除', () => {
    const fired = fireDue([once()], at(10));
    expect(fired.updates).toHaveLength(1);
    expect(fired.updates[0]).toMatchObject({ kind: 'schedule', scheduleId: 's1' });
    expect(fired.updates[0].text).toContain('看看进展');
    expect(fired.schedules).toEqual([]);
    expect(fired.changed).toBe(true);
  });

  it('没到点不触发', () => {
    const fired = fireDue([once()], at(9, 59));
    expect(fired.updates).toEqual([]);
    expect(fired.changed).toBe(false);
  });

  it('cron 到点投递一次并把 lastFiredAt 推到当前时间', () => {
    const fired = fireDue([cron()], at(10, 30));
    expect(fired.updates).toHaveLength(1);
    expect(fired.schedules[0]).toMatchObject({ id: 's2', lastFiredAt: at(10, 30) });
  });

  it('cron 同一分钟内不重复触发', () => {
    const first = fireDue([cron()], at(10));
    const second = fireDue(first.schedules, at(10));
    expect(second.updates).toEqual([]);
  });

  it('cron 错过多次只投一次，不按次数补发', () => {
    const fired = fireDue([cron()], at(10, 0, 16));
    expect(fired.updates).toHaveLength(1);
  });

  it('应用未运行期间错过的 cron 只算下一次，不投递', () => {
    const skipped = skipMissedCron([cron()], at(10, 30));
    expect(skipped.changed).toBe(true);
    expect(skipped.schedules[0]).toMatchObject({ lastFiredAt: at(10, 30) });
    expect(fireDue(skipped.schedules, at(10, 30)).updates).toEqual([]);
  });

  it('未到点的 cron 不被跳过', () => {
    const skipped = skipMissedCron([cron()], at(9));
    expect(skipped.changed).toBe(false);
  });

  it('下一次触发时间按 at 与 cron 分别计算', () => {
    expect(nextRunAt(once())).toBe(at(10));
    expect(nextRunAt(cron({ lastFiredAt: at(10) }))).toBe(at(10, 0, 14));
  });
});

describe('schedule_add', () => {
  const handlers = (h: Harness) => createSecretaryScheduleHandlers(h.ports);
  const ctx = { secretaryConversationId: 'sec1' };

  it('at 与 cron 二选一，两个都给或都不给都报错', async () => {
    const h = harness();
    const both = await handlers(h).schedule_add(
      { name: 'n', prompt: 'p', at: iso(at(10)), cron: '0 10 * * *' },
      ctx
    );
    expect(both.ok).toBe(false);
    const neither = await handlers(h).schedule_add({ name: 'n', prompt: 'p' }, ctx);
    expect(neither.ok).toBe(false);
    expect(h.state.schedules).toEqual([]);
  });

  it('at 必须是未来的 ISO 时间', async () => {
    const h = harness([], at(9));
    const past = await handlers(h).schedule_add({ name: 'n', prompt: 'p', at: iso(at(8)) }, ctx);
    expect(past.ok).toBe(false);
    const garbage = await handlers(h).schedule_add({ name: 'n', prompt: 'p', at: '明天' }, ctx);
    expect(garbage.ok).toBe(false);
  });

  it('cron 接受五段式与中文短语', async () => {
    const h = harness([], at(9));
    const plain = await handlers(h).schedule_add(
      { name: 'n', prompt: 'p', cron: '0  10 * * *' },
      ctx
    );
    expect(plain.ok).toBe(true);
    const phrase = await handlers(h).schedule_add(
      { name: 'n', prompt: 'p', cron: '每天 10:30' },
      ctx
    );
    expect(phrase.ok).toBe(true);
    expect(h.state.schedules.map((schedule) => schedule.cron)).toEqual([
      '0 10 * * *',
      '30 10 * * *',
    ]);
  });

  it('永不触发的 cron 被拒绝', async () => {
    const h = harness([], at(9));
    const result = await handlers(h).schedule_add(
      { name: 'n', prompt: 'p', cron: '0 0 30 2 *' },
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it('写入后审计一行', async () => {
    const h = harness([], at(9));
    const added = await handlers(h).schedule_add(
      { name: '提醒', prompt: '看看', at: iso(at(10)) },
      ctx
    );
    expect(added.ok).toBe(true);
    expect(h.state.audit).toEqual([
      {
        at: at(9),
        secretaryConversationId: 'sec1',
        op: 'schedule_add',
        targetId: 'id-1',
        ok: true,
      },
    ]);
  });

  it('写入成功后推送一次面板刷新，失败不推送', async () => {
    const h = harness([], at(9));
    await handlers(h).schedule_add({ name: 'n', prompt: 'p', cron: '*/10 * * * *' }, ctx);
    expect(h.state.published).toBe(1);
    await handlers(h).schedule_add({ name: 'n', prompt: 'p', cron: '0 0 30 2 *' }, ctx);
    expect(h.state.published).toBe(1);
  });
});

describe('schedule_list 与 schedule_remove', () => {
  it('列出下一次触发时间', () => {
    const h = harness([once(), cron()], at(9));
    const list = listSchedules(h.ports);
    expect(list.map((entry) => [entry.id, entry.nextRunAt])).toEqual([
      ['s1', at(10)],
      ['s2', at(10)],
    ]);
  });

  it('删除用户条目并审计', () => {
    const h = harness([once()], at(9));
    const result = removeSchedule(h.ports, 's1', { secretaryConversationId: 'sec1' });
    expect(result).toEqual({ ok: true, result: { scheduleId: 's1', name: '提醒' } });
    expect(h.state.schedules).toEqual([]);
    expect(h.state.audit[0]).toMatchObject({ op: 'schedule_remove', ok: true, targetId: 's1' });
    expect(h.state.published).toBe(1);
  });

  it('拒绝删除系统条目', () => {
    const h = harness([{ ...cron({ id: DAILY_BRIEF_ID }), system: 'daily-brief' }], at(9));
    const result = removeSchedule(h.ports, DAILY_BRIEF_ID, { secretaryConversationId: 'sec1' });
    expect(result.ok).toBe(false);
    expect(h.state.schedules).toHaveLength(1);
    expect(h.state.audit[0]).toMatchObject({ op: 'schedule_remove', ok: false });
    expect(h.state.published).toBe(0);
  });

  it('删除不存在的条目报错并审计失败', () => {
    const h = harness([], at(9));
    const result = removeSchedule(h.ports, 'nope', { secretaryConversationId: 'sec1' });
    expect(result.ok).toBe(false);
    expect(h.state.audit[0]).toMatchObject({ op: 'schedule_remove', ok: false });
  });
});

describe('系统定时', () => {
  it('按每日简报时间生成一条 cron 定时', () => {
    const h = harness([], at(9));
    syncSystemSchedules(h.ports, profile({ dailyBriefAt: '08:30' }), []);
    expect(h.state.schedules).toEqual([
      expect.objectContaining({ id: DAILY_BRIEF_ID, cron: '30 8 * * *', system: 'daily-brief' }),
    ]);
  });

  it('关闭每日简报时删除该条目', () => {
    const h = harness([], at(9));
    syncSystemSchedules(h.ports, profile({ dailyBriefAt: '08:30' }), []);
    syncSystemSchedules(h.ports, profile(), []);
    expect(h.state.schedules).toEqual([]);
  });

  it('改时间时更新 cron 并保留创建时间', () => {
    const h = harness([], at(9));
    syncSystemSchedules(h.ports, profile({ dailyBriefAt: '08:30' }), []);
    const created = h.state.schedules[0].createdAt;
    h.state.now = at(9, 5);
    syncSystemSchedules(h.ports, profile({ dailyBriefAt: '09:30' }), []);
    expect(h.state.schedules[0]).toMatchObject({ cron: '30 9 * * *', createdAt: created });
  });

  it('为到期待办生成提醒，完成或删除后移除', () => {
    const h = harness([], at(9));
    syncSystemSchedules(h.ports, profile(), [todo({ dueAt: at(18) })]);
    expect(h.state.schedules).toEqual([
      expect.objectContaining({
        id: todoReminderId('t1'),
        at: iso(at(18)),
        system: { todoId: 't1' },
      }),
    ]);
    syncSystemSchedules(h.ports, profile(), [todo({ dueAt: at(18), doneAt: at(10) })]);
    expect(h.state.schedules).toEqual([]);
    syncSystemSchedules(h.ports, profile(), [todo({ dueAt: at(18) })]);
    syncSystemSchedules(h.ports, profile(), []);
    expect(h.state.schedules).toEqual([]);
  });

  it('改期时更新提醒时间', () => {
    const h = harness([], at(9));
    syncSystemSchedules(h.ports, profile(), [todo({ dueAt: at(18) })]);
    syncSystemSchedules(h.ports, profile(), [todo({ dueAt: at(20) })]);
    expect(h.state.schedules).toHaveLength(1);
    expect(h.state.schedules[0].at).toBe(iso(at(20)));
  });

  it('已经到期的待办不再生成提醒', () => {
    const h = harness([], at(19));
    syncSystemSchedules(h.ports, profile(), [todo({ dueAt: at(18) })]);
    expect(h.state.schedules).toEqual([]);
  });

  it('保留用户自己建的定时，没有变化时不写盘', () => {
    const h = harness([once()], at(9));
    syncSystemSchedules(h.ports, profile({ dailyBriefAt: '08:30' }), []);
    const saves = h.state.saves;
    const published = h.state.published;
    syncSystemSchedules(h.ports, profile({ dailyBriefAt: '08:30' }), []);
    expect(h.state.saves).toBe(saves);
    expect(h.state.published).toBe(published);
    expect(h.state.schedules.map((schedule) => schedule.id)).toEqual(['s1', DAILY_BRIEF_ID]);
  });

  it('系统定时有变化时推送面板刷新', () => {
    const h = harness([], at(9));
    syncSystemSchedules(h.ports, profile({ dailyBriefAt: '08:30' }), []);
    expect(h.state.published).toBe(1);
  });
});

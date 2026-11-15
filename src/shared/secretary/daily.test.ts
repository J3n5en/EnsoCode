import { describe, expect, it } from 'vitest';
import type {
  DispatchRecord,
  SecretaryAuditEntry,
  SecretaryDailyRecord,
  SecretaryTodo,
} from '../types/secretary';
import {
  buildSecretaryDaily,
  dayEnd,
  dayKey,
  dayStart,
  extractReportRefs,
  parseDayKey,
  shiftDay,
  summarize,
} from './daily';

const at = (day: number, hour: number, minute = 0): number =>
  new Date(2024, 4, day, hour, minute).getTime();

const record = (over: Partial<SecretaryDailyRecord> = {}): SecretaryDailyRecord => ({
  at: at(15, 10),
  conversationId: 'c1',
  kind: 'goal-complete',
  projectId: 'p1',
  title: '重构登录流程',
  text: '登录流程拆成三步，测试补齐。\nbranch: feat/login\ncommit: a1b2c3d4',
  ...over,
});

const dispatch = (over: Partial<DispatchRecord> = {}): DispatchRecord => ({
  conversationId: 'c1',
  projectId: 'p1',
  secretaryConversationId: 'sec',
  createdAt: at(15, 9),
  turn: 1,
  lastState: 'idle',
  lastEventAt: at(15, 9),
  ...over,
});

const todo = (over: Partial<SecretaryTodo> = {}): SecretaryTodo => ({
  id: 't1',
  text: '写周报',
  createdAt: at(15, 8),
  updatedAt: at(15, 8),
  ...over,
});

const audit = (over: Partial<SecretaryAuditEntry> = {}): SecretaryAuditEntry => ({
  at: at(15, 11),
  secretaryConversationId: 'sec',
  op: 'skill_save',
  targetId: 'deploy-check',
  ok: true,
  ...over,
});

describe('按本地时区切天', () => {
  it('同一本地日期的不同时刻归到同一天', () => {
    expect(dayKey(at(15, 0, 0))).toBe('2024-05-15');
    expect(dayKey(at(15, 23, 59))).toBe('2024-05-15');
  });

  it('零点前后分属两天', () => {
    expect(dayKey(at(15, 23, 59))).toBe('2024-05-15');
    expect(dayKey(at(16, 0, 0))).toBe('2024-05-16');
    expect(dayEnd('2024-05-15')).toBe(dayStart('2024-05-16'));
  });

  it('本地零点就是当天起点，不受 UTC 影响', () => {
    const start = new Date(dayStart('2024-05-15'));
    expect(start.getHours()).toBe(0);
    expect(start.getDate()).toBe(15);
  });

  it('前后挪一天跨月跨年跨闰日都对', () => {
    expect(shiftDay('2024-05-15', 1)).toBe('2024-05-16');
    expect(shiftDay('2024-05-31', 1)).toBe('2024-06-01');
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29');
    expect(shiftDay('2024-12-31', 1)).toBe('2025-01-01');
    expect(shiftDay('2025-01-01', -1)).toBe('2024-12-31');
  });

  it('只接受真实存在的 YYYY-MM-DD', () => {
    expect(parseDayKey('2024-05-15')).toBe('2024-05-15');
    expect(parseDayKey('2024-02-31')).toBeNull();
    expect(parseDayKey('2024-5-1')).toBeNull();
    expect(parseDayKey('')).toBeNull();
    expect(parseDayKey(20240515)).toBeNull();
  });
});

describe('从最终汇报里认分支与提交号', () => {
  it('带关键词的写法能认出来', () => {
    expect(extractReportRefs('已合并。branch: feat/login，commit: a1b2c3d')).toEqual({
      branch: 'feat/login',
      commit: 'a1b2c3d',
      merged: true,
    });
  });

  it('中文与反引号写法也认', () => {
    expect(extractReportRefs('分支 `fix/queue`，提交 `9f8e7d6c5b4a`')).toEqual({
      branch: 'fix/queue',
      commit: '9f8e7d6c5b4a',
    });
  });

  it('没有关键词就什么都不给，不猜裸哈希', () => {
    expect(extractReportRefs('顺手把 a1b2c3d4 提到前面，分支逻辑没动')).toEqual({});
    expect(extractReportRefs(undefined)).toEqual({});
    expect(extractReportRefs('')).toEqual({});
  });

  it('末尾标点不跟着分支名走', () => {
    expect(extractReportRefs('branch: feat/login.')).toEqual({ branch: 'feat/login' });
  });
});

describe('一句话摘要', () => {
  it('取第一行非空正文，过长截断', () => {
    expect(summarize('\n\n第一行\n第二行')).toBe('第一行');
    expect(summarize('x'.repeat(200))).toHaveLength(161);
    expect(summarize('   ')).toBeUndefined();
  });
});

describe('一天的看板投影', () => {
  const base = {
    day: '2024-05-15',
    now: at(15, 20),
    session: () => ({ title: '重构登录流程', projectName: 'enso-code' }),
    projectName: () => 'enso-code',
  };

  it('六个计数与分组只算当天', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [
        record({ at: at(15, 10), merged: true }),
        record({ at: at(15, 12), conversationId: 'c2', kind: 'failed', text: '测试挂了' }),
        record({ at: at(15, 13), conversationId: 'c3', kind: 'needs-user', text: '等你选方案' }),
        // 前一天的结果不进今天
        record({ at: at(14, 23, 59), conversationId: 'c4', kind: 'goal-complete' }),
      ],
      dispatched: [dispatch(), dispatch({ conversationId: 'c9', createdAt: at(14, 22) })],
      todos: [todo(), todo({ id: 't2', doneAt: at(15, 14) })],
      audit: [audit()],
    });
    expect(daily.today).toBe(true);
    expect(daily.counts).toEqual({
      dispatched: 1,
      completed: 1,
      failed: 1,
      needsYou: 1,
      todosDone: 1,
      merged: 1,
    });
    expect(daily.groups.map((group) => group.key)).toEqual([
      'needsYou',
      'done',
      'failed',
      'todos',
      'changes',
    ]);
  });

  it('空分组不返回，整天没动静就是空数组', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [],
      todos: [],
      audit: [],
    });
    expect(daily.groups).toEqual([]);
    expect(daily.counts.completed).toBe(0);
  });

  it('完成行带摘要、分支与提交号；认不出就不给字段', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [
        record({ at: at(15, 10), branch: 'feat/login', commit: 'a1b2c3d4' }),
        record({
          at: at(15, 11),
          conversationId: 'c2',
          text: '只改了样式',
        }),
      ],
      dispatched: [],
      todos: [],
      audit: [],
    });
    const [plain, withRefs] = daily.groups[0].items;
    expect(withRefs.summary).toBe('登录流程拆成三步，测试补齐。');
    expect(withRefs.detail).toContain('commit: a1b2c3d4');
    expect(withRefs.branch).toBe('feat/login');
    expect(withRefs.commit).toBe('a1b2c3d4');
    expect(plain).not.toHaveProperty('branch');
    expect(plain).not.toHaveProperty('commit');
  });

  it('同一会话同类结果只留最新一条', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [
        record({ at: at(15, 10), text: '第一次' }),
        record({ at: at(15, 12), text: '第二次' }),
      ],
      dispatched: [],
      todos: [],
      audit: [],
    });
    expect(daily.groups[0].items).toHaveLength(1);
    expect(daily.groups[0].items[0].summary).toBe('第二次');
  });

  it('接管来的会话当天没有结果就不上板，审计只认白名单里的成功操作', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [
        dispatch({ conversationId: 'c5', takeover: { grantedAt: at(15, 9), via: 'user' } }),
      ],
      todos: [],
      audit: [
        audit({ op: 'takeover_grant', targetId: 'c5' }),
        audit({ op: 'session_send', targetId: 'c5' }),
        audit({ op: 'skill_delete', targetId: 'old', ok: false }),
      ],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['changes']);
    expect(daily.groups[0].items.map((item) => item.label)).toEqual(['Takeover granted']);
    expect(daily.groups[0].items[0].title).toBe('重构登录流程');
  });

  it('同一待办的新增与完成合并成一张卡，两个时间都挂在卡上', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [],
      todos: [todo({ id: 't3', createdAt: at(15, 8), doneAt: at(15, 13) })],
      audit: [],
    });
    const items = daily.groups.find((group) => group.key === 'todos')?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'todo:t3',
      at: at(15, 13),
      title: '写周报',
      label: 'Done',
      addedAt: at(15, 8),
      doneAt: at(15, 13),
    });
    expect(daily.counts.todosDone).toBe(1);
  });

  it('待办只新增、只完成、两者都有时字段与文案各不相同', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [],
      todos: [
        todo({ id: 'only-add', createdAt: at(15, 8) }),
        todo({ id: 'only-done', createdAt: at(14, 8), doneAt: at(15, 9) }),
        todo({ id: 'both', createdAt: at(15, 10), doneAt: at(15, 11) }),
        // 前一天新增、还没完成：今天不上板
        todo({ id: 'stale', createdAt: at(14, 8) }),
      ],
      audit: [],
    });
    const items = daily.groups.find((group) => group.key === 'todos')?.items ?? [];
    expect(items.map((item) => item.id)).toEqual(['todo:both', 'todo:only-done', 'todo:only-add']);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get('todo:only-add')).toMatchObject({
      label: 'Added',
      at: at(15, 8),
      addedAt: at(15, 8),
    });
    expect(byId.get('todo:only-add')?.doneAt).toBeUndefined();
    expect(byId.get('todo:only-done')).toMatchObject({
      label: 'Done',
      at: at(15, 9),
      doneAt: at(15, 9),
    });
    expect(byId.get('todo:only-done')?.addedAt).toBeUndefined();
    expect(byId.get('todo:both')).toMatchObject({ addedAt: at(15, 10), doneAt: at(15, 11) });
    expect(daily.counts.todosDone).toBe(2);
  });

  it('同一个提案的提交与确认只出一张卡，同一天重复保存同一对象也合并', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [],
      todos: [],
      audit: [
        // 提案提交不在白名单里，本来就不上板
        audit({ at: at(15, 9), op: 'secretary_skill_propose', targetId: 'deploy-check' }),
        audit({ at: at(15, 10), op: 'skill_save', targetId: 'deploy-check' }),
        audit({ at: at(15, 14), op: 'skill_save', targetId: 'deploy-check' }),
        audit({ at: at(15, 11), op: 'skill_save', targetId: 'other' }),
      ],
    });
    const items = daily.groups.find((group) => group.key === 'changes')?.items ?? [];
    expect(items.map((item) => item.id)).toEqual([
      'audit:skill_save:deploy-check',
      'audit:skill_save:other',
    ]);
    // 留最后一次的时间
    expect(items[0].at).toBe(at(15, 14));
  });

  it('一个会话当天只出一张卡，多条结果与派出记录都不重复', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [
        record({ at: at(15, 10), kind: 'needs-user' }),
        record({ at: at(15, 12), kind: 'goal-complete' }),
      ],
      dispatched: [dispatch({ createdAt: at(15, 8) })],
      todos: [],
      audit: [],
    });
    const all = daily.groups.flatMap((group) => group.items);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('session:c1');
    expect(all[0].dispatchedAt).toBe(at(15, 8));
    expect(daily.groups.map((group) => group.key)).toEqual(['done']);
  });

  it('会话标题取不到时退回派发记录里的目标', () => {
    const daily = buildSecretaryDaily({
      ...base,
      session: () => ({}),
      results: [],
      dispatched: [dispatch({ goal: '重构登录流程' })],
      todos: [],
      audit: [],
    });
    expect(daily.groups.find((group) => group.key === 'running')?.items[0].title).toBe(
      '重构登录流程'
    );
  });

  it('看历史日期时 today 为 false', () => {
    const daily = buildSecretaryDaily({
      ...base,
      day: '2024-05-14',
      results: [],
      dispatched: [],
      todos: [],
      audit: [],
    });
    expect(daily.today).toBe(false);
  });

  it('同一会话当天派出又完成，只在「完成」列出现一次', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [record({ at: at(15, 10) })],
      dispatched: [dispatch({ createdAt: at(15, 9) })],
      todos: [],
      audit: [],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['done']);
    expect(daily.groups[0].items).toHaveLength(1);
    expect(daily.groups[0].items[0]).toMatchObject({
      conversationId: 'c1',
      at: at(15, 10),
      dispatchedAt: at(15, 9),
    });
    expect(daily.counts.dispatched).toBe(1);
  });

  it('同一会话当天多条结果只留最后一条，按最终状态归列', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [
        record({ at: at(15, 10), kind: 'needs-user' }),
        record({ at: at(15, 20), kind: 'goal-complete' }),
      ],
      dispatched: [dispatch({ createdAt: at(15, 9) })],
      todos: [],
      audit: [],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['done']);
    expect(daily.groups[0].items[0].at).toBe(at(15, 20));
  });

  it('结果日志缺记录时用派发记录的 lastResult 兜底', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [
        dispatch({
          createdAt: at(15, 9),
          lastResult: { kind: 'goal-complete', turn: 1, at: at(15, 18) },
        }),
      ],
      todos: [],
      audit: [],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['done']);
    expect(daily.groups[0].items[0]).toMatchObject({
      conversationId: 'c1',
      at: at(15, 18),
      label: 'Goal complete',
    });
    // 兜底只有结果类型与时间，没有原文就没有摘要与分支
    expect(daily.groups[0].items[0]).not.toHaveProperty('summary');
  });

  it('结果日志有记录时优先用它，不被 lastResult 覆盖', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [record({ at: at(15, 10) })],
      dispatched: [
        dispatch({
          createdAt: at(15, 9),
          lastResult: { kind: 'failed', turn: 2, at: at(15, 12) },
        }),
      ],
      todos: [],
      audit: [],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['done']);
  });

  it('历史日期按当天结束时的状态归列', () => {
    const daily = buildSecretaryDaily({
      ...base,
      day: '2024-05-14',
      results: [
        record({ at: at(14, 10), kind: 'goal-complete' }),
        record({ at: at(14, 11), conversationId: 'c2', kind: 'failed' }),
        // 15 号的结果不算 14 号
        record({ at: at(15, 1), conversationId: 'c3', kind: 'goal-complete' }),
      ],
      dispatched: [
        dispatch({ createdAt: at(14, 9) }),
        dispatch({ conversationId: 'c2', createdAt: at(14, 9) }),
        // 14 号派出、当天没有终态：那天结束时还没收口
        dispatch({ conversationId: 'c4', createdAt: at(14, 12) }),
      ],
      todos: [],
      audit: [],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['running', 'done', 'failed']);
    expect(daily.groups[0].items.map((item) => item.conversationId)).toEqual(['c4']);
    expect(daily.groups[1].items.map((item) => item.conversationId)).toEqual(['c1']);
    expect(daily.groups[2].items.map((item) => item.conversationId)).toEqual(['c2']);
    expect(daily.today).toBe(false);
  });

  it('今天还在跑的会话进「进行中」，派出数量进计数', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [
        dispatch(),
        dispatch({ conversationId: 'c7', lastState: 'running' }),
        dispatch({ conversationId: 'c8', lastState: 'idle', backgroundRunning: true }),
      ],
      todos: [],
      audit: [],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['running']);
    expect(daily.groups[0].items).toHaveLength(3);
    expect(daily.counts.dispatched).toBe(3);
  });

  it('报过结果、这一轮又没给新结果的会话进「完成」，不再挂在进行中', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [
        // 被重新唤起后以 turn-ended 收尾：没有终态结果，但活已经干完
        dispatch({ lastResult: { kind: 'turn-ended', turn: 2, at: at(15, 10) } }),
        // 前一天完成过、今天又跑了一轮没给结果
        dispatch({
          conversationId: 'c9',
          lastResult: { kind: 'goal-complete', turn: 1, at: at(14, 10) },
        }),
      ],
      todos: [],
      audit: [],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['done']);
    expect(daily.groups[0].items.map((item) => item.conversationId)).toEqual(['c1', 'c9']);
  });

  it('派发会话的卡片带 tracked，手动标记完成的带 manual', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [
        dispatch({
          lastResult: { kind: 'goal-complete', turn: 2, at: at(15, 10), manual: true },
        }),
      ],
      todos: [],
      audit: [],
    });
    expect(daily.groups[0].items[0]).toMatchObject({
      tracked: true,
      manual: true,
      label: 'Goal complete',
    });
  });
});

describe('已完成但还有遗留后台任务', () => {
  const base = {
    day: '2024-05-15',
    now: at(15, 20),
    session: () => ({ title: '看图与收尾清理', projectName: 'enso-code' }),
    projectName: () => 'enso-code',
  };

  it('常驻服务不再挂在进行中，完成卡标出遗留任务数', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [
        dispatch({
          lastState: 'idle',
          lastResult: { kind: 'goal-complete', turn: 1, at: at(15, 10) },
          backgroundPersistent: true,
          leftoverTasks: {
            count: 2,
            commands: ['python3 -m http.server 8931', 'pnpm typecheck && pnpm test'],
            taskIds: ['t1', 't2'],
            at: at(15, 19),
          },
        }),
      ],
      todos: [],
      audit: [],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['done']);
    expect(daily.groups[0].items[0]).toMatchObject({
      conversationId: 'c1',
      leftover: { count: 2 },
    });
  });

  it('还有普通后台任务的空闲会话仍算进行中，不标遗留', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [dispatch({ lastState: 'idle', backgroundRunning: true })],
      todos: [],
      audit: [],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['running']);
    expect(daily.groups[0].items[0]?.leftover).toBeUndefined();
  });

  it('残留的 running 也不把遗留会话挂回进行中', () => {
    const daily = buildSecretaryDaily({
      ...base,
      results: [],
      dispatched: [
        dispatch({
          lastState: 'running',
          lastResult: { kind: 'turn-ended', turn: 2, at: at(15, 10) },
          leftoverTasks: {
            count: 1,
            commands: ['pnpm typecheck && pnpm test'],
            taskIds: ['t1'],
            at: at(15, 19),
          },
        }),
      ],
      todos: [],
      audit: [],
    });
    expect(daily.groups.map((group) => group.key)).toEqual(['done']);
    expect(daily.groups[0].items[0]).toMatchObject({ leftover: { count: 1 } });
  });
});

describe('还在跑但带着常驻服务', () => {
  it('进行中的卡片标出常驻服务', () => {
    const daily = buildSecretaryDaily({
      day: '2024-05-15',
      now: at(15, 20),
      session: () => ({ title: '起服务调试' }),
      projectName: () => 'enso-code',
      results: [],
      dispatched: [
        dispatch({ lastState: 'running', backgroundRunning: true, backgroundPersistent: true }),
      ],
      todos: [],
      audit: [],
    });
    expect(daily.groups[0].items[0]).toMatchObject({ persistent: true });
  });
});

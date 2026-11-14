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
      'done',
      'failed',
      'needsYou',
      'dispatched',
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

  it('接管来的会话不算新派出，审计只认白名单里的成功操作', () => {
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

  it('待办新增与完成各占一行，项目名与会话标题取不到时退回记录里的快照', () => {
    const daily = buildSecretaryDaily({
      ...base,
      session: () => ({}),
      results: [record({ at: at(15, 10) })],
      dispatched: [dispatch({ goal: '重构登录流程' })],
      todos: [todo({ id: 't3', doneAt: at(15, 15) })],
      audit: [],
    });
    expect(daily.groups.find((group) => group.key === 'todos')?.items).toHaveLength(2);
    expect(daily.groups.find((group) => group.key === 'done')?.items[0].title).toBe('重构登录流程');
    expect(daily.groups.find((group) => group.key === 'dispatched')?.items[0].title).toBe(
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
});

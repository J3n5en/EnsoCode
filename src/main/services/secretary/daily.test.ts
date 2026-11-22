import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectAuthority } from '@shared/types/agent';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryTodo,
} from '@shared/types/secretary';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDaily, parseDailyRequest, type SecretaryDailyPorts } from './daily';
import { appendDailyRecord } from './dailyLog';

const at = (day: number, hour: number, minute = 0): number =>
  new Date(2024, 4, day, hour, minute).getTime();

const dispatchFile = (over: Partial<SecretaryDispatchFile> = {}): SecretaryDispatchFile => ({
  version: 1,
  dispatched: {},
  named: [],
  proposals: {},
  outbox: [],
  ...over,
});

let dir: string;

function ports(over: Partial<SecretaryDailyPorts> = {}): SecretaryDailyPorts {
  const file = dispatchFile();
  const todos: SecretaryTodo[] = [];
  return {
    dir: () => dir,
    dispatchFile: () => file,
    todos: () => todos,
    rows: () => ({
      c1: { id: 'c1', title: '重构登录流程', projectId: 'p1' },
      c2: { id: 'c2', title: '修队列', projectId: 'p1' },
    }),
    projects: () => [
      { projectId: 'p1', canonicalPath: '/tmp/enso-code' } as unknown as ProjectAuthority,
    ],
    now: () => at(15, 20),
    ...over,
  };
}

function writeAudit(entries: SecretaryAuditEntry[]): void {
  writeFileSync(
    join(dir, 'audit.jsonl'),
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    'utf8'
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-daily-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseDailyRequest', () => {
  it('缺省是今天，非法日期当场拒绝', () => {
    expect(parseDailyRequest(undefined, at(15, 10))).toBe('2024-05-15');
    expect(parseDailyRequest({}, at(15, 10))).toBe('2024-05-15');
    expect(parseDailyRequest({ day: '2024-05-14' }, at(15, 10))).toBe('2024-05-14');
    expect(parseDailyRequest({ day: '2024-02-31' }, at(15, 10))).toBeNull();
    expect(parseDailyRequest({ day: 20240515 }, at(15, 10))).toBeNull();
    expect(parseDailyRequest('2024-05-15', at(15, 10))).toBeNull();
  });
});

describe('buildDaily', () => {
  it('结果来自 daily.jsonl，标题与项目名取会话行', async () => {
    appendDailyRecord(dir, {
      at: at(15, 10),
      conversationId: 'c1',
      kind: 'goal-complete',
      projectId: 'p1',
      title: '重构登录流程',
      text: '登录流程拆成三步',
      branch: 'feat/login',
      commit: 'a1b2c3d4',
      merged: true,
    });
    // 前一天的结果不进今天
    appendDailyRecord(dir, {
      at: at(14, 10),
      conversationId: 'c2',
      kind: 'failed',
      projectId: 'p1',
    });
    const daily = await buildDaily(ports(), '2024-05-15');
    expect(daily.counts).toEqual({
      dispatched: 0,
      completed: 1,
      failed: 0,
      needsYou: 0,
      todosDone: 0,
      merged: 1,
    });
    const done = daily.groups.find((group) => group.key === 'done');
    expect(done?.items[0]).toMatchObject({
      title: '重构登录流程',
      projectName: 'enso-code',
      branch: 'feat/login',
      commit: 'a1b2c3d4',
      summary: '登录流程拆成三步',
      conversationId: 'c1',
    });
    expect(daily.earliest).toBe('2024-05-14');
  });

  it('有别名时日报项目名用别名', async () => {
    appendDailyRecord(dir, {
      at: at(15, 10),
      conversationId: 'c1',
      kind: 'goal-complete',
      projectId: 'p1',
      title: '重构登录流程',
      text: '登录流程拆成三步',
    });
    const daily = await buildDaily(
      ports({ projectAliases: () => ({ p1: '官网前端' }) }),
      '2024-05-15'
    );
    expect(daily.groups.find((group) => group.key === 'done')?.items[0]).toMatchObject({
      projectName: '官网前端',
    });
  });

  it('派发记录按当天状态归列，待办给新增与完成', async () => {
    const file = dispatchFile({
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 'sec',
          createdAt: at(15, 9),
          turn: 0,
          lastState: 'idle',
          lastEventAt: at(15, 9),
        },
      },
    });
    const daily = await buildDaily(
      ports({
        dispatchFile: () => file,
        todos: () => [
          { id: 't1', text: '写周报', createdAt: at(15, 8), updatedAt: at(15, 8) },
          {
            id: 't2',
            text: '补测试',
            createdAt: at(14, 8),
            updatedAt: at(15, 16),
            doneAt: at(15, 16),
          },
        ],
      }),
      '2024-05-15'
    );
    expect(daily.counts.dispatched).toBe(1);
    expect(daily.counts.todosDone).toBe(1);
    // 当天派出、还没有终态结果：落在「进行中」
    expect(daily.groups.find((group) => group.key === 'running')?.items[0].title).toBe(
      '重构登录流程'
    );
    const todos = daily.groups.find((group) => group.key === 'todos')?.items ?? [];
    expect(todos.map((item) => `${item.label}:${item.title}`)).toEqual([
      'Done:补测试',
      'Added:写周报',
    ]);
  });

  it('设置与能力变更从审计取，只认白名单里的成功操作', async () => {
    writeAudit([
      {
        at: at(15, 11),
        secretaryConversationId: 'sec',
        op: 'skill_save',
        targetId: 'deploy',
        ok: true,
      },
      {
        at: at(15, 12),
        secretaryConversationId: 'sec',
        op: 'tool_delete',
        targetId: 'old',
        ok: true,
      },
      {
        at: at(15, 13),
        secretaryConversationId: 'sec',
        op: 'skill_delete',
        targetId: 'x',
        ok: false,
      },
      {
        at: at(15, 14),
        secretaryConversationId: 'sec',
        op: 'session_send',
        targetId: 'c1',
        ok: true,
      },
      {
        at: at(15, 15),
        secretaryConversationId: 'sec',
        op: 'takeover_grant',
        targetId: 'c2',
        ok: true,
      },
    ]);
    const daily = await buildDaily(ports(), '2024-05-15');
    const changes = daily.groups.find((group) => group.key === 'changes')?.items ?? [];
    expect(changes.map((item) => item.label)).toEqual([
      'Takeover granted',
      'Tool deleted',
      'Skill saved',
    ]);
    expect(changes[0].title).toBe('修队列');
  });

  it('activity 只有 400 条也不影响回看：结果另存一份', async () => {
    // dispatch.json 里的动态早就被挤掉了，看板仍能从那天的结果记录里取到
    const file = dispatchFile({
      activity: Array.from({ length: 400 }, (_, index) => ({
        at: at(15, 18) + index,
        conversationId: 'c9',
        kind: 'seen' as const,
        text: '秘书已查看',
      })),
    });
    appendDailyRecord(dir, {
      at: at(15, 10),
      conversationId: 'c1',
      kind: 'goal-complete',
      projectId: 'p1',
      title: '重构登录流程',
    });
    const daily = await buildDaily(ports({ dispatchFile: () => file }), '2024-05-15');
    expect(daily.counts.completed).toBe(1);
  });

  it('当天没有任何记录就是空看板', async () => {
    const daily = await buildDaily(ports(), '2024-05-15');
    expect(daily.groups).toEqual([]);
    expect(daily.earliest).toBeUndefined();
    expect(daily.today).toBe(true);
    expect(daily.retentionDays).toBeGreaterThan(0);
  });
});

import type { FeedCursor, FeedQuery } from '@shared/secretary/feed';
import type {
  SecretaryBoard,
  SecretaryCard,
  SecretaryDaily,
  SecretaryScheduleView,
} from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { createContactCommands } from './commands';

const NOW = new Date(2026, 4, 20, 12, 0, 0).getTime();

function sessionCard(patch: Partial<Extract<SecretaryCard, { kind: 'session' }>> = {}) {
  return {
    kind: 'session' as const,
    conversationId: 'c1',
    projectId: 'p1',
    projectName: 'demo',
    title: '修登录',
    state: 'running' as const,
    startedAt: NOW - 10 * 60_000,
    stateSince: NOW - 3 * 60_000,
    secretaryConversationId: 'sec-1',
    lastText: '正在跑测试',
    ...patch,
  };
}

function board(patch: Partial<SecretaryBoard> = {}): SecretaryBoard {
  return {
    running: [sessionCard()],
    needsYou: [
      sessionCard({
        conversationId: 'c2',
        title: '部署',
        projectName: 'api',
        state: 'waiting',
        lastText: undefined,
      }),
    ],
    done: [],
    todos: [
      { id: 't1', text: '写文档', createdAt: NOW, updatedAt: NOW, phase: 'todo' },
      {
        id: 't2',
        text: '修登录',
        createdAt: NOW,
        updatedAt: NOW,
        phase: 'active',
        projectName: 'demo',
      },
    ],
    ...patch,
  };
}

function daily(day: string): SecretaryDaily {
  return {
    day,
    today: day === '2026-05-20',
    counts: { dispatched: 2, completed: 1, failed: 0, needsYou: 1, todosDone: 0, merged: 0 },
    groups: [
      {
        key: 'done',
        items: [{ id: 's1', at: NOW, title: '修登录', conversationId: 'c1' }],
      },
    ],
    retentionDays: 180,
  };
}

const EVENTS = Array.from({ length: 12 }, (_, index) => ({
  id: `e${index}`,
  at: NOW - index * 60_000,
  title: `会话 ${index}`,
  projectName: 'demo',
  label: 'Started',
  conversationId: `c${index}`,
}));

function harness(
  options: {
    allowMemory?: boolean;
    memories?: { titles: string[]; total: number };
    schedules?: (SecretaryScheduleView & { human?: string })[];
  } = {}
) {
  const calls = { daily: [] as string[], feed: [] as FeedQuery[] };
  const commands = createContactCommands({
    lang: () => 'zh',
    now: () => NOW,
    allowMemory: () => options.allowMemory === true,
    board: async () => board(),
    daily: async (day) => {
      calls.daily.push(day);
      return daily(day);
    },
    feed: async (query) => {
      calls.feed.push(query);
      const before = query.before;
      const rest = before
        ? EVENTS.filter(
            (event) => event.at < before.at || (event.at === before.at && event.id > before.id)
          )
        : EVENTS;
      const page = rest.slice(0, query.limit ?? 10);
      return { events: page, hasMore: rest.length > page.length };
    },
    schedules: async () =>
      options.schedules ?? [
        {
          id: 's1',
          name: '每日简报',
          prompt: 'x',
          cron: '0 9 * * *',
          nextRunAt: new Date(2026, 4, 21, 9, 0).getTime(),
        },
      ],
    memories: async () => options.memories ?? { titles: ['部署窗口'], total: 1 },
  });
  return { commands, calls };
}

describe('只读命令：取数与面板一致', () => {
  it('/status 用工作台的 running 与 needsYou，带徽标与深链', async () => {
    const { commands } = harness();
    const reply = await commands.run('status', '');
    expect(reply.text).toContain('进行中 1');
    expect(reply.text).toContain('需要你处理 1');
    expect(reply.text).toContain('修登录');
    expect(reply.text).toContain('运行中 · 3 分钟');
    expect(reply.text).toContain('等你回答');
    expect(reply.text).toContain('enso://secretary?conversation=c1');
    expect(reply.text).toContain('enso://secretary?conversation=c2');
  });

  it('/todo 用工作台的待办与阶段', async () => {
    const { commands } = harness();
    const reply = await commands.run('todo', '');
    expect(reply.text).toContain('进行中 1');
    expect(reply.text).toContain('待办 1');
    expect(reply.text).toContain('▸ 修登录 · demo');
    expect(reply.text).toContain('▸ 写文档');
  });

  it('/board 默认今天，带日期就用那一天', async () => {
    const { commands, calls } = harness();
    await commands.run('board', '');
    expect(calls.daily).toEqual(['2026-05-20']);
    const reply = await commands.run('board', '2026-01-02');
    expect(calls.daily).toEqual(['2026-05-20', '2026-01-02']);
    expect(reply.text).toContain('2026-01-02');
  });

  it('/board 日期写错只提示，不去查数据', async () => {
    const { commands, calls } = harness();
    const reply = await commands.run('board', '2026-02-31');
    expect(calls.daily).toEqual([]);
    expect(reply.text).toContain('日期看不懂');
  });

  it('/feed 一次 10 条，给出下一页游标', async () => {
    const { commands, calls } = harness();
    const reply = await commands.run('feed', '');
    expect(calls.feed).toEqual([{ limit: 10 }]);
    expect(reply.text).toContain('会话 0');
    expect(reply.text).not.toContain('会话 10');
    expect(reply.next).toEqual({ at: EVENTS[9]?.at, id: 'e9' });
  });

  it('/feed 翻页：带游标取更早的一页，到底就没有按钮了', async () => {
    const { commands, calls } = harness();
    const first = await commands.run('feed', '');
    const older = await commands.feedPage(first.next as FeedCursor);
    expect(calls.feed[1]).toEqual({ before: first.next, limit: 10 });
    expect(older.text).toContain('会话 10');
    expect(older.next).toBeUndefined();
  });

  it('/schedules 用人话周期与下次运行时间', async () => {
    const { commands } = harness();
    const reply = await commands.run('schedules', '');
    expect(reply.text).toContain('每日简报 · 每天 09:00 · 下次 05-21 09:00');
  });

  it('/memory 默认关闭，打开后只给标题', async () => {
    const closed = await harness().commands.run('memory', '');
    expect(closed.text).toContain('默认不在 Telegram 显示');

    const open = await harness({
      allowMemory: true,
      memories: { titles: ['部署窗口'], total: 3 },
    }).commands.run('memory', '');
    expect(open.text).toContain('秘书记得 3');
    expect(open.text).toContain('▸ 部署窗口');
    expect(open.text).toContain('…还有 2 条');
  });

  it('/help 列命令；记忆没开时不出现 /memory', async () => {
    const closed = await harness().commands.run('help', '');
    expect(closed.text).toContain('/status');
    expect(closed.text).not.toContain('/memory');
    const open = await harness({ allowMemory: true }).commands.run('help', '');
    expect(open.text).toContain('/memory');
  });

  it('内容再多也不超过一条消息的上限', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: `e${index}`,
      at: NOW - index * 60_000,
      title: `会话 ${index}`,
      projectName: 'demo',
      label: 'Started',
      detail:
        '这一条动态带一句不短的进度说明，用来把消息撑到上限以上；再补几个字让它确实超出去，别刚好卡在边上',
    }));
    const commands = createContactCommands({
      lang: () => 'zh',
      now: () => NOW,
      allowMemory: () => false,
      board: async () => board(),
      daily: async (day) => daily(day),
      feed: async () => ({ events: many, hasMore: true }),
      schedules: async () => [],
      memories: async () => ({ titles: [], total: 0 }),
    });
    const reply = await commands.run('feed', '');
    expect(reply.text.length).toBeLessThanOrEqual(3900);
    expect(reply.text).toMatch(/…还有 \d+ 行没显示/u);
  });
});

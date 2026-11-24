import { describe, expect, it } from 'vitest';
import type { SecretaryDaily, SecretaryScheduleView } from '../types/secretary';
import {
  badgeText,
  botCommands,
  commandListText,
  escapeHtml,
  fitLines,
  formatBoardMessage,
  formatElapsed,
  formatFeedMessage,
  formatFollowingMessage,
  formatMemoryMessage,
  formatSchedulesMessage,
  formatStatusMessage,
  formatTodoMessage,
  parseBoardDay,
  parseContactCommand,
  parseFollowingArg,
  sessionBadge,
} from './commands';
import { CONTACT_OUTBOUND_MAX_CHARS } from './contact';

const NOW = new Date(2026, 4, 20, 12, 0, 0).getTime();

describe('命令解析', () => {
  it('认小写命令名，带参数也认', () => {
    expect(parseContactCommand('/status')).toEqual({ name: 'status', arg: '' });
    expect(parseContactCommand('/board 2026-05-20')).toEqual({
      name: 'board',
      arg: '2026-05-20',
    });
  });

  it('群里带 @botname 后缀也能认', () => {
    expect(parseContactCommand('/feed@enso_bot')).toEqual({ name: 'feed', arg: '' });
  });

  it('/start 当成 /help：绑定完再发一次就是看清单', () => {
    expect(parseContactCommand('/start')).toEqual({ name: 'help', arg: '' });
  });

  it('不认识的一律 null，普通消息不会被当命令', () => {
    expect(parseContactCommand('/deploy')).toBeNull();
    expect(parseContactCommand('status')).toBeNull();
    expect(parseContactCommand('在吗')).toBeNull();
  });

  it('setMyCommands 用不带斜杠的命令名与中文描述', () => {
    const commands = botCommands();
    expect(commands.map((entry) => entry.command)).toEqual([
      'status',
      'board',
      'feed',
      'todo',
      'schedules',
      'following',
      'last',
      'sync',
      'memory',
      'help',
    ]);
    expect(commands.every((entry) => /^[a-z]+$/u.test(entry.command))).toBe(true);
    expect(commands[0]?.description).toContain('进行中');
  });
});

describe('/following', () => {
  it('参数：不带是列表，clear 全清，cancel <序号> 取消一项', () => {
    expect(parseFollowingArg('')).toEqual({ action: 'list' });
    expect(parseFollowingArg('clear')).toEqual({ action: 'clear' });
    expect(parseFollowingArg('全清')).toEqual({ action: 'clear' });
    expect(parseFollowingArg('cancel 2')).toEqual({ action: 'cancel', index: 2 });
    expect(parseFollowingArg('取消 #3')).toEqual({ action: 'cancel', index: 3 });
    expect(parseFollowingArg('cancel 0')).toBeNull();
    expect(parseFollowingArg('随便')).toBeNull();
  });

  it('列表按序号列摘要，序号与按钮一致', () => {
    const text = formatFollowingMessage('zh', {
      items: [
        { id: 'session:c1', kind: 'session', summary: 'apple-table 加 Score 字段', at: NOW },
        { id: 'schedule:sch1', kind: 'schedule', summary: '每天早上看 CI', at: NOW },
      ],
      now: NOW,
    });
    expect(text).toContain('手机关注 2');
    expect(text).toContain('1. ▸ 会话 · apple-table 加 Score 字段');
    expect(text).toContain('2. ▸ 定时 · 每天早上看 CI');
    expect(text).toContain('/following clear 全清');
  });

  it('一条都没有时说清怎么才会有', () => {
    const text = formatFollowingMessage('zh', { items: [], now: NOW });
    expect(text).toContain('还没有关注的任务');
    expect(formatFollowingMessage('en', { items: [], now: NOW })).toContain('Nothing is followed');
  });
});

describe('转义与长度', () => {
  it('HTML 模式只转义三个实体，正文里的尖括号不会破格式', () => {
    expect(escapeHtml('a <b> & c > d')).toBe('a &lt;b&gt; &amp; c &gt; d');
  });

  it('超长时整行丢弃，末尾说明还有多少行，不会切坏标签', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `<b>第 ${index} 行</b> 一些内容`);
    const text = fitLines(lines, 'zh');
    expect(text.length).toBeLessThanOrEqual(CONTACT_OUTBOUND_MAX_CHARS);
    expect(text).toMatch(/…还有 \d+ 行没显示$/u);
    expect(text.startsWith('<b>第 0 行</b>')).toBe(true);
  });

  it('放得下就原样返回', () => {
    expect(fitLines(['a', 'b'], 'zh')).toBe('a\nb');
  });

  it('跑了多久：分钟、小时、天', () => {
    expect(formatElapsed(20_000, 'zh')).toBe('刚刚');
    expect(formatElapsed(3 * 60_000, 'zh')).toBe('3 分钟');
    expect(formatElapsed(125 * 60_000, 'zh')).toBe('2 小时 5 分');
    expect(formatElapsed(3 * 24 * 60 * 60_000, 'zh')).toBe('3 天');
  });
});

describe('/board 的日期参数', () => {
  it('不给就是今天', () => {
    expect(parseBoardDay('', NOW)).toBe('2026-05-20');
  });

  it('yesterday / 昨天 都认', () => {
    expect(parseBoardDay('yesterday', NOW)).toBe('2026-05-19');
    expect(parseBoardDay('昨天', NOW)).toBe('2026-05-19');
  });

  it('YYYY-MM-DD 原样用，不存在的日期不认', () => {
    expect(parseBoardDay('2026-01-02', NOW)).toBe('2026-01-02');
    expect(parseBoardDay('2026-02-31', NOW)).toBeNull();
    expect(parseBoardDay('上周', NOW)).toBeNull();
  });
});

describe('/status', () => {
  const running = {
    title: '修登录',
    projectName: 'demo',
    badge: 'running' as const,
    since: NOW - 3 * 60_000,
    lastText: '正在跑测试 <ok>',
    conversationId: 'c1',
  };
  const needsYou = {
    title: '部署',
    projectName: 'api',
    badge: 'waiting' as const,
    since: NOW - 5 * 60_000,
    conversationId: 'c2',
  };

  it('两块分开，每行带徽标、时长、最后一句与深链', () => {
    const text = formatStatusMessage('zh', { running: [running], needsYou: [needsYou], now: NOW });
    expect(text).toContain('进行中 1');
    expect(text).toContain('需要你处理 1');
    expect(text).toContain('修登录');
    expect(text).toContain('demo');
    expect(text).toContain('运行中 · 3 分钟');
    expect(text).toContain('正在跑测试 &lt;ok&gt;');
    expect(text).toContain('enso://secretary?conversation=c1');
    expect(text).toContain('等你回答 · 5 分钟');
  });

  it('都没有时给一句话，不留空标题', () => {
    expect(formatStatusMessage('zh', { running: [], needsYou: [], now: NOW })).toBe(
      '现在没有在跑的会话，也没有等你处理的。'
    );
  });
});

describe('/board', () => {
  const daily: SecretaryDaily = {
    day: '2026-05-20',
    today: true,
    counts: {
      dispatched: 3,
      completed: 2,
      completedEarlier: 0,
      failed: 1,
      needsYou: 1,
      todosDone: 0,
      merged: 0,
    },
    groups: [
      {
        key: 'done',
        items: [
          { id: 's1', at: NOW, title: '修登录', projectName: 'demo', conversationId: 'c1' },
          { id: 's2', at: NOW, title: '写文档' },
        ],
      },
    ],
    retentionDays: 180,
  };

  it('开头一行统计，后面按列列标题', () => {
    const text = formatBoardMessage('zh', daily);
    expect(text.split('\n')[0]).toBe('<b>2026-05-20（今天）</b>');
    expect(text).toContain('派出 3 · 完成 2 · 失败 1 · 需要你 1');
    expect(text).toContain('<b>完成 2</b>');
    expect(text).toContain('enso://secretary?conversation=c1');
    expect(text).toContain('▸ 写文档');
  });

  it('完成里有之前派出或接手的，统计行注明，不和派出数矛盾', () => {
    const mixed = { ...daily, counts: { ...daily.counts, completedEarlier: 1 } };
    expect(formatBoardMessage('zh', mixed)).toContain(
      '派出 3 · 完成 2（含之前派出或接手的 1） · 失败 1 · 需要你 1'
    );
    expect(formatBoardMessage('en', mixed)).toContain(
      'dispatched 3 · done 2 (1 earlier or taken over) · failed 1 · needs you 1'
    );
  });

  it('一列太长就截断并说明还有几条', () => {
    const many: SecretaryDaily = {
      ...daily,
      groups: [
        {
          key: 'done',
          items: Array.from({ length: 12 }, (_, index) => ({
            id: `s${index}`,
            at: NOW,
            title: `会话 ${index}`,
          })),
        },
      ],
    };
    const text = formatBoardMessage('zh', many, { perGroup: 3 });
    expect(text).toContain('▸ 会话 2');
    expect(text).not.toContain('▸ 会话 3');
    expect(text).toContain('…还有 9 条');
  });

  it('没有记录就说没有', () => {
    const empty: SecretaryDaily = {
      ...daily,
      groups: [],
      counts: { ...daily.counts, dispatched: 0 },
    };
    expect(formatBoardMessage('zh', empty)).toContain('这一天没有记录。');
  });
});

describe('/feed', () => {
  it('新的在前，带时间、标题、说明与深链', () => {
    const text = formatFeedMessage('zh', {
      events: [
        {
          id: 'a',
          at: NOW,
          title: '修登录',
          projectName: 'demo',
          label: 'Goal complete',
          detail: '测试全过',
          conversationId: 'c1',
        },
      ],
      hasMore: true,
    });
    expect(text).toContain('最近动态');
    expect(text).toContain('05-20 12:00');
    expect(text).toContain('完成');
    expect(text).toContain('测试全过');
    expect(text).toContain('点下面的按钮看更早的。');
  });

  it('没有更早的就不提示翻页', () => {
    const text = formatFeedMessage('zh', {
      events: [{ id: 'a', at: NOW, title: 'x', projectName: '', label: 'Started' }],
      hasMore: false,
    });
    expect(text).not.toContain('更早');
  });
});

describe('/todo', () => {
  it('进行中与待办分开，出问题的带标记', () => {
    const text = formatTodoMessage('zh', [
      { text: '修登录', phase: 'active', projectName: 'demo' },
      { text: '写文档', phase: 'todo' },
      { text: '清理分支', phase: 'problem' },
    ]);
    expect(text).toContain('进行中 1');
    expect(text).toContain('待办 2');
    expect(text).toContain('▸ 修登录 · demo');
    expect(text).toContain('▸ 清理分支 ⚠');
  });

  it('没有未完成的就一句话', () => {
    expect(formatTodoMessage('zh', [])).toBe('没有未完成的待办。');
  });
});

describe('/schedules', () => {
  it('名称、人话周期、下次运行', () => {
    const schedules: (SecretaryScheduleView & { human?: string })[] = [
      {
        id: 's1',
        name: '每日简报',
        prompt: 'x',
        cron: '0 9 * * *',
        human: '每天 09:00',
        nextRunAt: new Date(2026, 4, 21, 9, 0).getTime(),
      },
    ];
    const text = formatSchedulesMessage('zh', { schedules, now: NOW });
    expect(text).toContain('每日简报 · 每天 09:00 · 下次 05-21 09:00');
  });

  it('没有定时就一句话', () => {
    expect(formatSchedulesMessage('zh', { schedules: [], now: NOW })).toBe('没有定时任务。');
  });
});

describe('/memory', () => {
  it('只给标题，不出现正文', () => {
    const text = formatMemoryMessage('zh', { titles: ['部署窗口', '缓存层'], total: 5 });
    expect(text).toContain('秘书记得 5');
    expect(text).toContain('▸ 部署窗口');
    expect(text).toContain('…还有 3 条');
    expect(text).toContain('只显示标题；正文留在应用里。');
  });
});

describe('命令清单', () => {
  it('/help 列出全部；记忆没开时那一条不出现', () => {
    const closed = commandListText('zh', false);
    expect(closed).toContain('/status —');
    expect(closed).not.toContain('/memory');
    expect(commandListText('zh', true)).toContain('/memory —');
  });
});

describe('会话徽标', () => {
  it('被应用退出打断的会话显示已中断，不显示进行中', () => {
    expect(sessionBadge({ state: 'running', result: 'interrupted' })).toBe('interrupted');
    expect(sessionBadge({ state: 'idle', result: 'interrupted' })).toBe('interrupted');
    expect(badgeText('zh', 'interrupted')).toBe('已中断');
  });

  it('其余状态照旧', () => {
    expect(sessionBadge({ state: 'running' })).toBe('running');
    expect(sessionBadge({ state: 'idle' })).toBe('idle');
    expect(sessionBadge({ state: 'error' })).toBe('failed');
    expect(sessionBadge({ state: 'idle', result: 'failed' })).toBe('idle');
  });

  it('停住的会话显示已停住，和运行中、等后台任务分开', () => {
    expect(sessionBadge({ state: 'idle', continuing: true, stalled: true })).toBe('stalled');
    // 运行中卡住也算停住：30 分钟没有事件比「在跑」更该说
    expect(sessionBadge({ state: 'running', stalled: true })).toBe('stalled');
    expect(sessionBadge({ state: 'idle', backgroundRunning: true })).toBe('background');
    expect(badgeText('zh', 'stalled')).toBe('已停住');
    expect(badgeText('en', 'stalled')).toBe('Stalled, no activity');
  });

  it('有在跑子代理的会话显示等子代理徽标', () => {
    expect(
      sessionBadge({
        state: 'running',
        subagents: [{ agentId: 'a1', runId: 'r1', title: 'worker', elapsedMs: 120_000 }],
      })
    ).toBe('subagent');
    expect(badgeText('zh', 'subagent')).toBe('等子代理');
    expect(badgeText('en', 'subagent')).toBe('Waiting on subagent');
  });

  it('空闲且挂着未到点提醒时徽标是 reminder（等提醒），进入运行中后切回 running', () => {
    const dueAt = new Date(2026, 4, 1, 14, 25, 0).getTime();
    const pendingReminder = { id: 'r00000001', dueAt, label: '检查 Beta #153', count: 1 };
    expect(sessionBadge({ state: 'idle', continuing: true, pendingReminder })).toBe('reminder');
    expect(sessionBadge({ state: 'idle', pendingReminder })).toBe('reminder');
    expect(sessionBadge({ state: 'running', pendingReminder })).toBe('running');
    expect(badgeText('zh', 'reminder')).toBe('等提醒');
    expect(badgeText('en', 'reminder')).toBe('Waiting for reminder');
    const status = formatStatusMessage('zh', {
      running: [
        {
          title: 'Beta mac 构建排队',
          projectName: 'enso-code',
          badge: 'reminder',
          pendingReminder,
          since: dueAt - 120_000,
          conversationId: '45b1a6d7',
        },
      ],
      needsYou: [],
      now: dueAt - 60_000,
    });
    expect(status).toContain('等提醒 · 14:25');
    expect(status).not.toContain('续跑中');
  });
});

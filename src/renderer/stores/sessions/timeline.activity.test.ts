import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  EMPTY_ACTIVITY_WITNESS,
  exploreStepsKey,
  foldTimeline,
  nextActivityRelease,
  type TimelineItem,
  thinkingRowExpanded,
} from './timeline';
import { activityOn, textItem, thinkingItem, toolItem, user, userItem } from './timeline.testUtils';

describe('thinkingRowExpanded', () => {
  it('关闭自动展开时，流式中也保持收起，结束后仍收起', () => {
    expect(thinkingRowExpanded(null, true, false)).toBe(false);
    expect(thinkingRowExpanded(null, false, false)).toBe(false);
  });

  it('开启后只在流式中展开，结束后自动收起', () => {
    expect(thinkingRowExpanded(null, true, true)).toBe(true);
    expect(thinkingRowExpanded(null, false, true)).toBe(false);
  });

  it('手动点击覆盖自动展开', () => {
    expect(thinkingRowExpanded(true, true, false)).toBe(true);
    expect(thinkingRowExpanded(false, true, true)).toBe(false);
    expect(thinkingRowExpanded(true, false, true)).toBe(true);
  });
});

describe('foldTimeline 回答完成后折叠过程（collapseCompletedActivity）', () => {
  type Group = Extract<TimelineItem, { kind: 'tool-group' }>;
  const kinds = (items: TimelineItem[]) =>
    items.map((item) => (item.kind === 'tool' ? item.name : item.kind));
  const timed = (item: TimelineItem, durationMs: number): TimelineItem =>
    ({ ...item, durationMs }) as TimelineItem;
  const failed = (key: string): TimelineItem =>
    ({ ...toolItem(key, 'bash'), state: 'error' }) as TimelineItem;

  it('已完成轮次：思考与任意工具（含 edit/write/todo）连续段折成一行，正文留在组外', () => {
    const items = [
      userItem('u'),
      timed(thinkingItem('t1'), 2000),
      timed(toolItem('a', 'bash'), 1000),
      toolItem('b', 'edit', [textItem('x')]),
      { ...toolItem('c', 'write'), writeContent: 'hi' } as TimelineItem,
      { ...toolItem('d', 'todo'), todos: [] } as TimelineItem,
      textItem('answer'),
    ];
    const folded = foldTimeline(items, false, new Set(), activityOn(items));
    expect(kinds(folded)).toEqual(['user', 'tool-group', 'text']);
    const group = folded[1] as Group;
    expect(group.activity).toEqual({ thinking: 1, workedMs: 3000 });
    expect(group.count).toBe(4);
    expect(kinds(group.children)).toEqual(['thinking', 'bash', 'edit', 'write', 'todo']);
  });

  it('展开后按原顺序平铺全部行', () => {
    const items = [userItem('u'), toolItem('a', 'edit', [textItem('x')]), toolItem('b', 'read')];
    const collapsed = foldTimeline(items, false, new Set(), activityOn(items));
    const key = collapsed[1].key;
    const expanded = foldTimeline(items, false, new Set([key]), activityOn(items));
    expect(kinds(expanded)).toEqual(['user', 'tool-group', 'edit', 'read']);
  });

  it('中间正文断开分组；只有 1 条的段不折', () => {
    const items = [
      userItem('u'),
      toolItem('a', 'read'),
      toolItem('b', 'bash'),
      textItem('mid'),
      toolItem('c', 'bash'),
      textItem('answer'),
    ];
    expect(kinds(foldTimeline(items, false, new Set(), activityOn(items)))).toEqual([
      'user',
      'tool-group',
      'text',
      'bash',
      'text',
    ]);
  });

  it('失败的工具、目标信号留在组外并断开分组', () => {
    const items = [
      userItem('u'),
      toolItem('a', 'read'),
      toolItem('b', 'read'),
      failed('bad'),
      toolItem('goal', 'goal_complete'),
      toolItem('c', 'read'),
      toolItem('d', 'read'),
    ];
    const folded = foldTimeline(items, false, new Set(), activityOn(items));
    expect(kinds(folded)).toEqual(['user', 'tool-group', 'bash', 'goal_complete', 'tool-group']);
  });

  it('正在生成的最新一轮：仍在进行的尾段保持原有行为，历史轮次照常折叠', () => {
    const items = [
      userItem('u1'),
      toolItem('a', 'edit', [textItem('x')]),
      toolItem('b', 'bash'),
      textItem('answer'),
      userItem('u2'),
      toolItem('c', 'edit', [textItem('x')]),
      toolItem('d', 'bash'),
    ];
    const folded = foldTimeline(items, true, new Set(), activityOn(items, true));
    expect(kinds(folded)).toEqual(['user', 'tool-group', 'text', 'user', 'edit', 'bash']);
  });

  it('正在生成的最新一轮：被正文隔开的已完成段立即折叠', () => {
    const items = [
      userItem('u'),
      thinkingItem('t1'),
      toolItem('a', 'edit', [textItem('x')]),
      toolItem('b', 'bash'),
      textItem('mid'),
      toolItem('c', 'edit', [textItem('y')]),
      toolItem('d', 'bash'),
    ];
    expect(kinds(foldTimeline(items, true, new Set(), activityOn(items, true)))).toEqual([
      'user',
      'tool-group',
      'text',
      'edit',
      'bash',
    ]);
    expect(
      kinds(
        foldTimeline([...items.slice(0, 5)], true, new Set(), activityOn(items.slice(0, 5), true))
      )
    ).toEqual(['user', 'tool-group', 'text']);
  });

  it('没有耗时打点时 workedMs 为 0；开关关闭时行为不变', () => {
    const items = [userItem('u'), toolItem('a', 'edit', [textItem('x')]), toolItem('b', 'bash')];
    const group = foldTimeline(items, false, new Set(), activityOn(items))[1] as Group;
    expect(group.activity).toEqual({ thinking: 0, workedMs: 0 });
    expect(kinds(foldTimeline(items, false, new Set()))).toEqual(['user', 'edit', 'bash']);
  });
});

describe('过程中折叠已完成的调用', () => {
  type Group = Extract<TimelineItem, { kind: 'tool-group' }>;
  const prep = { collapseLiveActivity: true as const, liveActivityFoldDelaySec: 2 };
  const kinds = (items: TimelineItem[]) =>
    items.map((item) => (item.kind === 'tool' ? item.name : item.kind));
  const timed = (item: TimelineItem, durationMs: number): TimelineItem =>
    ({ ...item, durationMs }) as TimelineItem;
  const streaming = (key: string): TimelineItem =>
    ({ ...thinkingItem(key), streaming: true }) as TimelineItem;
  const runningTool = (key: string): TimelineItem =>
    ({ ...toolItem(key, 'bash'), state: 'running' }) as TimelineItem;
  const failed = (key: string): TimelineItem =>
    ({ ...toolItem(key, 'bash'), state: 'error' }) as TimelineItem;
  const folded = (items: TimelineItem[], released: ReadonlySet<string>, running = true) =>
    foldTimeline(items, running, new Set(), { ...prep, releasedLiveActivity: released });

  it('只有回答完成后的开关：这一轮还在跑、后面没有正文时不折', () => {
    const items = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read')];
    expect(kinds(foldTimeline(items, true, new Set(), activityOn()))).toEqual([
      'user',
      'bash',
      'read',
    ]);
  });

  it('新开关：工具都结束后开始等，没到点不折', () => {
    const items = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read')];
    const first = nextActivityRelease(items, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    expect(first.wakeAt).toBe(3_000);
    expect([...first.released]).toEqual([]);
    expect(kinds(folded(items, first.released))).toEqual(['user', 'bash', 'read']);
  });

  it('没写等待秒数时默认等 5 秒', () => {
    const items = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read')];
    const first = nextActivityRelease(
      items,
      true,
      { collapseLiveActivity: true },
      EMPTY_ACTIVITY_WITNESS,
      1_000
    );
    expect(first.wakeAt).toBe(6_000);
  });

  it('用户展开后点名留下的工具不进过程组，左右仍各自折', () => {
    const items = [
      userItem('u'),
      toolItem('a', 'bash'),
      toolItem('b', 'read'),
      toolItem('c', 'bash'),
      toolItem('d', 'read'),
      toolItem('e', 'bash'),
    ];
    const heldOpenTools = new Set(['c']);
    const live = foldTimeline(items, true, new Set(), {
      ...prep,
      releasedLiveActivity: new Set(['a', 'b', 'c', 'd', 'e']),
      heldOpenTools,
    });
    expect(live.map((item) => (item.kind === 'tool' ? item.key : item.kind))).toEqual([
      'user',
      'tool-group',
      'c',
      'tool-group',
    ]);
    const done = foldTimeline(items, false, new Set(), {
      collapseCompletedActivity: true,
      heldOpenTools,
    });
    expect(done.map((item) => (item.kind === 'tool' ? item.key : item.kind))).toEqual([
      'user',
      'tool-group',
      'c',
      'tool-group',
    ]);
  });

  it('新开关：到点后这一轮仍在跑，也折成过程组', () => {
    const items = [
      userItem('u'),
      timed(thinkingItem('t1'), 2000),
      timed(toolItem('a', 'bash'), 1000),
      toolItem('b', 'read'),
    ];
    const first = nextActivityRelease(items, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    if (first.wakeAt === null) throw new Error('quiet live tail must arm');
    const due = nextActivityRelease(items, true, prep, first.witness, first.wakeAt);
    const rows = folded(items, due.released);
    expect(kinds(rows)).toEqual(['user', 'tool-group']);
    const group = rows[1] as Group;
    expect(group.activity).toEqual({ thinking: 1, workedMs: 3000 });
    expect(group.count).toBe(2);
    expect(kinds(group.children)).toEqual(['thinking', 'bash', 'read']);
    expect(group.live).toBe(true);
  });

  it('过程组只在这一轮还在跑时标记为进行中，结束后不再呼吸', () => {
    const items = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read')];
    const first = nextActivityRelease(items, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    if (first.wakeAt === null) throw new Error('quiet live tail must arm');
    const due = nextActivityRelease(items, true, prep, first.witness, first.wakeAt);
    expect((folded(items, due.released)[1] as Group).live).toBe(true);
    const settled = foldTimeline(items, false, new Set(), {
      collapseCompletedActivity: true,
      collapseLiveActivity: true,
      releasedLiveActivity: due.released,
    });
    expect((settled[1] as Group).live).toBeUndefined();
    const answered = foldTimeline([...items, textItem('answer')], true, new Set(), {
      collapseCompletedActivity: true,
      collapseLiveActivity: true,
      releasedLiveActivity: due.released,
    });
    expect((answered[1] as Group).live).toBeUndefined();
  });

  it('2 秒内又完成一个工具就重新计时', () => {
    const items = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read')];
    const first = nextActivityRelease(items, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    const more = [...items, toolItem('c', 'bash')];
    const again = nextActivityRelease(more, true, prep, first.witness, 1_500);
    expect(again.wakeAt).toBe(3_500);
    expect([...again.released]).toEqual([]);
    expect(kinds(folded(more, again.released))).toEqual(['user', 'bash', 'read', 'bash']);
  });

  it('思考还在流时不计时', () => {
    const items = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read'), streaming('t')];
    const first = nextActivityRelease(items, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    expect(first.wakeAt).toBeNull();
    expect(kinds(folded(items, first.released))).toEqual(['user', 'bash', 'read', 'thinking']);
  });

  it('前面的段到点后可以折，正在跑的工具留在组外', () => {
    const done = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read')];
    const first = nextActivityRelease(done, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    if (first.wakeAt === null) throw new Error('quiet live tail must arm');
    const due = nextActivityRelease(done, true, prep, first.witness, first.wakeAt);
    const items = [...done, runningTool('live')];
    const still = nextActivityRelease(items, true, prep, due.witness, first.wakeAt);
    expect(kinds(folded(items, still.released))).toEqual(['user', 'tool-group', 'bash']);
  });

  it('已经折起的前缀不因新工具完成而展开，新工具等满 2 秒再并进去', () => {
    const done = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read')];
    const first = nextActivityRelease(done, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    if (first.wakeAt === null) throw new Error('quiet live tail must arm');
    const due = nextActivityRelease(done, true, prep, first.witness, first.wakeAt);
    const more = [...done, toolItem('c', 'read')];
    const pending = nextActivityRelease(more, true, prep, due.witness, first.wakeAt);
    expect(pending.wakeAt).toBe(first.wakeAt + 2_000);
    const waiting = folded(more, pending.released);
    expect(kinds(waiting)).toEqual(['user', 'tool-group', 'read']);
    expect(kinds((waiting[1] as Group).children)).toEqual(['bash', 'read']);
    const absorbed = nextActivityRelease(more, true, prep, pending.witness, pending.wakeAt ?? 0);
    const rows = folded(more, absorbed.released);
    expect(kinds(rows)).toEqual(['user', 'tool-group']);
    expect(kinds((rows[1] as Group).children)).toEqual(['bash', 'read', 'read']);
  });

  it('新的思考还在流时，已经折起的前缀保持折叠', () => {
    const done = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read')];
    const first = nextActivityRelease(done, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    if (first.wakeAt === null) throw new Error('quiet live tail must arm');
    const due = nextActivityRelease(done, true, prep, first.witness, first.wakeAt);
    const items = [...done, streaming('t2')];
    const still = nextActivityRelease(items, true, prep, due.witness, first.wakeAt);
    expect(still.wakeAt).toBeNull();
    expect(kinds(folded(items, still.released))).toEqual(['user', 'tool-group', 'thinking']);
  });

  it('失败工具仍留在组外', () => {
    const items = [
      userItem('u'),
      toolItem('a', 'read'),
      toolItem('b', 'read'),
      failed('bad'),
      toolItem('c', 'read'),
      toolItem('d', 'read'),
    ];
    const first = nextActivityRelease(items, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    if (first.wakeAt === null) throw new Error('quiet live tail must arm');
    const due = nextActivityRelease(items, true, prep, first.witness, first.wakeAt);
    expect(kinds(folded(items, due.released))).toEqual([
      'user',
      'tool-group',
      'bash',
      'tool-group',
    ]);
  });

  it('新开关不负责已经结束的会话', () => {
    const items = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read'), textItem('answer')];
    const opened = nextActivityRelease(items, false, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    expect(opened.wakeAt).toBeNull();
    expect(kinds(folded(items, opened.released, false))).toEqual(['user', 'bash', 'read', 'text']);
  });

  it('两个开关一起开：正文隔开的段立刻折，尾段仍要等到点', () => {
    const items = [
      userItem('u'),
      toolItem('a', 'bash'),
      toolItem('b', 'read'),
      textItem('mid'),
      toolItem('c', 'bash'),
      toolItem('d', 'read'),
    ];
    const first = nextActivityRelease(items, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    expect(
      kinds(
        foldTimeline(items, true, new Set(), {
          collapseCompletedActivity: true,
          collapseLiveActivity: true,
          releasedLiveActivity: first.released,
        })
      )
    ).toEqual(['user', 'tool-group', 'text', 'bash', 'read']);
  });

  it('正文一出现，回答完成后的开关立刻折，不等过程中的 2 秒', () => {
    const live = [userItem('u'), toolItem('a', 'bash'), toolItem('b', 'read')];
    const first = nextActivityRelease(live, true, prep, EMPTY_ACTIVITY_WITNESS, 1_000);
    const closed = [...live, textItem('answer')];
    const holding = nextActivityRelease(closed, true, prep, first.witness, 1_500);
    expect(holding.wakeAt).toBeNull();
    expect(
      kinds(
        foldTimeline(closed, true, new Set(), {
          collapseCompletedActivity: true,
          collapseLiveActivity: true,
          releasedLiveActivity: holding.released,
        })
      )
    ).toEqual(['user', 'tool-group', 'text']);
  });

  it('没到点时 compact 仍只收只读组，bash 不标成探索', () => {
    const items = [
      userItem('u'),
      toolItem('r1', 'read'),
      toolItem('r2', 'grep'),
      toolItem('r3', 'find'),
      toolItem('b', 'bash'),
      toolItem('e', 'edit', [textItem('x')]),
    ];
    const first = nextActivityRelease(
      items,
      true,
      { ...prep, compact: true },
      EMPTY_ACTIVITY_WITNESS,
      1_000
    );
    const rows = foldTimeline(items, true, new Set(), {
      compact: true,
      collapseLiveActivity: true,
      releasedLiveActivity: first.released,
    });
    expect(kinds(rows)).toEqual(['user', 'tool-group', 'bash', 'edit']);
    const group = rows[1] as Group;
    expect(group.activity).toBeUndefined();
    expect(group.exploring).toBe(false);
    expect(kinds(group.children)).toEqual(['read', 'grep', 'find']);
  });
});

describe('foldTimeline 探索配对折叠（explore_mark → explore_fold）', () => {
  type Group = Extract<TimelineItem, { kind: 'tool-group' }>;
  const keys = (items: TimelineItem[]) => items.map((item) => item.key);
  const mark = (key: string): TimelineItem =>
    ({ ...toolItem(key, 'explore_mark'), summary: 'find auth' }) as TimelineItem;
  const fold = (key: string, state = 'ok'): TimelineItem =>
    ({
      ...toolItem(key, 'explore_fold'),
      state,
      output: 'Explore folded. Subsequent turns see only this report.\n\nauth in src/auth.ts',
    }) as TimelineItem;

  it('成对后 mark 到 fold（含中间正文、思考）收成一个探索组；展开先只给目标与结果，再展开过程才平铺原始行', () => {
    const items = [
      userItem('u'),
      mark('m'),
      toolItem('r', 'read'),
      textItem('mid'),
      thinkingItem('th'),
      toolItem('b', 'bash'),
      fold('f'),
      textItem('answer'),
    ];
    const folded = foldTimeline(items, true, new Set());
    expect(folded.map((item) => item.kind)).toEqual(['user', 'tool-group', 'text']);
    const group = folded[1] as Group;
    expect(group.explore).toEqual({
      goal: 'find auth',
      report: 'auth in src/auth.ts',
      steps: false,
    });
    expect(group.count).toBe(2);
    expect(keys(group.children)).toEqual(['m', 'r', 'mid', 'th', 'b', 'f']);
    const opened = foldTimeline(items, true, new Set([group.key]));
    expect(keys(opened)).toEqual(['u', group.key, 'answer']);
    expect((opened[1] as Group).explore?.steps).toBe(false);
    const steps = exploreStepsKey(group.key);
    expect(keys(foldTimeline(items, true, new Set([steps])))).toEqual(['u', group.key, 'answer']);
    const detailed = foldTimeline(items, true, new Set([group.key, steps]));
    expect((detailed[1] as Group).explore?.steps).toBe(true);
    expect(keys(detailed)).toEqual(['u', group.key, 'm', 'r', 'mid', 'th', 'b', 'f', 'answer']);
  });

  it('fold 未完成、失败或被用户消息隔开时不配对；失败后重试成功仍配对', () => {
    const live = [userItem('u'), mark('m'), toolItem('r', 'read'), fold('f', 'running')];
    expect(keys(foldTimeline(live, true, new Set()))).toEqual(['u', 'm', 'r', 'f']);
    const failed = [mark('m'), fold('bad', 'error'), textItem('x')];
    expect(keys(foldTimeline(failed, false, new Set()))).toEqual(['m', 'bad', 'x']);
    const split = [mark('m'), userItem('u'), fold('f')];
    expect(keys(foldTimeline(split, false, new Set()))).toEqual(['m', 'u', 'f']);
    const retried = foldTimeline([mark('m'), fold('bad', 'error'), fold('f')], false, new Set());
    expect(retried).toHaveLength(1);
    expect((retried[0] as Group).explore).toBeDefined();
    expect(keys((retried[0] as Group).children)).toEqual(['m', 'bad', 'f']);
  });

  it('回答完成后探索组并入过程组，逐层展开', () => {
    const items = [
      userItem('u'),
      toolItem('a', 'bash'),
      mark('m'),
      toolItem('r', 'read'),
      fold('f'),
      textItem('answer'),
    ];
    const folded = foldTimeline(items, false, new Set(), activityOn(items));
    expect(folded.map((item) => item.kind)).toEqual(['user', 'tool-group', 'text']);
    const activity = folded[1] as Group;
    expect(activity.activity).toBeDefined();
    expect(activity.count).toBe(4);
    const exploreKey = activity.children[1].key;
    expect(keys(foldTimeline(items, false, new Set([activity.key]), activityOn(items)))).toEqual([
      'u',
      activity.key,
      'a',
      exploreKey,
      'answer',
    ]);
    expect(
      keys(foldTimeline(items, false, new Set([activity.key, exploreKey]), activityOn(items)))
    ).toEqual(['u', activity.key, 'a', exploreKey, 'answer']);
    expect(
      keys(
        foldTimeline(
          items,
          false,
          new Set([activity.key, exploreKey, exploreStepsKey(exploreKey)]),
          activityOn(items)
        )
      )
    ).toEqual(['u', activity.key, 'a', exploreKey, 'm', 'r', 'f', 'answer']);
  });
});

describe('submit_plan 计划卡片', () => {
  it('从参数取出标题与正文', () => {
    const items = buildTimeline(
      [
        user('规划一下'),
        {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            {
              type: 'toolCall',
              id: 'c1',
              name: 'submit_plan',
              arguments: { title: '重构登录', plan: '# 步骤\n1. 改 A' },
            },
          ],
        },
      ],
      false
    );
    const tool = items.find((item) => item.kind === 'tool');
    expect(tool && tool.kind === 'tool' ? tool.plan : undefined).toEqual({
      title: '重构登录',
      text: '# 步骤\n1. 改 A',
    });
  });

  it('已完成轮次的过程折叠不吞计划卡片', () => {
    const plan = {
      ...toolItem('p', 'submit_plan'),
      plan: { title: 'T', text: 'x' },
    } as TimelineItem;
    const items = [userItem('u'), toolItem('a', 'read'), toolItem('b', 'grep'), plan];
    const folded = foldTimeline(items, false, new Set(), activityOn(items));
    expect(folded.at(-1)).toBe(plan);
  });
});

describe('消息类工具行（联系主 agent / 联系队员 / 子代理发消息）', () => {
  const resultOf = (name: string, text: string): ProjectedMessage => ({
    role: 'toolResult',
    toolCallId: 'm1',
    toolName: name,
    isError: false,
    content: [{ type: 'text', text }],
  });
  const toolFor = (name: string, args: Record<string, unknown>, extra: ProjectedMessage[] = []) =>
    buildTimeline(
      [
        user('去核对'),
        {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'm1', name, arguments: args }],
        },
        ...extra,
      ],
      false
    ).find((item) => item.kind === 'tool');

  it('联系主 agent：摘要与展开内容取正文，而不是参数 JSON 或投递回执', () => {
    const message = '已核对并按补充约定：\n- 保留导出 AsrSession';
    const tool = toolFor('message_main_agent', { message: ` ${message}\n`, urgent: false }, [
      resultOf('message_main_agent', '(delivered to the main agent — async)'),
    ]);
    expect(tool).toMatchObject({
      state: 'ok',
      summary: message,
      sentMessage: message,
      output: null,
    });
  });

  it('联系队员：摘要带上收件人，展开内容取正文', () => {
    const text = '接口改好了，**可以联调**';
    const tool = toolFor('message_coworker', { to: ' 核对 ASR ', text }, [
      resultOf(
        'message_coworker',
        '(delivered to coworker "核对 ASR" — async; any reply arrives later via message_coworker)'
      ),
    ]);
    expect(tool).toMatchObject({
      state: 'ok',
      summary: `核对 ASR · ${text}`,
      sentMessage: text,
      output: null,
    });
  });

  it('只剥投递回执：捎带的系统提醒与发送失败回执照常显示', () => {
    const notice =
      '<background-task-update>\nMessage from coworker "B":\nhi\n</background-task-update>';
    expect(
      toolFor('message_coworker', { to: 'B', text: 'x' }, [
        resultOf('message_coworker', `${notice}\n\n(delivered to coworker "B" — async)`),
      ])
    ).toMatchObject({ output: notice });
    const failed = '(unknown coworker "C" — peers: B)';
    expect(
      toolFor('message_coworker', { to: 'C', text: 'x' }, [resultOf('message_coworker', failed)])
    ).toMatchObject({ state: 'ok', output: failed });
  });

  it('子代理 send / message：摘要带上 spawn 时起的名字，展开内容取正文，只剥纯投递回执', () => {
    const agentId = '043a1933-8c77-49da-af93-b770b72f438d';
    const json = (value: object) => JSON.stringify(value, null, 2);
    const call = (id: string, args: Record<string, unknown>): ProjectedMessage => ({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id, name: 'subagent', arguments: args }],
    });
    const result = (id: string, text: string): ProjectedMessage => ({
      ...resultOf('subagent', text),
      toolCallId: id,
    });
    const reminder = '<system-reminder>\nx\n</system-reminder>';
    const withReport = json({
      agentId,
      runId: 'r3',
      delivery: 'next',
      status: 'queued',
      report: { runs: [], timedOut: false, interrupted: false },
    });
    const tools = buildTimeline(
      [
        user('派活'),
        call('s1', { operation: 'spawn', mode: 'coworker', description: '核对 ASR', prompt: 'p' }),
        result('s1', json({ agentId, runId: 'r1', mode: 'coworker', status: 'running' })),
        call('m1', { operation: 'send', agentId, message: ' 先别改 **接口**\n' }),
        result(
          'm1',
          `${reminder}\n\n${json({ agentId, runId: 'r2', delivery: 'steer', status: 'running' })}`
        ),
        call('m2', { operation: 'message', to: 'unknown', text: '收尾', wait: true }),
        result('m2', withReport),
      ],
      false
    ).filter((item) => item.kind === 'tool');
    expect(tools[1]).toMatchObject({
      summary: '核对 ASR · 先别改 **接口**',
      sentMessage: '先别改 **接口**',
      output: reminder,
    });
    expect(tools[2]).toMatchObject({ summary: '收尾', sentMessage: '收尾', output: withReport });
  });

  it('空正文不产出消息内容；其它带 message 参数的工具不受影响', () => {
    expect(toolFor('message_main_agent', { message: '  ' })).not.toHaveProperty('sentMessage');
    const receipt = '(delivered to coworker "B" — async)';
    const other = toolFor('notify', { message: 'hi' }, [resultOf('notify', receipt)]);
    expect(other).toMatchObject({ output: receipt });
    expect(other).not.toHaveProperty('sentMessage');
  });
});

describe('memory_capture 记录记忆行', () => {
  const capture = (name: string, args: Record<string, unknown>) =>
    buildTimeline(
      [
        user('记一下'),
        {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'c1', name, arguments: args }],
        },
      ],
      false
    ).find((item) => item.kind === 'tool');

  it('摘要取标题，缺省时取正文首行；正文随行带出供展开显示（回执不带正文）', () => {
    expect(
      capture('memory_capture', { title: ' 工具行规则 ', content: ' 第一行\n第二行 ' })
    ).toMatchObject({ summary: '工具行规则', memoryContent: '第一行\n第二行' });
    expect(capture('memory_capture', { content: '第一行\n第二行' })).toMatchObject({
      summary: '第一行',
    });
  });

  it('正文为空或其它工具不带正文', () => {
    expect(capture('memory_capture', { content: '  ' })).not.toHaveProperty('memoryContent');
    expect(capture('memory_search', { query: 'q', content: 'x' })).toMatchObject({ summary: 'q' });
    expect(capture('memory_search', { query: 'q', content: 'x' })).not.toHaveProperty(
      'memoryContent'
    );
  });
});

describe('ask_user 询问用户行', () => {
  const ask = (
    args: Record<string, unknown>,
    result?: { text: string; isError?: boolean },
    running = false
  ) =>
    buildTimeline(
      [
        user('帮我定一下'),
        {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: args }],
        },
        ...(result
          ? [
              {
                role: 'toolResult',
                toolCallId: 'q1',
                toolName: 'ask_user',
                isError: result.isError === true,
                content: [{ type: 'text', text: result.text }],
              } satisfies ProjectedMessage,
            ]
          : []),
      ],
      running
    ).find((item) => item.kind === 'tool');
  const args = { question: ' 用哪个方案？\n说明一下 ', options: [' A ', 'B', 'C', 'D', 'E'] };

  it('摘要取问题；带出当时展示的选项（同实际展示最多 4 个）与用户选的那个', () => {
    expect(ask(args, { text: 'B' })).toMatchObject({
      state: 'ok',
      summary: '用哪个方案？\n说明一下',
      output: null,
      ask: {
        question: '用哪个方案？\n说明一下',
        options: ['A', 'B', 'C', 'D'],
        answer: 'B',
        autoSelected: false,
      },
    });
  });

  it('自定义回答原样带出；回执前捎带的系统提醒照常显示', () => {
    const notice =
      '<background-task-update>\nMessage from coworker "B":\nhi\n</background-task-update>';
    expect(ask(args, { text: `${notice}\n\n都不要，用 F` })).toMatchObject({
      output: notice,
      ask: { answer: '都不要，用 F', autoSelected: false },
    });
  });

  it('超时按默认项自动选择时，回答取默认项本身并注明', () => {
    expect(
      ask({ ...args, default_option: 'A' }, { text: 'A (auto-selected: no response in time)' })
    ).toMatchObject({ output: null, ask: { answer: 'A', autoSelected: true } });
  });

  it('等待回答或已取消时没有回答，取消原因照常显示', () => {
    expect(ask(args, undefined, true)).toMatchObject({
      state: 'running',
      output: null,
      ask: { answer: null },
    });
    expect(ask(args, { text: 'question cancelled', isError: true })).toMatchObject({
      state: 'error',
      output: 'question cancelled',
      ask: { answer: null },
    });
  });

  it('没有问题（调用失败）时不改写，按原样显示', () => {
    const tool = ask({ options: ['A'] }, { text: 'question is required', isError: true });
    expect(tool).toMatchObject({ output: 'question is required' });
    expect(tool).not.toHaveProperty('ask');
  });
});

describe('子代理按 runId / agentId 指代的操作行', () => {
  const json = (value: object) => JSON.stringify(value, null, 2);
  const call = (id: string, args: Record<string, unknown>): ProjectedMessage => ({
    role: 'assistant',
    stopReason: 'toolUse',
    content: [{ type: 'toolCall', id, name: 'subagent', arguments: args }],
  });
  const result = (id: string, text: string): ProjectedMessage => ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'subagent',
    isError: false,
    content: [{ type: 'text', text }],
  });
  const a = 'c1a2b3c4-0000-4000-8000-00000000000a';
  const b = 'c1a2b3c4-0000-4000-8000-00000000000b';
  const history: ProjectedMessage[] = [
    user('派活'),
    call('s1', { operation: 'spawn', description: '子代理连通性测试', prompt: 'p', wait: true }),
    result(
      's1',
      json({
        agentId: a,
        runId: 'r1',
        mode: 'task',
        status: 'running',
        report: { runs: [], timedOut: false, interrupted: false },
      })
    ),
    call('s2', { operation: 'spawn', name: 'reviewer', description: '审查兼容性', prompt: 'p' }),
    result('s2', json({ agentId: b, runId: 'r2', mode: 'coworker', status: 'running' })),
    call('m1', { operation: 'send', agentId: b, message: '再看一遍' }),
    result('m1', json({ agentId: b, runId: 'r3', delivery: 'next', status: 'queued' })),
  ];
  const rows = (extra: ProjectedMessage[], running = false) =>
    buildTimeline([...history, ...extra], running).filter((item) => item.kind === 'tool');

  it('report / stop 按 runId 找回 spawn 时起的标题（起了名字取名字）', () => {
    const tools = rows([
      call('q1', { operation: 'report', runId: 'r1' }),
      result('q1', json({ run: { agentId: a, runId: 'r1', status: 'succeeded' }, text: 'ok' })),
      call('q2', { operation: 'stop', runId: 'r2' }),
      result('q2', json({ agentId: b, runId: 'r2', status: 'cancelled' })),
    ]);
    expect(tools[3]).toMatchObject({ summary: '子代理连通性测试', subagentOp: 'report' });
    expect(tools[4]).toMatchObject({ summary: 'reviewer', subagentOp: 'stop' });
  });

  it('send 新开的 run 也能对回子代理；wait 多个 run 时列出各自标题并去重', () => {
    const [, , , single, many] = rows(
      [
        call('w1', { operation: 'wait', runId: 'r3' }),
        result('w1', json({ runs: [], timedOut: false, interrupted: false })),
        call('w2', { operation: 'wait', runIds: ['r1', 'r2', 'r3'], until: 'all' }),
      ],
      true
    );
    expect(single).toMatchObject({ summary: 'reviewer', subagentOp: 'wait' });
    expect(many).toMatchObject({
      state: 'running',
      summary: '子代理连通性测试, reviewer',
      subagentOp: 'wait',
    });
  });

  it('dismiss 按 agentId 显示标题', () => {
    const tools = rows([
      call('d1', { operation: 'dismiss', agentId: b }),
      result('d1', json({ agentId: b })),
    ]);
    expect(tools[3]).toMatchObject({ summary: 'reviewer', subagentOp: 'dismiss' });
  });

  it('wait 行按 agentId 带上各目标的标题，供展开后逐个标注；其它操作不带', () => {
    const tools = rows(
      [
        call('w1', { operation: 'wait', runIds: ['r1', 'r3', 'c39dfb22-dead'] }),
        call('q1', { operation: 'report', runId: 'r1' }),
      ],
      true
    );
    expect(tools[3]).toMatchObject({
      subagentTitles: { [a]: '子代理连通性测试', [b]: 'reviewer' },
    });
    for (const tool of [tools[0], tools[2], tools[4]]) {
      expect(tool).not.toHaveProperty('subagentTitles');
    }
  });

  it('列表与查不到的目标只标操作，不回退参数 JSON', () => {
    const tools = rows([
      call('l1', { operation: 'list' }),
      call('q9', { operation: 'report', runId: 'c39dfb22-9f2c-432e-a826-99cde1491d88' }),
    ]);
    expect(tools[3]).toMatchObject({ summary: '', subagentOp: 'list' });
    expect(tools[4]).toMatchObject({ summary: '', subagentOp: 'report' });
  });

  it('list 行带上此前 spawn 过的全部标题，供展开后逐个标注', () => {
    const tools = rows([call('l1', { operation: 'list' })], true);
    expect(tools[3]).toMatchObject({
      subagentOp: 'list',
      subagentTitles: { [a]: '子代理连通性测试', [b]: 'reviewer' },
    });
    const bare = buildTimeline([user('列一下'), call('l0', { operation: 'list' })], true);
    expect(bare.find((item) => item.kind === 'tool')).not.toHaveProperty('subagentTitles');
  });

  it('spawn / send 与不带 operation 的旧调用不受影响', () => {
    const tools = rows([call('x1', { description: '旧式派活', prompt: 'p' })]);
    expect(tools[0]).toMatchObject({ summary: '子代理连通性测试' });
    expect(tools[2]).toMatchObject({ summary: 'reviewer · 再看一遍' });
    expect(tools[3]).toMatchObject({ summary: '旧式派活' });
    expect(tools[3]).not.toHaveProperty('sentMessage');
    for (const tool of tools) {
      expect(tool).not.toHaveProperty('subagentOp');
    }
  });

  it('spawn 展开显示交代的任务（去掉首尾空白），行头与回执原文不变', () => {
    const receipt = json({ agentId: a, runId: 'r1', mode: 'task', status: 'running' });
    const spawned = buildTimeline(
      [
        user('派活'),
        call('s9', { operation: 'spawn', description: '核对 ASR', prompt: '\n 看看 **ASR**\n' }),
        result('s9', receipt),
      ],
      false
    ).find((item) => item.kind === 'tool');
    expect(spawned).toMatchObject({
      summary: '核对 ASR',
      sentMessage: '看看 **ASR**',
      output: receipt,
    });
  });

  it('spawn 起了名字时行头带上名字，与后续按 id 指代的行对得上', () => {
    const [, named] = rows([]);
    expect(named).toMatchObject({ summary: 'reviewer · 审查兼容性' });
    const same = buildTimeline(
      [
        user('派活'),
        call('s9', { operation: 'spawn', name: ' x ', description: 'x', prompt: 'p' }),
      ],
      false
    ).find((item) => item.kind === 'tool');
    expect(same).toMatchObject({ summary: 'x' });
  });
});

describe('buildTimeline runDividers', () => {
  const at = (message: ProjectedMessage, timestamp: number): ProjectedMessage => ({
    ...message,
    timestamp,
  });
  const reply = (text: string, timestamp: number): ProjectedMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp,
  });
  const mark = (n: number, time: number) => ({ key: `run:${n}`, at: time, text: `run ${n}` });
  const shape = (items: TimelineItem[]) =>
    items.map((item) => (item.kind === 'divider' ? item.text : item.kind));

  it('每次执行的分隔线放在开工后的第一行前；开工前一刻送达的任务消息归本次执行', () => {
    const items = buildTimeline(
      [at(user('task'), 100), reply('a', 105), at(user('rework'), 199), reply('b', 210)],
      false,
      [],
      undefined,
      { runDividers: [mark(1, 101), mark(2, 201)] }
    );
    expect(shape(items)).toEqual(['run 1', 'user', 'text', 'run 2', 'user', 'text']);
  });

  it('重试不发新消息时分隔线落在续跑输出前；上次没有输出也不抢走上次的任务消息', () => {
    expect(
      shape(
        buildTimeline(
          [at(user('task'), 100), reply('a', 105), reply('b', 300)],
          false,
          [],
          undefined,
          {
            runDividers: [mark(1, 101), mark(2, 290)],
          }
        )
      )
    ).toEqual(['run 1', 'user', 'text', 'run 2', 'text']);
    expect(
      shape(
        buildTimeline([at(user('task'), 100), reply('b', 300)], false, [], undefined, {
          runDividers: [mark(1, 101), mark(2, 290)],
        })
      )
    ).toEqual(['run 1', 'user', 'run 2', 'text']);
    expect(
      shape(
        buildTimeline(
          [at(user('task'), 100), reply('a', 105), at(user('steer'), 150), reply('b', 60_000)],
          false,
          [],
          undefined,
          { runDividers: [mark(1, 101), mark(2, 59_000)] }
        )
      )
    ).toEqual(['run 1', 'user', 'text', 'user', 'run 2', 'text']);
  });

  it('尾窗分页时开工早于已加载最早一行的执行不画分隔线；刚开工还没输出时放在末尾', () => {
    expect(
      shape(
        buildTimeline(
          [reply('a', 105), at(user('rework'), 199), reply('b', 210)],
          false,
          [],
          undefined,
          {
            historyBaseIndex: 5,
            runDividers: [mark(1, 101), mark(2, 201)],
          }
        )
      )
    ).toEqual(['text', 'run 2', 'user', 'text']);
    expect(
      shape(
        buildTimeline([at(user('task'), 100), reply('a', 105)], false, [], undefined, {
          runDividers: [mark(1, 101), mark(2, 400)],
        })
      )
    ).toEqual(['run 1', 'user', 'text', 'run 2']);
  });
});

describe('foldTimeline 丢弃本轮折叠（插件投递 → turn_discard）', () => {
  type Discarded = Extract<TimelineItem, { kind: 'discarded-turn' }>;
  const keys = (items: TimelineItem[]) => items.map((item) => item.key);
  const plugin = (key: string, text: string): TimelineItem => ({
    kind: 'plugin-message',
    key,
    text,
    pluginId: 'enso.tgclient',
    pluginName: 'Telegram',
  });
  const discard = (key: string, state = 'ok'): TimelineItem =>
    ({
      ...toolItem(key, 'turn_discard'),
      state,
      output: 'Turn discarded: chip news',
    }) as TimelineItem;

  it('插件投递到成功的 turn_discard（含其间思考）收成一行，原文留在行内', () => {
    const items = [
      userItem('u'),
      textItem('a'),
      plugin('p1', 'NVIDIA news'),
      plugin('p2', 'more news'),
      thinkingItem('th'),
      discard('d'),
      plugin('p3', 'EnsoCode bug'),
    ];
    const folded = foldTimeline(items, false, new Set());
    expect(keys(folded)).toEqual(['u', 'a', 'discard-p1', 'p3']);
    const row = folded[2] as Discarded;
    expect(row).toMatchObject({
      kind: 'discarded-turn',
      reason: 'chip news',
      pluginName: 'Telegram',
      messages: ['NVIDIA news', 'more news'],
      expanded: false,
    });
    expect((foldTimeline(items, false, new Set(['discard-p1']))[2] as Discarded).expanded).toBe(
      true
    );
  });

  it('丢弃前用只读工具查过：查询行一并收进，展开可见', () => {
    const items = [
      plugin('p1', 'news'),
      toolItem('t1', 'plugin_enso-tgclient__tg_get_messages'),
      thinkingItem('th'),
      discard('d'),
    ];
    const [row] = foldTimeline(items, false, new Set()) as Discarded[];
    expect(row).toMatchObject({ kind: 'discarded-turn', key: 'discard-p1' });
    expect(row.tools.map((tool) => tool.name)).toEqual(['plugin_enso-tgclient__tg_get_messages']);
  });

  it('未填原因时行内原因为空', () => {
    const items = [
      plugin('p1', 'news'),
      { ...toolItem('d', 'turn_discard'), output: 'Turn discarded.' } as TimelineItem,
    ];
    expect((foldTimeline(items, false, new Set())[0] as Discarded).reason).toBe('');
  });

  it('turn_discard 未完成、失败或前面不是插件投递时不折叠', () => {
    const running = [plugin('p', 'x'), discard('d', 'running')];
    expect(keys(foldTimeline(running, true, new Set()))).toEqual(['p', 'd']);
    const failed = [plugin('p', 'x'), discard('d', 'error')];
    expect(keys(foldTimeline(failed, false, new Set()))).toEqual(['p', 'd']);
    const byUser = [userItem('u'), discard('d')];
    expect(foldTimeline(byUser, false, new Set()).some((i) => i.kind === 'discarded-turn')).toBe(
      false
    );
  });
});

it('丢弃的一轮在其所属用户轮次自动折叠时仍保留为一行', () => {
  const items: TimelineItem[] = [
    { ...userItem('u1'), canCollapse: true } as TimelineItem,
    textItem('a'),
    {
      kind: 'plugin-message',
      key: 'p',
      text: 'x',
      pluginId: 'enso.tgclient',
      pluginName: 'Telegram',
    },
    { ...toolItem('d', 'turn_discard'), output: 'Turn discarded: r' } as TimelineItem,
    userItem('u2'),
  ];
  const folded = foldTimeline(items, false, new Set(), { autoCollapseCompletedTurns: true });
  expect(folded.map((item) => item.key)).toEqual(['u1', 'discard-p', 'u2']);
});

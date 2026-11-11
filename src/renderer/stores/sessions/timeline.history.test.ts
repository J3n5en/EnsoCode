import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { applyAgentEvent, emptyProjection, type TimelineMessage } from './reducer';
import {
  buildTimeline,
  foldTimeline,
  historyPageChrome,
  shouldPrefetchOlderHistory,
} from './timeline';
import { user, userByText, users } from './timeline.testUtils';

describe('historyPageChrome', () => {
  it('空时间线不占 Header，避免盖住 Preparing / 空态', () => {
    expect(historyPageChrome(false, true, false)).toBe('none');
    expect(historyPageChrome(false, false, false)).toBe('none');
  });

  it('有消息时：在途 loading、翻到顶才 start、短会话不提示开头', () => {
    expect(historyPageChrome(true, true, true)).toBe('loading');
    expect(historyPageChrome(true, true, false, true)).toBe('loading');
    expect(historyPageChrome(true, false, false)).toBe('none');
    expect(historyPageChrome(true, false, false, false)).toBe('none');
    expect(historyPageChrome(true, false, false, true)).toBe('start');
    expect(historyPageChrome(true, false, true)).toBe('none');
    expect(historyPageChrome(true, false, undefined)).toBe('none');
  });
});

describe('shouldPrefetchOlderHistory', () => {
  it('工具组收拢后撑不满视口时给出加载入口，不在进会话时自动拉一页', () => {
    expect(shouldPrefetchOlderHistory(true, false, 400, 700)).toBe(true);
    expect(shouldPrefetchOlderHistory(true, false, 700, 700)).toBe(true);
    expect(shouldPrefetchOlderHistory(true, false, 780, 700)).toBe(true);
    expect(historyPageChrome(true, false, true, false, true)).toBe('more');
    expect(historyPageChrome(true, false, true)).toBe('none');
  });

  it('内容已经超出视口、正在加载、或没有更早历史时不预取', () => {
    expect(shouldPrefetchOlderHistory(true, false, 1200, 700)).toBe(false);
    expect(shouldPrefetchOlderHistory(true, true, 400, 700)).toBe(false);
    expect(shouldPrefetchOlderHistory(false, false, 400, 700)).toBe(false);
  });
});

describe('buildTimeline', () => {
  describe('未确认消息展示', () => {
    it.each([false, true])(
      '继续送达后仍在较早的未确认气泡之后，且不改变权威消息索引（rejected=%s）',
      (deliveryRejected) => {
        const old = {
          ...user('17:08 instruction'),
          timestamp: 100,
          optimistic: true,
          deliveryId: 'old',
          deliveryRejected,
        };
        const pending = {
          ...user('17:11 continue'),
          timestamp: 200,
          optimistic: true,
          deliveryId: 'continue',
        };
        const delivered = { ...user('17:11 continue'), timestamp: 201, entryId: 'continue-entry' };
        const identity = { sessionId: 'session', generation: 'generation' };
        const after = applyAgentEvent(
          {
            ...emptyProjection,
            generation: identity.generation,
            historyBaseIndex: 40,
            messages: [old, pending],
          },
          identity.sessionId,
          {
            type: 'message-upsert',
            identity,
            seq: 1,
            index: 40,
            message: delivered,
          }
        );
        expect(after.messages).toEqual([delivered, old]);
        const timeline = buildTimeline(after.messages, false, [], undefined, {
          historyBaseIndex: 40,
        });
        expect(timeline.filter((item) => item.kind === 'user')).toEqual([
          expect.objectContaining({
            key: '41',
            text: '17:08 instruction',
            canCollapse: false,
            deliveryState: deliveryRejected ? 'rejected' : 'pending',
          }),
          expect.objectContaining({ key: '40', text: '17:11 continue' }),
        ]);
        expect(after.messages).toEqual([delivered, old]);
      }
    );

    it('steer 等待期间不打断真实轮次的流式状态和运行中工具', () => {
      const assistant: ProjectedMessage = {
        role: 'assistant',
        timestamp: 110,
        stopReason: 'pending',
        content: [
          { type: 'toolCall', id: 'tool', name: 'bash', arguments: { command: 'pwd' } },
          { type: 'text', text: 'working' },
        ],
      };
      const messages = [
        { ...user('execute'), timestamp: 100 },
        assistant,
        { ...user('steer'), optimistic: true, timestamp: 120 },
      ];
      const timeline = buildTimeline(messages, true);
      expect(timeline.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual([
        'execute',
        'steer',
      ]);
      expect(timeline.find((item) => item.kind === 'text')).toMatchObject({ streaming: true });
      expect(timeline.find((item) => item.kind === 'tool')).toMatchObject({ state: 'running' });
      expect(timeline.find((item) => item.kind === 'user')).toMatchObject({ canCollapse: false });
      expect(timeline.at(-1)).toMatchObject({
        kind: 'user',
        text: 'steer',
        deliveryState: 'pending',
        canCollapse: false,
      });
      const folded = foldTimeline(timeline, true, new Set(), {
        turnOverrides: new Map([
          ['0', true],
          ['2', true],
        ]),
      });
      expect(folded.find((item) => item.kind === 'text')).toMatchObject({ streaming: true });
      expect(folded.at(-1)).not.toHaveProperty('collapsed', true);
    });

    it('只将有可靠时间的本地消息插到较晚用户轮次之前，不排序权威历史，也不拆开旧轮回复', () => {
      const messages: TimelineMessage[] = [
        { ...user('earlier turn'), timestamp: 10 },
        { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }], timestamp: 50 },
        { ...user('new turn'), timestamp: 40 },
        { ...user('local first'), optimistic: true, timestamp: 20 },
        { ...user('local second'), optimistic: true, timestamp: 30 },
        { ...user('no time'), optimistic: true },
      ];
      const timeline = buildTimeline(messages, false);
      expect(
        timeline
          .filter((item) => item.kind === 'user' || item.kind === 'text')
          .map((item) => item.text)
      ).toEqual([
        'earlier turn',
        'earlier reply',
        'local first',
        'local second',
        'new turn',
        'no time',
      ]);
      expect(timeline.filter((item) => item.kind === 'user').map((item) => item.key)).toEqual([
        '0',
        '3',
        '4',
        '2',
        '5',
      ]);
    });
  });

  it('historyBaseIndex 让行 key 用绝对下标，prepend 后已有行 key 不变', () => {
    const timeline = buildTimeline([user('tail')], false, [], undefined, {
      historyBaseIndex: 40,
    });
    expect(timeline[0]).toMatchObject({ kind: 'user', key: '40', text: 'tail' });
  });

  describe('user 消息发送时间与任务完成耗时统计', () => {
    it('user 行记录本轮首个 assistant 回复的模型与时间，供回复身份头显示', () => {
      const timeline = buildTimeline(
        [
          user('第一轮'),
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'a' }],
            model: 'model-a',
            timestamp: 10,
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'b' }],
            model: 'model-b',
            timestamp: 20,
          },
          user('第二轮'),
        ],
        false
      );
      const users = timeline.filter((item) => item.kind === 'user');
      expect(users[0]).toMatchObject({ replyModel: 'model-a', replyAt: 10 });
      expect(users[1]).not.toHaveProperty('replyModel');
      expect(users[1]).not.toHaveProperty('replyAt');
    });

    it('首个回复失败被重试（虚拟模型换成员）时，回复头用随后成功那条的模型', () => {
      const timeline = buildTimeline(
        [
          user('一轮'),
          {
            role: 'assistant',
            content: [],
            model: 'primary',
            stopReason: 'error',
            errorMessage: '503',
            timestamp: 10,
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            model: 'backup',
            timestamp: 20,
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'more' }],
            model: 'later',
            timestamp: 30,
          },
        ],
        false
      );
      expect(timeline.find((item) => item.kind === 'user')).toMatchObject({
        replyModel: 'backup',
        replyAt: 10,
      });
    });

    it('user 消息保留发送时间戳 timestamp', () => {
      const timeline = buildTimeline(
        [{ role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1726700000000 }],
        false
      );
      expect(timeline[0]).toMatchObject({
        kind: 'user',
        timestamp: 1726700000000,
      });
    });

    it('会话运行中（running=true）时，最新一轮 assistant 消息的 turnDurationMs 为 undefined', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '写个函数' }], timestamp: 1726700000000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '正在写...' }],
            duration: 2000,
            stopReason: 'pending',
            timing: { stepStartMs: 1726700000000, completedMs: 1726700002000 },
          },
        ],
        true
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0].kind).toBe('text');
      expect(textItems[0].turnDurationMs).toBeUndefined();
      expect(textItems[0].turnEnd).toBeUndefined();
    });

    it('会话结束后（running=false），assistant 消息计算本轮模型与工具活跃总耗时', () => {
      const timeline = buildTimeline(
        [
          {
            role: 'user',
            content: [{ type: 'text', text: '查一下并修改' }],
            timestamp: 1726700000000,
          },
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }],
            duration: 1500,
            stopReason: 'toolUse',
            timing: { stepStartMs: 1726700000000, completedMs: 1726700001500 },
          },
          {
            role: 'toolResult',
            toolCallId: 't1',
            toolName: 'read',
            toolDurationMs: 800,
            content: [{ type: 'text', text: 'content' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '已读完' }],
            duration: 2200,
            stopReason: 'stop',
            timing: { stepStartMs: 1726700002300, completedMs: 1726700004500 },
          },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0]).toMatchObject({
        kind: 'text',
        turnEnd: true,
        turnDurationMs: 4500, // 1500 + 800 + 2200
        perf: { runMs: 2200, turnMs: 4500 },
      });
    });

    it('整轮耗时不计 ask_user 等待时间', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '问个问题' }], timestamp: 1726700000000 },
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { question: '确定？' } },
            ],
            duration: 1000,
            stopReason: 'toolUse',
            timing: { stepStartMs: 1726700000000, completedMs: 1726700001000 },
          },
          {
            role: 'toolResult',
            toolCallId: 'q1',
            toolName: 'ask_user',
            toolDurationMs: 60000,
            content: [{ type: 'text', text: '确定' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '好的已继续' }],
            duration: 2000,
            stopReason: 'stop',
            timing: { stepStartMs: 1726700061000, completedMs: 1726700063000 },
          },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0]).toMatchObject({
        kind: 'text',
        turnEnd: true,
        turnDurationMs: 3000, // 1000 + 2000，排除 ask_user 的 60000
        perf: { runMs: 2000, turnMs: 3000 },
      });
    });

    it('多轮对话：历史轮次保留耗时，当前运行中轮次耗时待完结', () => {
      const timeline = buildTimeline(
        [
          // 第一轮
          { role: 'user', content: [{ type: 'text', text: '第一轮' }], timestamp: 1000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '回答1' }],
            duration: 1200,
            stopReason: 'stop',
            timing: { stepStartMs: 1000, completedMs: 2200 },
          },
          // 第二轮（进行中）
          { role: 'user', content: [{ type: 'text', text: '第二轮' }], timestamp: 3000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '回答2进行中...' }],
            duration: 800,
            stopReason: 'pending',
            timing: { stepStartMs: 3000 },
          },
        ],
        true
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems).toHaveLength(2);
      expect(textItems[0]).toMatchObject({
        kind: 'text',
        turnDurationMs: 1200,
      });
      expect(textItems[1]).toMatchObject({
        kind: 'text',
      });
      expect(textItems[1].turnDurationMs).toBeUndefined();
    });

    it('若无 stepRunMs/toolDurationMs，则以 assistant 时间戳与 user 时间戳之差作为耗时兜底', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1000 },
          { role: 'assistant', content: [{ type: 'text', text: '你好呀' }], timestamp: 3500 },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems).toHaveLength(1);
      expect(textItems[0]).toMatchObject({
        kind: 'text',
        turnEnd: true,
        turnDurationMs: 2500, // 3500 - 1000
      });
    });
    it('最新一轮 stopReason=pending 时不展示耗时（即使 running=false）', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '半截' }],
            duration: 2000,
            stopReason: 'pending',
            timing: { stepStartMs: 1000, completedMs: 3000 },
          },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0]).toMatchObject({ kind: 'text', turnEnd: true });
      expect(textItems[0].kind === 'text' && textItems[0].turnDurationMs).toBeUndefined();
    });

    it('仅有 duration、无 timing.completedMs 时不计入活跃用时', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '你好' }] },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '你好呀' }],
            duration: 5000,
            stopReason: 'stop',
          },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0]).toMatchObject({ kind: 'text', turnEnd: true });
      expect(textItems[0].kind === 'text' && textItems[0].turnDurationMs).toBeUndefined();
    });

    it('有 ask_user 但缺 step 计时时，不用墙钟差兜底（避免把等待算进去）', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '问个问题' }], timestamp: 1000 },
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { question: '确定？' } },
            ],
            stopReason: 'toolUse',
          },
          {
            role: 'toolResult',
            toolCallId: 'q1',
            toolName: 'ask_user',
            content: [{ type: 'text', text: '确定' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '好的' }],
            timestamp: 70_000,
            stopReason: 'stop',
          },
        ],
        false
      );
      const textItems = timeline.filter((item) => item.kind === 'text');
      expect(textItems[0]).toMatchObject({ kind: 'text', turnEnd: true });
      expect(textItems[0].kind === 'text' && textItems[0].turnDurationMs).toBeUndefined();
    });

    it('已完结轮次的 user 消息亦保留本轮任务耗时 turnDurationMs', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '写个工具' }], timestamp: 1000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '完成了' }],
            duration: 3200,
            timing: { stepStartMs: 1000, completedMs: 4200 },
          },
        ],
        false
      );
      const userItem = timeline.find((item) => item.kind === 'user');
      expect(userItem).toMatchObject({
        kind: 'user',
        timestamp: 1000,
        turnDurationMs: 3200,
      });
    });
  });

  describe('会话按轮次折叠 (Turn Collapse)', () => {
    const fixtureMessages: ProjectedMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '问题1' }], timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '1.ts' } }],
        duration: 1000,
        timing: { stepStartMs: 1000, completedMs: 2000 },
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'read',
        toolDurationMs: 500,
        content: [{ type: 'text', text: 'ok' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '回答1' }],
        duration: 1500,
        timing: { stepStartMs: 2500, completedMs: 4000 },
      },
      { role: 'user', content: [{ type: 'text', text: '问题2' }], timestamp: 5000 },
      { role: 'assistant', content: [{ type: 'text', text: '回答2' }], duration: 2000 },
    ];

    it('无回复或处于 running 的最新轮次不可折叠，有回复的历史轮次可折叠', () => {
      const runningTimeline = buildTimeline(fixtureMessages, true);
      const usersRunning = users(runningTimeline);
      expect(usersRunning[0].canCollapse).toBe(true);
      // 最新一轮仍在生成中，不可折叠
      expect(usersRunning[1].canCollapse).toBe(false);

      // 仅一条 user 消息且无后续回复
      const emptyReplyTimeline = buildTimeline(
        [{ role: 'user', content: [{ type: 'text', text: '孤立消息' }] }],
        false
      );
      const singleUser = users(emptyReplyTimeline)[0];
      expect(singleUser.canCollapse).toBe(false);

      // 后面只有 Pi 插入的 system 消息，不算回复
      const systemOnlyTimeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '孤立消息' }] },
          { role: 'system', content: [] },
        ],
        false
      );
      expect(users(systemOnlyTimeline)[0].canCollapse).toBe(false);
    });

    it('折叠指定轮次：隐藏当前消息的所有回复（tool/text），保留发送信息、时间戳与耗时', () => {
      const timeline = buildTimeline(fixtureMessages, false);
      const user1 = timeline[0];
      expect(user1.kind).toBe('user');

      const folded = foldTimeline(timeline, false, new Set(), {
        turnOverrides: new Map([[user1.key, true]]),
      });

      // 折叠后：第一轮只剩 user 项，且标注 collapsed: true，保留 timestamp 与 turnDurationMs
      expect(folded[0]).toMatchObject({
        kind: 'user',
        key: user1.key,
        text: '问题1',
        timestamp: 1000,
        turnDurationMs: 3000, // 1000 + 500 + 1500
        collapsed: true,
      });

      // 验证第一轮的回复全部被隐藏，第二轮正常保留
      const kinds = folded.map((item) => item.kind);
      expect(kinds).toEqual(['user', 'user', 'text']);
      expect(folded[1]).toMatchObject({
        kind: 'user',
        text: '问题2',
      });
      expect(users(folded)[1].collapsed).toBeFalsy();
      expect(folded[2]).toMatchObject({
        kind: 'text',
        text: '回答2',
      });
    });

    it('未折叠的轮次中 user 项标记 collapsed 为 false，回复内容完整平铺', () => {
      const timeline = buildTimeline(fixtureMessages, false);
      const folded = foldTimeline(timeline, false, new Set(), {
        turnOverrides: new Map(),
      });
      const userItems = users(folded);
      expect(userItems[0].collapsed).toBeFalsy();
      expect(userItems[1].collapsed).toBeFalsy();
    });

    it('running=true 时，正在生成的最新一轮不被折叠，确保实时输出可见', () => {
      const timeline = buildTimeline(fixtureMessages, true);
      const user2 = userByText(timeline, '问题2');

      // 即使 turnOverrides 显式要求折叠最新轮次
      const folded = foldTimeline(timeline, true, new Set(), {
        turnOverrides: new Map([[user2.key, true]]),
      });

      const user2Folded = userByText(folded, '问题2');
      expect(user2Folded.collapsed).toBeFalsy();
      // 回复内容依然可见
      expect(folded.some((item) => item.kind === 'text' && item.text === '回答2')).toBe(true);
    });

    it('从 turnOverrides 移除 key 时，该轮回复重新完整展开', () => {
      const timeline = buildTimeline(fixtureMessages, false);
      const user1 = timeline[0];

      const collapsed = foldTimeline(timeline, false, new Set(), {
        turnOverrides: new Map([[user1.key, true]]),
      });
      expect(collapsed.map((item) => item.kind)).toEqual(['user', 'user', 'text']);

      const expanded = foldTimeline(timeline, false, new Set(), {
        turnOverrides: new Map(),
      });
      expect(expanded.length).toBeGreaterThan(collapsed.length);
      expect(users(expanded)[0].collapsed).toBeFalsy();
    });

    describe('autoCollapseCompletedTurns (轮次完成后自动折叠)', () => {
      it('进行中的本轮会话(running=true)实时保持展开，完结的历史轮次自动折叠', () => {
        const runningTimeline = buildTimeline(fixtureMessages, true);
        const foldedRunning = foldTimeline(runningTimeline, true, new Set(), {
          autoCollapseCompletedTurns: true,
        });

        // 历史已完结的轮次 1 自动折叠
        const user1 = userByText(foldedRunning, '问题1');
        expect(user1.collapsed).toBe(true);
        // 第一轮的内容已折叠隐藏
        expect(foldedRunning.some((i) => i.kind === 'text' && i.text === '回答1')).toBe(false);

        // 正在运行的本轮会话 2 必须保持展开，不可被折叠
        const user2 = userByText(foldedRunning, '问题2');
        expect(user2.collapsed).toBeFalsy();
        // 本轮的回答内容可见
        expect(foldedRunning.some((i) => i.kind === 'text' && i.text === '回答2')).toBe(true);
      });

      it('会话完成后(running=false)，最后一个会话不自动折叠以便查看输出，历史轮次自动折叠', () => {
        // 当 running 变为 false，整个会话已完结，但最新的一轮（最后一个会话）保持展开
        const completedTimeline = buildTimeline(fixtureMessages, false);
        const foldedCompleted = foldTimeline(completedTimeline, false, new Set(), {
          autoCollapseCompletedTurns: true,
        });

        // 历史轮次 1 自动折叠
        const user1 = userByText(foldedCompleted, '问题1');
        expect(user1.collapsed).toBe(true);
        expect(foldedCompleted.some((i) => i.kind === 'text' && i.text === '回答1')).toBe(false);

        // 最后一个会话 2 不自动折叠，保持展开供用户查看输出内容
        const user2 = userByText(foldedCompleted, '问题2');
        expect(user2.collapsed).toBeFalsy();
        expect(foldedCompleted.some((i) => i.kind === 'text' && i.text === '回答2')).toBe(true);
      });

      it('发送新消息后，原最后一轮成为历史轮次并自动折叠，新消息成为最后一轮保持展开', () => {
        const threeTurnMessages: ProjectedMessage[] = [
          ...fixtureMessages,
          { role: 'user', content: [{ type: 'text', text: '问题3' }], timestamp: 9000 },
          { role: 'assistant', content: [{ type: 'text', text: '回答3' }], duration: 1000 },
        ];
        const threeTimeline = buildTimeline(threeTurnMessages, false);
        const folded = foldTimeline(threeTimeline, false, new Set(), {
          autoCollapseCompletedTurns: true,
        });

        const user1 = userByText(folded, '问题1');
        const user2 = userByText(folded, '问题2');
        const user3 = userByText(folded, '问题3');

        // 轮次 1 与原最后一轮 2 现在都是历史轮次，均自动折叠
        expect(user1.collapsed).toBe(true);
        expect(user2.collapsed).toBe(true);
        expect(folded.some((i) => i.kind === 'text' && i.text === '回答1')).toBe(false);
        expect(folded.some((i) => i.kind === 'text' && i.text === '回答2')).toBe(false);

        // 新消息（轮次 3）作为最新的最后一个会话，保持展开
        expect(user3.collapsed).toBeFalsy();
        expect(folded.some((i) => i.kind === 'text' && i.text === '回答3')).toBe(true);
      });

      it('通过 turnOverrides 显式展开已折叠的轮次', () => {
        const completedTimeline = buildTimeline(fixtureMessages, false);
        const user2 = userByText(completedTimeline, '问题2');
        const user1Key = completedTimeline[0].key;
        const folded = foldTimeline(completedTimeline, false, new Set(), {
          autoCollapseCompletedTurns: true,
          turnOverrides: new Map([[user1Key, false]]),
        });

        const user1 = userByText(folded, '问题1');
        expect(user1.collapsed).toBeFalsy();
        // 第一轮内容已展开可见
        expect(folded.some((i) => i.kind === 'text' && i.text === '回答1')).toBe(true);

        // 第二轮作为最后一轮，默认也是展开状态
        const user2Folded = userByText(folded, '问题2');
        expect(user2Folded.collapsed).toBeFalsy();

        // 通过 turnOverrides 显式收起最后一轮
        const foldedWithCollapsedLast = foldTimeline(completedTimeline, false, new Set(), {
          autoCollapseCompletedTurns: true,
          turnOverrides: new Map([[user2.key, true]]),
        });
        const user2ExplicitlyCollapsed = userByText(foldedWithCollapsedLast, '问题2');
        expect(user2ExplicitlyCollapsed.collapsed).toBe(true);
        expect(foldedWithCollapsedLast.some((i) => i.kind === 'text' && i.text === '回答2')).toBe(
          false
        );
      });
    });

    it('后台任务注入消息（task-note）不回写耗时到上一条真实 user 消息', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '问题1' }], timestamp: 1000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '回答1' }],
            duration: 1000,
            timing: { stepStartMs: 1000, completedMs: 2000 },
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '<background-task-update>\n后台完成\n</background-task-update>',
              },
            ],
            timestamp: 5000,
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '收到' }],
            duration: 9000,
            timing: { stepStartMs: 5000, completedMs: 14000 },
          },
          { role: 'user', content: [{ type: 'text', text: '问题2' }], timestamp: 20000 },
          { role: 'assistant', content: [{ type: 'text', text: '回答2' }], duration: 100 },
        ],
        false
      );
      expect(userByText(timeline, '问题1').turnDurationMs).toBe(1000);
    });

    it('折叠轮次时压缩标记与错误行保留可见，不随回复一起隐藏', () => {
      const timeline = buildTimeline(
        [
          { role: 'user', content: [{ type: 'text', text: '问题1' }], timestamp: 1000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '回答1' }],
            duration: 1000,
            timing: { stepStartMs: 1000, completedMs: 2000 },
          },
          {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: '模型出错',
          },
          { role: 'compactionSummary', content: [{ type: 'text', text: '摘要' }] },
          { role: 'user', content: [{ type: 'text', text: '问题2' }], timestamp: 5000 },
          { role: 'assistant', content: [{ type: 'text', text: '回答2' }], duration: 100 },
        ],
        false
      );
      const folded = foldTimeline(timeline, false, new Set(), {
        autoCollapseCompletedTurns: true,
      });
      expect(folded.map((i) => i.kind)).toEqual(['user', 'error', 'compaction', 'user', 'text']);
      expect(folded[0]).toMatchObject({ kind: 'user', text: '问题1', collapsed: true });
    });
  });
});

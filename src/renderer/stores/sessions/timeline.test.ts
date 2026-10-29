import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { applyAgentEvent, emptyProjection, type TimelineMessage } from './reducer';
import {
  buildTimeline,
  completedEditWriteFingerprint,
  exploreStepsKey,
  foldTimeline,
  historyPageChrome,
  parseSandboxOutput,
  patchStreamingTimeline,
  readImagePreviewPath,
  shouldAutoExpandAppliedFileChanges,
  shouldPrefetchOlderHistory,
  shouldShowToolOutputAfterFileChanges,
  summarizeSandboxCalls,
  type TimelineItem,
  terminalErrorText,
  thinkingRowExpanded,
} from './timeline';

const user = (text: string): ProjectedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

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

  it('toolResult 折进对应 toolCall 条目，不单独成行', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: 'file body' }],
        },
      ],
      false
    );
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'read',
      summary: 'a.ts',
      output: 'file body',
      state: 'ok',
    });
  });

  it('read 图片（含 svg / 动图）把可预览的绝对路径带到工具行，文本和失败不带', () => {
    expect(readImagePreviewPath({ path: '/tmp/a.png' })).toBe('/tmp/a.png');
    expect(readImagePreviewPath({ path: '/tmp/icon.svg' })).toBe('/tmp/icon.svg');
    expect(readImagePreviewPath({ path: '/tmp/anim.gif' })).toBe('/tmp/anim.gif');
    expect(readImagePreviewPath({ path: '/tmp/anim.webp' })).toBe('/tmp/anim.webp');
    expect(readImagePreviewPath({ path: 'assets/logo.svg' }, '/proj')).toBe(
      '/proj/assets/logo.svg'
    );
    expect(readImagePreviewPath({ path: 'a.ts' }, '/proj')).toBeNull();
    expect(readImagePreviewPath({ path: 'a.png' })).toBeNull();
    expect(readImagePreviewPath({})).toBeNull();
    expect(readImagePreviewPath({ path: 'C:\\a\\b.png' })).toBe('C:\\a\\b.png');
    expect(readImagePreviewPath({ path: 'x.png' }, 'C:\\proj')).toBe('C:\\proj\\x.png');
    expect(readImagePreviewPath({ path: '\\\\server\\share\\a.png' })).toBeNull();
    expect(readImagePreviewPath({ path: '//server/share/a.png' })).toBeNull();
    expect(readImagePreviewPath({ path: 1, file_path: '/tmp/a.webp' })).toBe('/tmp/a.webp');

    const image = buildTimeline(
      [
        user('看图'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'img', name: 'read', arguments: { path: 'shot.png' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'img',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: 'Read image file [image/png]' }],
        },
      ],
      false,
      [],
      '/proj'
    );
    expect(image[1]).toMatchObject({
      kind: 'tool',
      name: 'read',
      imagePath: '/proj/shot.png',
      output: 'Read image file [image/png]',
    });

    const failed = buildTimeline(
      [
        user('看图'),
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'bad', name: 'read', arguments: { path: '/tmp/missing.png' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'bad',
          toolName: 'read',
          isError: true,
          content: [{ type: 'text', text: 'ENOENT' }],
        },
      ],
      false,
      [],
      '/proj'
    );
    expect(failed[1]).toMatchObject({ kind: 'tool', state: 'error' });
    expect(failed[1]).not.toHaveProperty('imagePath');
  });

  it('把 toolResult 的 RTK 元数据完整带到对应工具行', () => {
    const rtk = {
      status: 'compressed' as const,
      originalCommand: 'git status --short',
      rewrittenCommand: 'rtk git status --short',
      inputTokens: 800,
      outputTokens: 200,
      reason: 'supported command',
    };
    const timeline = buildTimeline(
      [
        user('检查状态'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 't1',
              name: 'bash',
              arguments: { command: rtk.originalCommand },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'clean' }],
          rtk,
        },
      ],
      false
    );

    expect(timeline[1]).toMatchObject({ kind: 'tool', rtk });
  });

  it('托管拒绝的判定记录带到对应工具行，工具行为失败', () => {
    const approvalReview = {
      verdict: 'deny' as const,
      model: 'jev-latest',
      allow: 0.67,
      ask: 0.1,
      block: 0.23,
      reason: 'unclear_target' as const,
    };
    const timeline = buildTimeline(
      [
        user('看下数据库'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '.env' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'read',
          isError: true,
          content: [{ type: 'text', text: 'Auto-managed approval denied this tool call.' }],
          approvalReview,
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({ kind: 'tool', state: 'error', approvalReview });
  });

  it('运行中的命令行带调用 id 供转后台；转后台的结果带任务 id', () => {
    const call = (id: string, name: string): TimelineMessage => ({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: { command: 'sleep 99' } }],
    });
    const running = buildTimeline([user('跑'), call('t1', 'bash')], true);
    expect(running[1]).toMatchObject({ kind: 'tool', state: 'running', callId: 't1' });
    expect(buildTimeline([user('读'), call('r1', 'read')], true)[1]).not.toHaveProperty('callId');

    const moved = buildTimeline(
      [
        user('跑'),
        call('t1', 'powershell'),
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'powershell',
          content: [{ type: 'text', text: 'moved' }],
          backgroundTaskId: 'task-1-abc',
        },
      ],
      false
    );
    expect(moved[1]).toMatchObject({ kind: 'tool', state: 'ok', backgroundTaskId: 'task-1-abc' });
    expect(moved[1]).not.toHaveProperty('callId');
  });

  it('运行中的阻塞等待带调用 id 与等待类型，供「不等了」', () => {
    const call = (id: string, name: string, args: Record<string, unknown>): TimelineMessage => ({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: args }],
    });
    const row = (name: string, args: Record<string, unknown>) =>
      buildTimeline([user('等'), call('w1', name, args)], true)[1];
    expect(row('subagent', { operation: 'wait', runId: 'r' })).toMatchObject({
      callId: 'w1',
      waiting: 'subagent',
    });
    expect(
      row('subagent', { operation: 'spawn', description: 'd', prompt: 'p', wait: true })
    ).toMatchObject({ callId: 'w1', waiting: 'subagent' });
    expect(row('task_output', { taskId: 't', timeout_ms: 1000 })).toMatchObject({
      callId: 'w1',
      waiting: 'task',
    });
    expect(
      row('subagent', { operation: 'spawn', description: 'd', prompt: 'p' })
    ).not.toHaveProperty('waiting');
    expect(row('task_output', { taskId: 't' })).not.toHaveProperty('callId');
  });

  it('exec 摘要用首行 JS，source 保留全文，结果 JSON 解析为 value/calls', () => {
    const code = 'const pkg = await read({ path: "package.json" });\nreturn pkg;';
    const output = JSON.stringify({
      status: 'completed',
      value: { ok: true },
      calls: [
        { name: 'read', ok: true },
        { name: 'ls', ok: true },
      ],
    });
    const timeline = buildTimeline(
      [
        user('试试 code mode'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'e1', name: 'exec', arguments: { code } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'e1',
          toolName: 'exec',
          isError: false,
          content: [{ type: 'text', text: output }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'exec',
      summary: 'const pkg = await read({ path: "package.json" });',
      source: code,
      output,
      state: 'ok',
    });
    expect(parseSandboxOutput(output)).toEqual({
      status: 'completed',
      value: { ok: true },
      calls: [
        { name: 'read', ok: true },
        { name: 'ls', ok: true },
      ],
    });
  });

  it('codemode 卡片：剥掉 pi 结果头，嵌套调用摘要来自 codemodeCalls，失败标 error', () => {
    const code = 'const a = await tools.read({ path: "a.ts" });\nreturn a.length;';
    const timeline = buildTimeline(
      [
        user('用 codemode'),
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'codemode', arguments: { code } },
            { type: 'toolCall', id: 'c2', name: 'codemode', arguments: { code: 'throw 1' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'codemode',
          isError: false,
          codemodeCalls: [{ name: 'read', ok: true, summary: 'a.ts' }],
          content: [{ type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n42' }],
        },
        {
          role: 'toolResult',
          toolCallId: 'c2',
          toolName: 'codemode',
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Script failed\nWall time 0.0 seconds\nOutput:\nScript error: 1',
            },
          ],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'codemode',
      source: code,
      output: '42',
      state: 'ok',
      sandbox: { status: 'completed', value: '42', calls: [{ name: 'read', ok: true }] },
    });
    expect(timeline[2]).toMatchObject({
      state: 'error',
      sandbox: { status: 'failed', error: 'Script error: 1', calls: [] },
    });
  });

  it('codemode 运行中按 <parent>/<n> 统计嵌套待审批', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'codemode', arguments: { code: 'x' } }],
        },
      ],
      true,
      [],
      undefined,
      {
        pendingApprovals: [
          {
            requestId: 'apr-1',
            tool: 'apply_patch',
            kind: 'file-edit',
            summary: 'a.ts',
            toolCallId: 'c1/1',
          },
          {
            requestId: 'apr-2',
            tool: 'bash',
            kind: 'command',
            summary: 'ls',
            toolCallId: 'c10/1',
          },
        ],
      }
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'running', nestedPending: 1 });
  });

  it('exec 调用按工具名首次出现顺序计数', () => {
    expect(
      summarizeSandboxCalls([
        { name: 'grep', ok: true },
        { name: 'read', ok: true },
        { name: 'grep', ok: false },
        { name: 'grep', ok: true },
      ])
    ).toBe('grep ×3 read ×1');
    expect(summarizeSandboxCalls([])).toBe('');
  });

  it('Hashline edit 从头部提取路径并从 toolResult 生成 edits', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'hashline-1',
              name: 'edit',
              arguments: { input: '[src/a.ts#ABCD]\nPUT 1.=1:\n+hello' },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'hashline-1',
          toolName: 'edit',
          editDiff: { oldText: 'world\n', newText: 'hello\n' },
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'edit',
      summary: 'src/a.ts',
      edits: [{ oldText: 'world\n', newText: 'hello\n' }],
      state: 'ok',
    });
  });

  it('legacy 单块 {path,oldText,newText} edit 也生成 edits', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'e1',
              name: 'edit',
              arguments: { path: 'src/a.ts', oldText: 'world', newText: 'hello' },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'e1',
          toolName: 'edit',
          content: [{ type: 'text', text: 'Successfully replaced 1 block(s)' }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      name: 'edit',
      summary: 'src/a.ts',
      edits: [{ oldText: 'world', newText: 'hello' }],
    });
  });

  it('edit 执行失败时不合成 diff：文件没改，不能显示成已应用', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'e-err',
              name: 'edit',
              arguments: {
                path: 'src/a.ts',
                input: '[src/a.ts#ABCD]\nPUT 1.=1:\n+x',
                oldText: 'world',
                newText: 'hello',
              },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'e-err',
          toolName: 'edit',
          isError: true,
          content: [
            { type: 'text', text: 'edit accepts either hashline input or replace edits, not both' },
          ],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({ name: 'edit', state: 'error', edits: null });
  });

  it('replace edit 没有 editDiff 时继续使用参数中的路径与 edits', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'replace-1',
              name: 'edit',
              arguments: { path: 'b.ts', edits: [{ oldText: 'a', newText: 'b' }] },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'replace-1',
          toolName: 'edit',
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      summary: 'b.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
      state: 'ok',
    });
  });

  it('参数 edits 优先于 toolResult editDiff', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'both-1',
              name: 'edit',
              arguments: { path: 'b.ts', edits: [{ oldText: 'a', newText: 'b' }] },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'both-1',
          toolName: 'edit',
          editDiff: { oldText: 'wrong-old', newText: 'wrong-new' },
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({
      summary: 'b.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
  });

  it('仍在运行的 Hashline edit 显示头部路径且 edits 为 null', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'running-1',
              name: 'edit',
              arguments: { input: '[src/a.ts#ABCD]\nPUT 1.=1:\n+hello' },
            },
          ],
        },
      ],
      true
    );
    expect(timeline[1]).toMatchObject({ summary: 'src/a.ts', edits: null, state: 'running' });
  });

  it('不完整 editDiff 不生成 edits 且不抛错', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'dirty-1', name: 'edit', arguments: {} }],
        },
        {
          role: 'toolResult',
          toolCallId: 'dirty-1',
          toolName: 'edit',
          editDiff: { oldText: 'before\n' } as unknown as { oldText: string; newText: string },
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      false
    );
    expect(timeline[1]).toMatchObject({ kind: 'tool', edits: null, state: 'ok' });
  });

  it('无结果的 toolCall 在会话 running 且 pending reviewing 时标 reviewing', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'write', arguments: { path: 'a.ts' } }],
        },
      ],
      true,
      [],
      undefined,
      {
        pendingApprovals: [
          {
            requestId: 'apr-1',
            tool: 'write',
            kind: 'file-write',
            summary: 'a.ts',
            toolCallId: 't1',
            phase: 'reviewing',
          },
        ],
      }
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'reviewing', name: 'write' });
  });

  it('无结果的 toolCall 在会话 running 时标为 running', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm test' } },
          ],
        },
      ],
      true
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'running', summary: 'pnpm test' });
  });

  it('无结果的 toolCall 在会话 idle 时标为 error（中断残留，不再 loading）', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm test' } },
          ],
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'error', output: null });
  });

  it('历史轮次里缺结果的 toolCall（abort 残留/同步未齐）不标 running，即使会话正在运行', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'edit', arguments: { path: 'a.ts' } }],
        },
        user('继续'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'ls' } }],
        },
      ],
      true
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', name: 'edit', state: 'ok' });
    expect(timeline[2]).toMatchObject({ kind: 'tool', name: 'bash', state: 'running' });
  });

  it('末条 assistant 后只跟 toolResult：已完成的标终态，并行未完成的仍标 running', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'pnpm test' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          isError: false,
          content: [{ type: 'text', text: 'body' }],
        },
      ],
      true
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', name: 'read', state: 'ok' });
    expect(timeline[1]).toMatchObject({ kind: 'tool', name: 'bash', state: 'running' });
  });

  it('失败的 toolResult 标为 error', () => {
    const timeline = buildTimeline(
      [
        { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'edit' }] },
        {
          role: 'toolResult',
          toolCallId: 't1',
          isError: true,
          content: [{ type: 'text', text: 'no match' }],
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'error', output: 'no match' });
  });

  it('text 与 thinking 各自成块，最后一块在 running 时标 streaming', () => {
    const timeline = buildTimeline(
      [
        user('hi'),
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '想一想' },
            { type: 'text', text: '回答' },
          ],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([
      { kind: 'user' },
      { kind: 'thinking', streaming: false },
      { kind: 'text', streaming: true },
    ]);
    expect(timeline.some((item) => item.kind === 'text' && item.turnEnd)).toBe(false);
  });

  it('idle 时本轮最后一条正文标 turnEnd，中间步不标', () => {
    const timeline = buildTimeline(
      [
        user('改'),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '先看' },
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: 'ok' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '结论' }],
        },
        user('还没答'),
      ],
      false
    );
    expect(timeline.filter((item) => item.kind === 'text')).toMatchObject([
      { text: '先看' },
      { text: '结论', turnEnd: true },
    ]);
    expect(timeline.filter((item) => item.kind === 'text' && item.turnEnd)).toHaveLength(1);
  });

  it('整段 <thinking> 包裹的 text 变成 thinking 块，标签不入正文', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<thinking>\n**Analyzing** antigravity.ts\n</thinking>',
            },
          ],
        },
      ],
      false
    );
    expect(timeline).toEqual([
      {
        kind: 'thinking',
        key: '0-0',
        text: '**Analyzing** antigravity.ts',
        streaming: false,
        durationMs: null,
      },
    ]);
  });

  it('正文中夹着的 <thinking> 拆成 thinking 与 text，工具行不受影响', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<thinking>\n先 grep\n</thinking>',
            },
            { type: 'toolCall', id: 't1', name: 'grep', arguments: { pattern: 'high' } },
            {
              type: 'text',
              text: '前缀<thinking>再读文件</thinking>\n结论',
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'grep',
          isError: false,
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      false
    );
    expect(timeline).toMatchObject([
      { kind: 'thinking', text: '先 grep', streaming: false },
      { kind: 'tool', name: 'grep', state: 'ok' },
      { kind: 'text', text: '前缀' },
      { kind: 'thinking', text: '再读文件' },
      { kind: 'text', text: '结论' },
    ]);
  });

  it('流式中未闭合的 <thinking> 当 thinking 跟看，不露开标签', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '<thinking>\n正在想' }],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([{ kind: 'thinking', text: '正在想', streaming: true }]);
  });

  it('多 step 轮次：末 step 的 turnMs 累计模型与工具活跃用时，中间 step 不带', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          stopReason: 'toolUse',
          timing: { stepStartMs: 1_000, firstTokenMs: 1_500, completedMs: 3_000 },
          content: [
            { type: 'text', text: '先看看' },
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'read',
          isError: false,
          toolDurationMs: 30_000,
          content: [{ type: 'text', text: 'body' }],
        },
        {
          role: 'assistant',
          stopReason: 'stop',
          timing: { stepStartMs: 60_000, firstTokenMs: 61_000, completedMs: 87_000 },
          content: [{ type: 'text', text: '完成' }],
        },
      ],
      false
    );
    const texts = timeline.filter((item) => item.kind === 'text');
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatchObject({ perf: { runMs: 2_000 } });
    expect(texts[0].kind === 'text' && texts[0].perf?.turnMs).toBeUndefined();
    // 模型 2s + 工具 30s + 模型 27s；中间 27s 空档不计。
    expect(texts[1]).toMatchObject({ perf: { runMs: 27_000, turnMs: 59_000 } });
  });

  it('整轮总用时不包含等待 ask_user 回答的时间', () => {
    const timeline = buildTimeline(
      [
        user('先问我再继续'),
        {
          role: 'assistant',
          stopReason: 'toolUse',
          duration: 2_000,
          timing: { stepStartMs: 1_000, completedMs: 3_000 },
          content: [
            {
              type: 'toolCall',
              id: 'ask-1',
              name: 'ask_user',
              arguments: { question: '继续吗？' },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'ask-1',
          toolName: 'ask_user',
          toolDurationMs: 20 * 60_000,
          content: [{ type: 'text', text: '继续' }],
        },
        {
          role: 'assistant',
          stopReason: 'stop',
          duration: 3_000,
          timing: { stepStartMs: 20 * 60_000 + 3_000, completedMs: 20 * 60_000 + 6_000 },
          content: [{ type: 'text', text: '完成' }],
        },
      ],
      false
    );
    const lastText = timeline.findLast((item) => item.kind === 'text');
    expect(lastText).toMatchObject({ perf: { runMs: 3_000, turnMs: 5_000 } });
  });

  it('单 step 轮次不带 turnMs（与 runMs 重复）；新一轮 user 消息重置轮起点', () => {
    const timeline = buildTimeline(
      [
        user('a'),
        {
          role: 'assistant',
          stopReason: 'stop',
          timing: { stepStartMs: 1_000, completedMs: 2_000 },
          content: [{ type: 'text', text: '一' }],
        },
        user('b'),
        {
          role: 'assistant',
          stopReason: 'stop',
          timing: { stepStartMs: 10_000, completedMs: 12_000 },
          content: [{ type: 'text', text: '二' }],
        },
      ],
      false
    );
    const texts = timeline.filter((item) => item.kind === 'text');
    expect(texts[0]).toMatchObject({ perf: { runMs: 1_000 } });
    expect(texts[1]).toMatchObject({ perf: { runMs: 2_000 } });
    for (const item of texts) {
      expect(item.kind === 'text' && item.perf?.turnMs).toBeUndefined();
    }
  });

  it('轮次仍在 running（末 step 未完成）时不带 turnMs', () => {
    const timeline = buildTimeline(
      [
        user('a'),
        {
          role: 'assistant',
          stopReason: 'toolUse',
          timing: { stepStartMs: 1_000, completedMs: 2_000 },
          content: [{ type: 'text', text: '一' }],
        },
        {
          role: 'assistant',
          stopReason: 'pending',
          timing: { stepStartMs: 5_000 },
          content: [{ type: 'text', text: '二' }],
        },
      ],
      true
    );
    const texts = timeline.filter((item) => item.kind === 'text');
    expect(texts[1].kind === 'text' && texts[1].perf).toBeUndefined();
  });

  it('空内容的 part 不产出条目', () => {
    const timeline = buildTimeline(
      [{ role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'unknown' }] }],
      false
    );
    expect(timeline).toHaveLength(0);
  });

  it('merges parent custom notifications by time without converting them into messages', () => {
    const messages: ProjectedMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'before' }],
        timestamp: 10,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'after' }],
        timestamp: 30,
      },
    ];
    const customEntries = [
      {
        kind: 'agent-dispatch' as const,
        child: {
          sessionId: 'parent::cw-child',
          generation: 'child-g1',
          instanceId: '123e4567-e89b-42d3-a456-426614174000',
          instanceName: 'Scout · a1',
          typeKey: 'builtin:scout' as const,
        },
        at: 20,
      },
    ];
    const timeline = buildTimeline(messages, false, customEntries);
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'session-custom', 'text']);
    expect(messages).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      kind: 'session-custom',
      entry: { kind: 'agent-dispatch' },
    });
  });

  it('keeps the complete child capability receipt in a custom timeline row', () => {
    const receiptEntry = {
      kind: 'capability-receipt' as const,
      receipt: {
        receiptId: '123e4567-e89b-42d3-a456-426614174040',
        operationId: '123e4567-e89b-42d3-a456-426614174041',
        child: {
          sessionId: 'parent::cw-enso',
          generation: 'enso-g1',
          parent: { sessionId: 'parent', generation: 'parent-g1' },
          instanceId: '123e4567-e89b-42d3-a456-426614174042',
          instanceName: 'Enso · a1',
          typeKey: 'agent:enso' as const,
          profileId: 'enso-locked-v1' as const,
        },
        turnId: 'turn-1',
        requestId: '123e4567-e89b-42d3-a456-426614174043',
        capabilityId: 'appearance.theme' as const,
        risk: 'reversible' as const,
        subject: { kind: 'setting' as const, id: 'theme', label: 'Theme' },
        outcome: 'succeeded' as const,
        summary: 'Theme changed to dark',
        changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
        occurredAt: 20,
        sequence: 1,
      },
    };
    const timeline = buildTimeline([], false, [receiptEntry]);
    expect(timeline).toMatchObject([
      {
        kind: 'session-custom',
        entry: {
          kind: 'capability-receipt',
          receipt: {
            outcome: 'succeeded',
            changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
          },
        },
      },
    ]);
  });
});

const toolItem = (key: string, name = 'bash', edits: TimelineItem[] = []): TimelineItem =>
  ({
    kind: 'tool',
    key,
    name,
    summary: name,
    output: null,
    state: 'ok',
    edits: edits.length > 0 ? [{ oldText: 'a', newText: 'b' }] : null,
  }) as TimelineItem;

const userItem = (key: string): TimelineItem => ({ kind: 'user', key, text: 'q', images: [] });
const textItem = (key: string): TimelineItem => ({
  kind: 'text',
  key,
  text: 'a',
  streaming: false,
});
const thinkingItem = (key: string): TimelineItem => ({
  kind: 'thinking',
  key,
  text: 't',
  streaming: false,
  durationMs: null,
});

describe('重试过的瞬态错误不渲染', () => {
  const err = (text = '503 status code (no body)'): ProjectedMessage => ({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: text,
  });
  const assistant = (text: string): ProjectedMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  });
  const user = (text: string): ProjectedMessage => ({
    role: 'user',
    content: [{ type: 'text', text }],
  });

  it('错误消息紧跟另一条 assistant（已重试）时不产生 error 项，末条保留', () => {
    // 回放场景：耗尽失败的一轮在 session 文件里留下每次尝试的错误消息
    const items = buildTimeline([user('q'), err(), err(), err(), err()], false);
    expect(items.filter((item) => item.kind === 'error')).toHaveLength(1);
  });

  it('重试成功后回放：错误项全部隐藏', () => {
    const items = buildTimeline([user('q'), err(), assistant('ok')], false);
    expect(items.filter((item) => item.kind === 'error')).toHaveLength(0);
  });

  it('终态错误后面是新一轮 user 消息：错误项保留', () => {
    const items = buildTimeline([user('q'), err(), user('again'), assistant('ok')], false);
    expect(items.filter((item) => item.kind === 'error')).toHaveLength(1);
  });

  it('running 中的末条错误（重试倒计时）从一开始就不渲染，终态（非 running）才渲染', () => {
    // 先渲染再删除会导致屏幕抽搐：running 期间错误文本只展示在 RetryBar 上
    const messages = [user('q'), err()];
    expect(buildTimeline(messages, true).filter((item) => item.kind === 'error')).toHaveLength(0);
    expect(buildTimeline(messages, false).filter((item) => item.kind === 'error')).toHaveLength(1);
  });
});

describe('terminalErrorText', () => {
  const errored: ProjectedMessage = {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: '503 status code (no body)',
  };

  it('消息已展示同一错误时不重复显示底部错误', () => {
    expect(terminalErrorText([errored], '503 status code (no body)')).toBeUndefined();
  });

  it('无同文本错误消息时原样返回（spawn 失败等没有消息载体的错误）', () => {
    expect(terminalErrorText([], 'invalid spawn request')).toBe('invalid spawn request');
    expect(terminalErrorText([errored], 'other error')).toBe('other error');
  });

  it('error 为空时返回 undefined', () => {
    expect(terminalErrorText([errored], undefined)).toBeUndefined();
  });
});

describe('foldTimeline', () => {
  it.each([false, true])('compact=%s：同一回复的连续思考合并，耗时只计一次', (compact) => {
    const messages: ProjectedMessage[] = [
      user('检查布局'),
      {
        role: 'assistant',
        stopReason: 'stop',
        timing: { stepStartMs: 1000, thinkingEndMs: 114000, completedMs: 115000 },
        content: [
          { type: 'thinking', text: '**Preparing focus measurement**' },
          { type: 'text', text: '  \n' },
          { type: 'thinking', text: '**Preparing editor geometry baseline**' },
          { type: 'thinking', text: '**Preparing delayed geometry check**' },
          { type: 'text', text: '完成' },
        ],
      },
    ];
    const items = buildTimeline(messages, false, [], undefined, { historyBaseIndex: 40 });
    const before = structuredClone(items);
    const folded = foldTimeline(items, false, new Set(), { compact });
    expect(folded).toMatchObject([
      { kind: 'user' },
      {
        kind: 'thinking',
        key: '41-0',
        text: '**Preparing focus measurement**\n\n**Preparing editor geometry baseline**\n\n**Preparing delayed geometry check**',
        streaming: false,
        durationMs: 113000,
        startedAt: 1000,
      },
      { kind: 'text', text: '完成' },
    ]);
    expect(items).toEqual(before);
    expect(folded[0]).toBe(items[0]);
    expect(folded[2]).toBe(items.at(-1));
  });

  it('连续的标签思考与原生思考合并，并保留已知计时', () => {
    const items = buildTimeline(
      [
        {
          role: 'assistant',
          timing: { stepStartMs: 1000, completedMs: 5000 },
          content: [
            { type: 'text', text: '<thinking>先检查</thinking><thinking>再测量</thinking>' },
            { type: 'thinking', text: '原生思考' },
            { type: 'text', text: '<thinking>最后核对</thinking>' },
          ],
        },
      ],
      false
    );
    expect(foldTimeline(items, false, new Set())).toEqual([
      {
        kind: 'thinking',
        key: '0-0-0',
        text: '先检查\n\n再测量\n\n原生思考\n\n最后核对',
        streaming: false,
        durationMs: 4000,
        startedAt: 1000,
      },
    ]);
  });

  it('流式新增思考片段和后续补丁沿用首段 key，结束后整块停止流式', () => {
    const snapshot = (texts: string[], settled = false): ProjectedMessage[] => [
      user('检查'),
      {
        role: 'assistant',
        stopReason: settled ? 'stop' : 'pending',
        content: [
          ...texts.map((text) => ({ type: 'thinking' as const, text })),
          { type: 'text', text: '' },
        ],
      },
    ];
    const first = foldTimeline(buildTimeline(snapshot(['第一段']), true), true, new Set());
    const raw = buildTimeline(snapshot(['第一段', '第二']), true);
    const nextMessages = snapshot(['第一段', '第二段']);
    const patched = patchStreamingTimeline(raw, nextMessages, true);
    expect(patched).not.toBeNull();
    const folded = foldTimeline(patched!, true, new Set());
    expect(foldTimeline(raw, true, new Set())).toMatchObject([
      { kind: 'user' },
      { kind: 'thinking', key: first[1].key, text: '第一段\n\n第二', streaming: true },
    ]);
    expect(folded).toMatchObject([
      { kind: 'user' },
      {
        kind: 'thinking',
        key: first[1].key,
        text: '第一段\n\n第二段',
        streaming: true,
        durationMs: null,
      },
    ]);
    expect(folded).toEqual(foldTimeline(buildTimeline(nextMessages, true), true, new Set()));
    expect(
      foldTimeline(buildTimeline(snapshot(['第一段', '第二段'], true), false), false, new Set())
    ).toMatchObject([
      { kind: 'user' },
      { kind: 'thinking', key: first[1].key, text: '第一段\n\n第二段', streaming: false },
    ]);
  });

  it('正文、工具和不同回复之间的思考不合并', () => {
    const items = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '一' },
            { type: 'text', text: '说明' },
            { type: 'thinking', text: '二' },
            { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'thinking', text: '三' },
          ],
        },
        { role: 'assistant', content: [{ type: 'thinking', text: '四' }] },
        user('继续'),
        { role: 'assistant', content: [{ type: 'thinking', text: '五' }] },
      ],
      false
    );
    expect(foldTimeline(items, false, new Set())).toEqual(items);
  });

  it('工具组展开后也只展示一个连续思考块，不改变工具顺序和计数', () => {
    const items = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'r1', name: 'read' },
            { type: 'thinking', text: '一' },
            { type: 'thinking', text: '二' },
            { type: 'toolCall', id: 'r2', name: 'read' },
            { type: 'toolCall', id: 'r3', name: 'read' },
          ],
        },
      ],
      false
    );
    const collapsed = foldTimeline(items, false, new Set());
    const expanded = foldTimeline(items, false, new Set([collapsed[0].key]));
    expect(collapsed).toMatchObject([
      {
        kind: 'tool-group',
        count: 3,
        children: [
          { kind: 'tool', key: '0-0' },
          { kind: 'thinking', key: '0-1', text: '一\n\n二' },
          { kind: 'tool', key: '0-3' },
          { kind: 'tool', key: '0-4' },
        ],
      },
    ]);
    expect(expanded.map((item) => item.key)).toEqual([
      collapsed[0].key,
      '0-0',
      '0-1',
      '0-3',
      '0-4',
    ]);
  });

  it('compact：只读 bash 进探索组，cat 记作 read、rg 记作 search', () => {
    const items = [
      { ...toolItem('a1', 'bash'), summary: 'cat README.md' },
      { ...toolItem('a2', 'bash'), summary: 'rg -n foo src' },
      toolItem('a3', 'read'),
      { ...toolItem('b', 'bash'), summary: 'pnpm test' },
    ] as TimelineItem[];
    const folded = foldTimeline(items, false, new Set(), { compact: true });
    expect(folded.map((i) => (i.kind === 'tool' ? i.summary : i.kind))).toEqual([
      'tool-group',
      'pnpm test',
    ]);
    const group = folded[0] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.stats).toEqual({ commands: 0, reads: 2, searches: 1, others: 0 });
  });

  it('连续 ≥3 条工具收拢为组头，thinking 收进组，统计归类', () => {
    const items = [
      userItem('u0'),
      toolItem('t1', 'bash'),
      thinkingItem('th'),
      toolItem('t2', 'read'),
      toolItem('t3', 'grep'),
      textItem('x'),
    ];
    const folded = foldTimeline(items, false, new Set());
    expect(folded.map((i) => i.kind)).toEqual(['user', 'tool-group', 'text']);
    const group = folded[1] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.count).toBe(3);
    expect(group.stats).toEqual({ commands: 1, reads: 1, searches: 1, others: 0 });
  });

  it('不足 3 条工具不折叠', () => {
    const items = [toolItem('t1'), toolItem('t2'), textItem('x')];
    expect(foldTimeline(items, false, new Set()).map((i) => i.kind)).toEqual([
      'tool',
      'tool',
      'text',
    ]);
  });

  it('edit(diff)行不进组，平铺在组头之后', () => {
    const items = [
      toolItem('t1'),
      toolItem('e1', 'edit', [{} as TimelineItem]),
      toolItem('t2'),
      toolItem('t3'),
    ];
    const folded = foldTimeline(items, false, new Set());
    expect(folded.map((i) => i.kind)).toEqual(['tool-group', 'tool']);
    expect((folded[1] as Extract<TimelineItem, { kind: 'tool' }>).edits).not.toBeNull();
  });

  it('running 时最后一轮的段不折叠，历史段照折', () => {
    const items = [
      userItem('u0'),
      toolItem('a1'),
      toolItem('a2'),
      toolItem('a3'),
      textItem('x'),
      userItem('u1'),
      toolItem('b1'),
      toolItem('b2'),
      toolItem('b3'),
    ];
    const folded = foldTimeline(items, true, new Set());
    expect(folded.map((i) => i.kind)).toEqual([
      'user',
      'tool-group',
      'text',
      'user',
      'tool',
      'tool',
      'tool',
    ]);
    // 同样的数据 idle 后全部收拢
    expect(foldTimeline(items, false, new Set()).map((i) => i.kind)).toEqual([
      'user',
      'tool-group',
      'text',
      'user',
      'tool-group',
    ]);
  });

  it('展开的组按原始顺序平铺 children', () => {
    const items = [toolItem('t1'), thinkingItem('th'), toolItem('t2'), toolItem('t3')];
    const collapsed = foldTimeline(items, false, new Set());
    const groupKey = collapsed[0].key;
    const expanded = foldTimeline(items, false, new Set([groupKey]));
    expect(expanded.map((i) => i.key)).toEqual([groupKey, 't1', 'th', 't2', 't3']);
  });

  it('compact：running 只读工具进组，不钉组外', () => {
    const runningTool = { ...toolItem('r', 'read'), state: 'running' } as TimelineItem;
    const items = [
      userItem('u0'),
      toolItem('a1', 'read'),
      toolItem('a2', 'grep'),
      toolItem('a3', 'ls'),
      runningTool,
    ];
    const folded = foldTimeline(items, true, new Set(), { compact: true });
    expect(folded.map((i) => i.kind)).toEqual(['user', 'tool-group']);
    const group = folded[1] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.count).toBe(4);
    expect(group.exploring).toBe(true);
    expect(group.stats).toEqual({ commands: 0, reads: 2, searches: 2, others: 0 });
    const expanded = foldTimeline(items, true, new Set([group.key]), { compact: true });
    expect(expanded.map((i) => i.key)).toEqual(['u0', group.key, 'a1', 'a2', 'a3', 'r']);
  });

  it('compact：图片 read 像文件改动一样留在组外，普通 read 仍进组', () => {
    const image = {
      ...toolItem('img', 'read'),
      state: 'running',
      imagePath: '/tmp/a.png',
    } as TimelineItem;
    const items = [
      userItem('u0'),
      toolItem('a1', 'read'),
      toolItem('a2', 'grep'),
      toolItem('a3', 'ls'),
      image,
    ];
    const folded = foldTimeline(items, true, new Set(), { compact: true });
    expect(folded.map((item) => item.kind)).toEqual(['user', 'tool-group', 'tool']);
    expect(folded[2]).toMatchObject({ key: 'img', kind: 'tool' });
    const done = foldTimeline(
      [
        userItem('u0'),
        toolItem('a1', 'read'),
        toolItem('a2', 'grep'),
        toolItem('a3', 'read'),
        { ...toolItem('img', 'read'), imagePath: '/tmp/a.png' } as TimelineItem,
      ],
      false,
      new Set(),
      { compact: true }
    );
    expect(done.map((item) => (item.kind === 'tool' ? item.key : item.kind))).toEqual([
      'user',
      'tool-group',
      'img',
    ]);
  });

  it('失败的图片 read 不钉在组外', () => {
    const failed = {
      ...toolItem('img', 'read'),
      state: 'error',
      imagePath: '/tmp/a.png',
    } as TimelineItem;
    const folded = foldTimeline(
      [
        userItem('u0'),
        toolItem('a1', 'read'),
        toolItem('a2', 'grep'),
        toolItem('a3', 'ls'),
        failed,
      ],
      false,
      new Set(),
      { compact: true }
    );
    expect(folded.map((item) => item.kind)).toEqual(['user', 'tool-group']);
    const group = folded[1] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.children.map((item) => item.key)).toContain('img');
  });

  it('compact 关时 running 最后一轮仍平铺', () => {
    const items = [userItem('u0'), toolItem('a1'), toolItem('a2'), toolItem('a3')];
    expect(foldTimeline(items, true, new Set(), { compact: false }).map((i) => i.kind)).toEqual([
      'user',
      'tool',
      'tool',
      'tool',
    ]);
  });

  it('compact：只读工具才进组，bash 打断段并平铺在外', () => {
    const items = [
      toolItem('a1', 'read'),
      toolItem('a2', 'read'),
      toolItem('a3', 'grep'),
      toolItem('b', 'bash'),
      toolItem('a4', 'read'),
    ];
    const folded = foldTimeline(items, false, new Set(), { compact: true });
    expect(folded.map((i) => (i.kind === 'tool' ? i.name : i.kind))).toEqual([
      'tool-group',
      'bash',
      'read',
    ]);
    const group = folded[0] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.count).toBe(3);
    expect(group.stats).toEqual({ commands: 0, reads: 2, searches: 1, others: 0 });
    expect(group.exploring).toBe(false);
    // 关：沿用旧逻辑，bash 一起收
    const legacy = foldTimeline(items, false, new Set(), { compact: false });
    expect(legacy.map((i) => i.kind)).toEqual(['tool-group']);
    expect((legacy[0] as Extract<TimelineItem, { kind: 'tool-group' }>).count).toBe(5);
  });

  it('compact：组内有 running 只读工具时组头标 exploring', () => {
    const running = { ...toolItem('r', 'read'), state: 'running' } as TimelineItem;
    const items = [toolItem('a1', 'read'), toolItem('a2', 'ls'), toolItem('a3', 'grep'), running];
    const folded = foldTimeline(items, true, new Set(), { compact: true });
    expect(folded.map((i) => i.kind)).toEqual(['tool-group']);
    expect((folded[0] as Extract<TimelineItem, { kind: 'tool-group' }>).exploring).toBe(true);
  });

  it('compact：运行中的尾段在两次调用之间仍标 exploring，被后续内容隔开或结束后才落定', () => {
    const items = [
      userItem('u0'),
      toolItem('a1', 'read'),
      toolItem('a2', 'grep'),
      toolItem('a3', 'ls'),
    ];
    const exploring = (list: TimelineItem[], running: boolean) =>
      (
        foldTimeline(list, running, new Set(), { compact: true }).find(
          (i) => i.kind === 'tool-group'
        ) as Extract<TimelineItem, { kind: 'tool-group' }>
      ).exploring;
    expect(exploring(items, true)).toBe(true);
    expect(exploring([...items, thinkingItem('th')], true)).toBe(true);
    expect(exploring([...items, toolItem('b', 'bash')], true)).toBe(false);
    expect(exploring(items, false)).toBe(false);
  });

  it('todo 行不进组，平铺在组头之后', () => {
    const items = [toolItem('t1'), toolItem('td', 'todo'), toolItem('t2'), toolItem('t3')];
    const folded = foldTimeline(items, false, new Set());
    expect(folded.map((i) => i.kind)).toEqual(['tool-group', 'tool']);
    expect((folded[1] as Extract<TimelineItem, { kind: 'tool' }>).name).toBe('todo');
  });
});

describe('streaming 判定(最后一个有内容的 part)', () => {
  it('thinking 是唯一有内容的 part 且 running 时,thinking 处于流式中', () => {
    const timeline = buildTimeline(
      [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '思考内容...' },
            { type: 'text', text: '' },
          ],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([{ kind: 'user' }, { kind: 'thinking', streaming: true }]);
  });

  it('thinking 后有非空 text 时,text 流式、thinking 已完结', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 't' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([
      { kind: 'thinking', streaming: false },
      { kind: 'text', streaming: true },
    ]);
  });
});

describe('工具路径摘要相对化', () => {
  const cwd = '/Users/j3n5en/project/enso-code';
  const tool = (args: Record<string, unknown>, root?: string) =>
    buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: args }],
        },
      ],
      false,
      [],
      root
    )[0];

  it('项目内绝对路径显示相对路径', () => {
    expect(tool({ path: `${cwd}/src/renderer/components/chat/Markdown.tsx` }, cwd)).toMatchObject({
      summary: 'src/renderer/components/chat/Markdown.tsx',
    });
  });

  it('file_path 同样相对化', () => {
    expect(tool({ file_path: `${cwd}/a.ts` }, cwd)).toMatchObject({ summary: 'a.ts' });
  });

  it('explore_mark 的 goal 作摘要', () => {
    expect(tool({ goal: 'find auth' })).toMatchObject({ summary: 'find auth' });
  });

  it('项目外路径保持绝对', () => {
    expect(tool({ path: '/tmp/foo.ts' }, cwd)).toMatchObject({ summary: '/tmp/foo.ts' });
  });

  it('未传 cwd 保持原样', () => {
    expect(tool({ path: `${cwd}/a.ts` })).toMatchObject({ summary: `${cwd}/a.ts` });
  });

  it('前缀碰巧相同的目录不误切', () => {
    expect(tool({ path: `${cwd}-bak/a.ts` }, cwd)).toMatchObject({
      summary: `${cwd}-bak/a.ts`,
    });
  });

  it('cwd 本身显示为 .', () => {
    expect(tool({ path: cwd }, cwd)).toMatchObject({ summary: '.' });
  });

  it('Windows 盘符路径相对 POSIX 项目 cwd', () => {
    expect(tool({ path: 'D:/root/semble/README.md' }, '/root/semble')).toMatchObject({
      summary: 'README.md',
    });
    expect(tool({ path: 'D:\\root\\semble' }, '/root/semble')).toMatchObject({ summary: '.' });
  });

  it('command 不受影响', () => {
    expect(
      buildTimeline(
        [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm test' } },
            ],
          },
        ],
        false,
        [],
        cwd
      )[0]
    ).toMatchObject({ summary: 'pnpm test' });
  });
});

describe('mcp 代理调用行', () => {
  const proxy = (args: Record<string, unknown>) =>
    buildTimeline(
      [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'mcp', arguments: args }],
        },
      ],
      false,
      []
    )[0];

  it('call 行按真实工具名与内层参数展示', () => {
    expect(
      proxy({ action: 'call', tool: 'mcp__github__search_issues', arguments: { query: 'bug' } })
    ).toMatchObject({ name: 'mcp__github__search_issues', summary: 'bug' });
  });

  it('list / describe 保留代理名并摘要目标', () => {
    expect(proxy({ action: 'list' })).toMatchObject({ name: 'mcp', summary: 'list' });
    expect(proxy({ action: 'describe', tool: 'mcp__github__search_issues' })).toMatchObject({
      name: 'mcp',
      summary: 'mcp__github__search_issues',
    });
  });
});

describe('compaction 摘要行', () => {
  it('compactionSummary 消息渲染为 compaction 行，带摘要与压缩前 token 数', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        {
          role: 'compactionSummary',
          content: [{ type: 'text', text: 'SUMMARY' }],
          tokensBefore: 9000,
        },
        user('new'),
      ],
      false
    );
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'compaction', 'user']);
    expect(timeline[1]).toMatchObject({
      kind: 'compaction',
      summary: 'SUMMARY',
      tokensBefore: 9000,
    });
    expect(timeline[1]).not.toHaveProperty('verified');
  });

  it('verified 摘要行带 verified', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'compactionSummary',
          content: [{ type: 'text', text: 'S' }],
          tokensBefore: 1,
          verified: true,
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({ kind: 'compaction', verified: true });
  });

  it('memory 摘要行带 memory，且 compaction-notice 也带', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'compactionSummary',
          content: [{ type: 'text', text: 'S' }],
          tokensBefore: 1,
          verified: true,
          memory: true,
        },
        user('kept'),
        user('after'),
      ],
      false,
      [],
      undefined,
      { compactionNoticeAt: 2 }
    );
    expect(timeline[0]).toMatchObject({ kind: 'compaction', memory: true });
    expect(timeline.find((item) => item.kind === 'compaction-notice')).toMatchObject({
      memory: true,
    });
  });

  it('compaction 行不打断 tool-group 折叠之外的顺序，且不被 foldTimeline 吞掉', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      ],
      false
    );
    const folded = foldTimeline(timeline, false, new Set());
    expect(folded.map((item) => item.kind)).toEqual(['user', 'compaction', 'text']);
  });

  it('压缩进行中时在时间线末尾挂 loading 行，不重复钉摘要提示', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
        user('new'),
      ],
      false,
      [],
      undefined,
      { compaction: 'running' }
    );
    expect(timeline.map((item) => item.kind)).toEqual([
      'user',
      'compaction',
      'user',
      'compaction-progress',
    ]);
    expect(timeline.at(-1)).toMatchObject({ kind: 'compaction-progress', state: 'running' });
  });

  it('忙碌中排队压缩时末尾挂 queued 行', () => {
    const timeline = buildTimeline([user('q')], true, [], undefined, { compaction: 'queued' });
    expect(timeline.at(-1)).toMatchObject({ kind: 'compaction-progress', state: 'queued' });
  });

  it('没有锚点时不钉压完提示（老行为会永远贴底，新消息被顶到提示上方）', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
        user('new'),
      ],
      false
    );
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'compaction', 'user']);
  });

  it('压完提示钉在压缩发生那一刻：锚点之前的消息在上，之后的新消息在下', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        {
          role: 'compactionSummary',
          content: [{ type: 'text', text: 'SUMMARY' }],
          tokensBefore: 9000,
        },
        user('kept'),
        user('new-after-compact'),
      ],
      false,
      [],
      undefined,
      { compactionNoticeAt: 3 }
    );
    expect(timeline.map((item) => item.kind)).toEqual([
      'user',
      'compaction',
      'user',
      'compaction-notice',
      'user',
    ]);
    expect(timeline[3]).toMatchObject({
      kind: 'compaction-notice',
      summary: 'SUMMARY',
      tokensBefore: 9000,
    });
    expect(timeline.at(-1)).toMatchObject({ kind: 'user', text: 'new-after-compact' });
  });

  it('锚点在末尾（压完还没发新消息）时提示落在最后', () => {
    const timeline = buildTimeline(
      [
        user('old'),
        { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
        user('kept'),
      ],
      false,
      [],
      undefined,
      { compactionNoticeAt: 3 }
    );
    expect(timeline.at(-1)).toMatchObject({ kind: 'compaction-notice', summary: 'S' });
  });

  it('摘要就在锚点位置（整段都被压掉）时不重复钉提示', () => {
    const timeline = buildTimeline(
      [user('old'), { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] }],
      false,
      [],
      undefined,
      { compactionNoticeAt: 2 }
    );
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'compaction']);
  });

  it('锚点陈旧（消息比锚点少）时不钉提示', () => {
    const timeline = buildTimeline([user('old')], false, [], undefined, { compactionNoticeAt: 5 });
    expect(timeline.map((item) => item.kind)).toEqual(['user']);
  });

  it('锚点不在最新摘要之后（冷缓存清空时记成 0）时不钉提示，不能顶成尾窗首行', () => {
    const tail: ProjectedMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'before' }] },
      { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
      user('kept'),
    ];
    for (const compactionNoticeAt of [0, 3, 691]) {
      const timeline = buildTimeline(tail, false, [], undefined, {
        compactionNoticeAt,
        historyBaseIndex: 690,
      });
      expect(timeline.map((item) => item.kind)).toEqual(['text', 'compaction', 'user']);
    }
  });

  it('尾窗分页时锚点按绝对下标落在摘要之后', () => {
    const timeline = buildTimeline(
      [
        { role: 'compactionSummary', content: [{ type: 'text', text: 'S' }] },
        user('kept'),
        user('new-after-compact'),
      ],
      false,
      [],
      undefined,
      { compactionNoticeAt: 692, historyBaseIndex: 690 }
    );
    expect(timeline.map((item) => item.kind)).toEqual([
      'compaction',
      'user',
      'compaction-notice',
      'user',
    ]);
  });
});

describe('buildTimeline 运行中工具的增量输出', () => {
  const runningBash: ProjectedMessage[] = [
    user('跑测试'),
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm test' } }],
    },
  ];

  it('running 工具用 toolOutputs 的增量快照填充 output', () => {
    const timeline = buildTimeline(runningBash, true, [], undefined, {
      toolOutputs: { t1: 'PASS a\nPASS b' },
    });
    expect(timeline[1]).toMatchObject({ kind: 'tool', state: 'running', output: 'PASS a\nPASS b' });
  });

  it('未开始执行的同轮工具不跳表：无 startedAt，仍标 running', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'sleep 5' } },
            { type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'a.ts' } },
          ],
        },
      ],
      true,
      [],
      undefined,
      { toolStartedAt: { 'bash-1': 1_000 } }
    );
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'bash',
      state: 'running',
      startedAt: 1_000,
    });
    expect(timeline[2]).toMatchObject({
      kind: 'tool',
      name: 'write',
      state: 'running',
      startedAt: null,
    });
  });

  it('无增量时 running 工具 output 仍为 null（行不可展开）', () => {
    const timeline = buildTimeline(runningBash, true);
    expect(timeline[1]).toMatchObject({ kind: 'tool', state: 'running', output: null });
  });

  it('真实 toolResult 覆盖残留的增量快照', () => {
    const timeline = buildTimeline(
      [
        ...runningBash,
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'bash',
          isError: false,
          content: [{ type: 'text', text: 'final output' }],
        },
      ],
      true,
      [],
      undefined,
      { toolOutputs: { t1: 'PASS a' } }
    );
    expect(timeline[1]).toMatchObject({ kind: 'tool', state: 'ok', output: 'final output' });
  });
});

describe('patchStreamingTimeline', () => {
  const pending = (text: string): ProjectedMessage => ({
    role: 'assistant',
    stopReason: 'pending',
    content: [{ type: 'thinking', text }],
  });

  it('思考变长时复用前缀行对象，只换末条 thinking', () => {
    const prefix = user('问');
    const first = [prefix, pending('abc')];
    const previous = buildTimeline(first, true);
    const next = patchStreamingTimeline(previous, [prefix, pending('abcdef')], true);
    expect(next).not.toBeNull();
    expect(next).toHaveLength(previous.length);
    expect(next![0]).toBe(previous[0]);
    expect(next![1]).not.toBe(previous[1]);
    expect(next![1]).toMatchObject({ kind: 'thinking', text: 'abcdef', streaming: true });
  });

  it('思考文本没变时返回原数组', () => {
    const messages = [user('问'), pending('abc')];
    const previous = buildTimeline(messages, true);
    expect(patchStreamingTimeline(previous, messages, true)).toBe(previous);
  });

  it('非 running、工具结果、新 part 出现时不走补丁', () => {
    const prefix = user('问');
    const thinking = pending('abc');
    const previous = buildTimeline([prefix, thinking], true);
    expect(patchStreamingTimeline(previous, [prefix, thinking], false)).toBeNull();
    expect(
      patchStreamingTimeline(
        previous,
        [
          prefix,
          thinking,
          {
            role: 'toolResult',
            toolCallId: 't1',
            content: [{ type: 'text', text: 'ok' }],
          },
        ],
        true
      )
    ).toBeNull();
    expect(
      patchStreamingTimeline(
        previous,
        [
          prefix,
          {
            role: 'assistant',
            stopReason: 'pending',
            content: [
              { type: 'thinking', text: 'abc' },
              { type: 'text', text: '答案' },
            ],
          },
        ],
        true
      )
    ).toBeNull();
  });
});

describe('apply_patch timeline', () => {
  const call: ProjectedMessage = {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'patch-1', name: 'apply_patch', arguments: { patch: '***' } },
    ],
  };

  it('partial error 仍携带所有实际落盘文件，不把参数意图当 diff', () => {
    const changes = [
      { path: 'src/a.ts', oldText: 'a', newText: 'aa', type: 'update' as const },
      { path: 'old.ts', oldText: 'old', newText: '', type: 'delete' as const },
      { path: 'new.ts', oldText: '', newText: 'new', type: 'add' as const },
    ];
    const timeline = buildTimeline(
      [
        call,
        {
          role: 'toolResult',
          toolCallId: 'patch-1',
          toolName: 'apply_patch',
          isError: true,
          content: [{ type: 'text', text: 'partially applied' }],
          fileChanges: changes,
          applyPatchOutcome: {
            status: 'partial',
            applied: changes.map((change) => change.path),
            failed: ['failed.ts'],
            error: 'source delete failed',
            input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch',
            unattempted: ['later.ts'],
            uncertain: ['unknown.ts'],
          },
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({
      kind: 'tool',
      name: 'apply_patch',
      state: 'error',
      fileChanges: changes,
      edits: null,
    });
    expect(shouldShowToolOutputAfterFileChanges(timeline[0])).toBe(true);
    expect(timeline[0]).toMatchObject({
      output: expect.stringContaining('Failed paths:\n- failed.ts'),
    });
    expect(timeline[0]).toMatchObject({
      output: expect.stringContaining('Uncertain:\n- unknown.ts'),
    });
    expect(timeline[0]).toMatchObject({
      output: expect.stringContaining('Input:\n*** Begin Patch'),
    });
  });

  it('apply_patch 结果从无到有时才自动展开，历史挂载时不展开', () => {
    const timeline = buildTimeline(
      [
        call,
        {
          role: 'toolResult',
          toolCallId: 'patch-1',
          toolName: 'apply_patch',
          content: [],
          fileChanges: [{ path: 'a.ts', oldText: 'a', newText: 'b', type: 'update' }],
        },
      ],
      true
    );
    expect(timeline[0]).toMatchObject({ name: 'apply_patch', state: 'ok' });
    expect(shouldAutoExpandAppliedFileChanges(timeline[0], false)).toBe(true);
    expect(shouldAutoExpandAppliedFileChanges(timeline[0], true)).toBe(false);
  });

  it('全量预检失败没有 fileChanges，不从 patch 参数造 diff', () => {
    const timeline = buildTimeline(
      [
        call,
        {
          role: 'toolResult',
          toolCallId: 'patch-1',
          toolName: 'apply_patch',
          isError: true,
          content: [{ type: 'text', text: 'preflight failed' }],
          fileChanges: [],
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({ fileChanges: [], edits: null, writeContent: null });
  });

  it('没有落盘结果时摘要取补丁头里的目标文件，不显示参数 JSON', () => {
    const patchCall = (input: string): ProjectedMessage => ({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'patch-2', name: 'apply_patch', arguments: { input } }],
    });
    const summaryOf = (...messages: ProjectedMessage[]) => {
      const [item] = buildTimeline(messages, true, [], '/repo');
      return item?.kind === 'tool' ? item.summary : null;
    };
    expect(summaryOf(patchCall('*** Begin Patch\n*** Add File: /repo/tests/a.test.js\n+imp'))).toBe(
      'tests/a.test.js'
    );
    expect(
      summaryOf(
        patchCall(
          '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** Delete File: c.ts\n*** End Patch'
        )
      )
    ).toBe('3 files');
    expect(summaryOf(patchCall('*** Begin Patch\n*** Add Fi'))).toBe('');
    expect(
      summaryOf(patchCall('*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch'), {
        role: 'toolResult',
        toolCallId: 'patch-2',
        toolName: 'apply_patch',
        isError: true,
        content: [{ type: 'text', text: 'preflight failed' }],
        fileChanges: [],
      })
    ).toBe('a.ts');
  });

  it('有实际修改的 partial result 会改变 Changes 指纹', () => {
    const withResult: ProjectedMessage[] = [
      call,
      {
        role: 'toolResult',
        toolCallId: 'patch-1',
        toolName: 'apply_patch',
        isError: true,
        content: [],
        fileChanges: [{ path: 'a.ts', oldText: 'a', newText: 'b', type: 'update' }],
      },
    ];
    expect(completedEditWriteFingerprint(withResult)).not.toBe(
      completedEditWriteFingerprint([call])
    );
  });
});

describe('completedEditWriteFingerprint', () => {
  it('思考变长不改变指纹，完成的 edit 才会变', () => {
    const readCall: ProjectedMessage = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a.ts' } }],
    };
    const thinking: ProjectedMessage = {
      role: 'assistant',
      stopReason: 'pending',
      content: [{ type: 'thinking', text: 'a' }],
    };
    const before = [user('改'), readCall, thinking];
    const afterThink: ProjectedMessage[] = [
      user('改'),
      readCall,
      { ...thinking, content: [{ type: 'thinking', text: 'ab' }] },
    ];
    expect(completedEditWriteFingerprint(afterThink)).toBe(completedEditWriteFingerprint(before));

    const editCall: ProjectedMessage = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'e1',
          name: 'edit',
          arguments: { path: 'a.ts', oldText: 'x', newText: 'y' },
        },
      ],
    };
    const editResult: ProjectedMessage = {
      role: 'toolResult',
      toolCallId: 'e1',
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    };
    expect(completedEditWriteFingerprint([...before, editCall, editResult])).not.toBe(
      completedEditWriteFingerprint(before)
    );
  });
});

type UserItem = Extract<TimelineItem, { kind: 'user' }>;
const users = (items: TimelineItem[]): UserItem[] =>
  items.filter((item): item is UserItem => item.kind === 'user');
const userByText = (items: TimelineItem[], text: string): UserItem => {
  const found = users(items).find((item) => item.text === text);
  if (!found) throw new Error(`user item not found: ${text}`);
  return found;
};

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
  const on = { collapseCompletedActivity: true };
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
    const folded = foldTimeline(items, false, new Set(), on);
    expect(kinds(folded)).toEqual(['user', 'tool-group', 'text']);
    const group = folded[1] as Group;
    expect(group.activity).toEqual({ thinking: 1, workedMs: 3000 });
    expect(group.count).toBe(4);
    expect(kinds(group.children)).toEqual(['thinking', 'bash', 'edit', 'write', 'todo']);
  });

  it('展开后按原顺序平铺全部行', () => {
    const items = [userItem('u'), toolItem('a', 'edit', [textItem('x')]), toolItem('b', 'read')];
    const collapsed = foldTimeline(items, false, new Set(), on);
    const key = collapsed[1].key;
    const expanded = foldTimeline(items, false, new Set([key]), on);
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
    expect(kinds(foldTimeline(items, false, new Set(), on))).toEqual([
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
    const folded = foldTimeline(items, false, new Set(), on);
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
    const folded = foldTimeline(items, true, new Set(), on);
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
    expect(kinds(foldTimeline(items, true, new Set(), on))).toEqual([
      'user',
      'tool-group',
      'text',
      'edit',
      'bash',
    ]);
    expect(kinds(foldTimeline([...items.slice(0, 5)], true, new Set(), on))).toEqual([
      'user',
      'tool-group',
      'text',
    ]);
  });

  it('没有耗时打点时 workedMs 为 0；开关关闭时行为不变', () => {
    const items = [userItem('u'), toolItem('a', 'edit', [textItem('x')]), toolItem('b', 'bash')];
    const group = foldTimeline(items, false, new Set(), on)[1] as Group;
    expect(group.activity).toEqual({ thinking: 0, workedMs: 0 });
    expect(kinds(foldTimeline(items, false, new Set()))).toEqual(['user', 'edit', 'bash']);
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
    const on = { collapseCompletedActivity: true };
    const items = [
      userItem('u'),
      toolItem('a', 'bash'),
      mark('m'),
      toolItem('r', 'read'),
      fold('f'),
      textItem('answer'),
    ];
    const folded = foldTimeline(items, false, new Set(), on);
    expect(folded.map((item) => item.kind)).toEqual(['user', 'tool-group', 'text']);
    const activity = folded[1] as Group;
    expect(activity.activity).toBeDefined();
    expect(activity.count).toBe(4);
    const exploreKey = activity.children[1].key;
    expect(keys(foldTimeline(items, false, new Set([activity.key]), on))).toEqual([
      'u',
      activity.key,
      'a',
      exploreKey,
      'answer',
    ]);
    expect(keys(foldTimeline(items, false, new Set([activity.key, exploreKey]), on))).toEqual([
      'u',
      activity.key,
      'a',
      exploreKey,
      'answer',
    ]);
    expect(
      keys(
        foldTimeline(
          items,
          false,
          new Set([activity.key, exploreKey, exploreStepsKey(exploreKey)]),
          on
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
    const folded = foldTimeline(items, false, new Set(), { collapseCompletedActivity: true });
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

import type { BotChat, BotProfile, GroupEntry } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import {
  botSessionAccess,
  fitGroupTimelineFrame,
  pairActivityItems,
  summarizeBotChat,
  toPairBotMember,
} from './pairBotFrames';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';

const bot = (id: string, name: string, extra: Partial<BotProfile> = {}): BotProfile => ({
  id,
  name,
  title: `${name} title`,
  scope: 'secret scope',
  avatar: { color: '#7c5cff' },
  approvalMode: 'full',
  tools: 'all',
  skillIds: [],
  mcpServerIds: [],
  delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
  memory: { enabled: true },
  createdAt: 1,
  updatedAt: 1,
  version: 1,
  ...extra,
});

const chat = (extra: Partial<BotChat> = {}): BotChat => ({
  id: CHAT,
  kind: 'group',
  title: '发布群',
  members: [A, B],
  bossBotId: A,
  workspace: { kind: 'chat-home', projectId: 'p' },
  routing: { mode: 'boss', maxHops: 4, maxTurnsPerBot: 2 },
  pinned: false,
  sessions: { [A]: { conversationId: 'conv-a', cursor: 3 } },
  createdAt: 1,
  updatedAt: 5,
  version: 1,
  ...extra,
});

const human = (seq: number, text = 'hi'): GroupEntry => ({
  seq,
  id: `e${seq}`,
  at: seq,
  kind: 'human',
  text,
  mentions: [],
});

describe('Bot 目录投影', () => {
  it('成员只下发展示字段，不含人设/scope/模型配置', () => {
    const member = toPairBotMember(bot(A, '阿后', { archivedAt: 9 }), 'running');
    expect(member).toEqual({
      id: A,
      name: '阿后',
      title: '阿后 title',
      avatarColor: '#7c5cff',
      archived: true,
      status: 'running',
    });
  });

  it('聊天摘要：会话映射只留 conversationId，末条文本截断', () => {
    const summary = summarizeBotChat(chat({ pinned: true }), human(7, 'x'.repeat(500)), 7, 'idle');
    expect(summary.sessions).toEqual({ [A]: { conversationId: 'conv-a' } });
    expect(summary.pinned).toBe(true);
    expect(summary.lastSeq).toBe(7);
    expect(summary.last?.kind).toBe('human');
    expect(summary.last?.text.length).toBeLessThanOrEqual(120);
    expect(summary).not.toHaveProperty('workspace');
    expect(summary).not.toHaveProperty('routing');
  });

  it('委派条目摘要带发起成员，系统条目原样', () => {
    const entry: GroupEntry = {
      seq: 2,
      id: 'd',
      at: 2,
      kind: 'delegation',
      delegationId: 'del',
      from: A,
      to: B,
      state: 'running',
      summary: '查日志',
    };
    expect(summarizeBotChat(chat(), entry, 2, 'running').last).toEqual({
      kind: 'delegation',
      text: '查日志',
      botId: A,
      at: 2,
    });
    expect(summarizeBotChat(chat(), undefined, 0, 'idle').last).toBeUndefined();
  });
});

describe('群时间线帧裁剪', () => {
  it('未超限原样返回', () => {
    const entries = [human(1), human(2)];
    const frame = fitGroupTimelineFrame(
      { type: 'group-timeline', chatId: CHAT, entries, lastSeq: 2, hasOlder: false },
      10_000
    );
    expect(frame.entries).toEqual(entries);
    expect(frame.hasOlder).toBe(false);
  });

  it('超限时从最旧的一端减少条数并标记 hasOlder，结果严格小于上限', () => {
    const entries = Array.from({ length: 50 }, (_, i) => human(i + 1, 'y'.repeat(400)));
    const max = 6_000;
    const frame = fitGroupTimelineFrame(
      { type: 'group-timeline', chatId: CHAT, entries, lastSeq: 50, hasOlder: false },
      max
    );
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(max);
    expect(frame.entries.length).toBeGreaterThan(0);
    expect(frame.entries.at(-1)?.seq).toBe(50);
    expect(frame.entries[0].seq).toBeGreaterThan(1);
    expect(frame.hasOlder).toBe(true);
  });

  it('单条就超限时截断该条文本而不是发空页', () => {
    const frame = fitGroupTimelineFrame(
      {
        type: 'group-timeline',
        chatId: CHAT,
        entries: [human(1, 'z'.repeat(20_000))],
        lastSeq: 1,
        hasOlder: false,
      },
      5_000
    );
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(5_000);
    expect(frame.entries).toHaveLength(1);
    expect(frame.entries[0].seq).toBe(1);
  });
});

describe('Bot 会话订阅放行', () => {
  const botConversation = { bot: { botId: A, chatId: CHAT } };
  it('非 Bot 会话走原链路', () => {
    expect(botSessionAccess(undefined, true, false)).toBe('none');
    expect(botSessionAccess({}, true, true)).toBe('none');
  });
  it('Bot 模式关闭时拒绝 Bot 会话', () => {
    expect(botSessionAccess(botConversation, false, true)).toBe('deny');
  });
  it('开启时：worker 有投影走快照，否则读会话文件', () => {
    expect(botSessionAccess(botConversation, true, true)).toBe('live');
    expect(botSessionAccess(botConversation, true, false)).toBe('cold');
  });
});

describe('pairActivityItems', () => {
  const binding = (id: string) =>
    id === 'run'
      ? { botId: 'b1', chatId: 'g1' }
      : id === 'child'
        ? { botId: 'b2', chatId: 'g1', ownerBotId: 'b1' }
        : id === 'wait'
          ? { botId: 'b3', chatId: null }
          : undefined;

  it('运行中的步骤去掉 id；排队但未在跑的会话补 queued 与原因；未知会话丢弃', () => {
    const items = pairActivityItems(
      [
        {
          conversationId: 'run',
          activity: {
            state: 'tool',
            startedAt: 10,
            steps: [{ id: 'c1', name: 'bash', detail: 'ls', status: 'running', startedAt: 12 }],
            more: 2,
          },
        },
        { conversationId: 'code', activity: { state: 'thinking', steps: [], more: 0 } },
      ],
      [
        { chatId: 'g1', botId: 'b1', conversationId: 'run', position: 0, reason: 'turn' },
        { chatId: 'g1', botId: 'b2', conversationId: 'child', position: 1, reason: 'capacity' },
        { chatId: '', botId: 'b3', conversationId: 'wait', position: 2 },
      ],
      binding
    );
    expect(items).toEqual([
      {
        conversationId: 'run',
        botId: 'b1',
        chatId: 'g1',
        state: 'tool',
        startedAt: 10,
        steps: [{ name: 'bash', detail: 'ls', status: 'running', startedAt: 12 }],
        more: 2,
      },
      {
        conversationId: 'child',
        botId: 'b2',
        chatId: 'g1',
        ownerBotId: 'b1',
        state: 'queued',
        reason: 'capacity',
        steps: [],
        more: 0,
      },
      { conversationId: 'wait', botId: 'b3', chatId: null, state: 'queued', steps: [], more: 0 },
    ]);
  });
});

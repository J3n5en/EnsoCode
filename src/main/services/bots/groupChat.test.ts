import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISCUSS_NOTE,
  DISCUSS_OWNER_NOTE,
  type DiscussNextDecision,
  type DiscussNextInput,
} from '../../../shared/bots/discussRoute';
import {
  SMART_ROUTE_BUILD_NOTE,
  type SmartRouteDecision,
  type SmartRouteInput,
} from '../../../shared/bots/smartRoute';
import type { BotTurnFinished } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { GroupChatService } from './groupChat';
import { createSmartRouter, type SmartRouterDeps } from './smartRouter';

let root: string;
let bots: BotStore;
let chats: BotChatStore;
let group: GroupChatService;
let a: string;
let b: string;
let id: string;
let finish: (event: BotTurnFinished) => void;
let deliverySent: (event: { conversationId: string; deliveryId: string; steered?: true }) => void;
const deliver = vi.fn();
const stopTurn = vi.fn(async () => {});
const retryConversation = vi.fn(async (id: string) => ({ ok: true as const, conversationId: id }));
const emit = vi.fn();
const host = {
  onDeliverySent: (listener: typeof deliverySent) => {
    deliverySent = listener;
    return () => {};
  },
  deliver,
  retryConversation,
  stopTurn,
  onTurnFinished: (listener: typeof finish) => {
    finish = listener;
    return () => {};
  },
};
const entries = () => chats.readEntries(id);
const done = async (botId: string, text: string, ok = true, deliveryId?: string) => {
  finish({
    deliveryId,
    chatId: id,
    botId,
    conversationId: botId,
    turnId: String(entries().length),
    text,
    ok,
    error: ok ? undefined : 'broken',
  });
  await group.settled(id);
};

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'group-chat-'));
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'chats'));
  const alice = bots.create({ name: 'Alice' }, []);
  const bob = bots.create({ name: 'Bob' }, []);
  if (!alice.ok || !bob.ok) throw new Error('fixture');
  a = alice.bot.id;
  b = bob.bot.id;
  id = chats.create({
    kind: 'group',
    title: 'Team',
    members: [a, b],
    bossBotId: a,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!.id;
  deliver.mockImplementation(async (_chatId: string, botId: string) => {
    if (!chats.get(id)!.sessions[botId])
      chats.update(id, (draft) => {
        draft.sessions[botId] = { conversationId: botId, cursor: chats.lastSeq(id) };
        return draft;
      });
    return { ok: true, conversationId: botId };
  });
  group = new GroupChatService({ bots, chats, host, emit });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('routes mentions in order, then uses the boss without mentions', async () => {
  await group.send(id, '@Bob @Alice hello');
  expect(deliver.mock.calls.map((c) => c[1])).toEqual([b]);
  expect(group.state(id)).toMatchObject({ current: b, queue: [a] });
  await done(b, 'hello');
  expect(deliver.mock.calls.map((c) => c[1])).toEqual([b, a]);
  await done(a, 'hello');
  await group.send(id, 'question');
  expect(group.state(id)).toMatchObject({ current: a });
  expect(emit).toHaveBeenCalledWith({ kind: 'timeline', chatId: id, seq: 1 });
});

it('retries only the failed member in the same session and consumes the recovery action', async () => {
  await group.send(id, '@Bob @Alice hello');
  await done(b, '', false);
  const failure = entries().find((entry) => entry.kind === 'system')!;
  expect(failure).toMatchObject({ failure: { botId: b, conversationId: b, mode: 'resume' } });
  expect(await group.retry(id, failure.id)).toEqual({ ok: false, error: 'session-busy' });
  await done(a, 'done');
  expect(await group.retry(id, failure.id)).toEqual({ ok: true });
  expect(retryConversation).toHaveBeenCalledWith(b);
  await done(b, 'fixed @Alice');
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(entries().at(-1)).toMatchObject({ kind: 'bot', botId: b, text: 'fixed @Alice' });
  expect(await group.retry(id, failure.id)).toEqual({ ok: false, error: 'retry-unavailable' });
});

it('rejects recovery after a new human message or conversation boundary', async () => {
  await group.send(id, 'hello');
  await done(a, '', false);
  const failure = entries().at(-1)!;
  await group.send(id, 'new task');
  await done(a, 'done');
  expect(await group.retry(id, failure.id)).toEqual({ ok: false, error: 'retry-unavailable' });
  chats.update(id, (chat) => ({ ...chat, epochSeq: failure.seq + 1 }));
  expect(await group.retry(id, failure.id)).toEqual({ ok: false, error: 'retry-unavailable' });
  expect(retryConversation).not.toHaveBeenCalled();
});

it('re-delivers a message that never reached a worker without adding a duplicate human entry', async () => {
  deliver.mockResolvedValueOnce({ ok: false, error: 'offline' });
  await group.send(id, 'hello');
  const failure = entries().at(-1)!;
  expect(await group.retry(id, failure.id)).toEqual({ ok: true });
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(retryConversation).not.toHaveBeenCalled();
  expect(entries().filter((entry) => entry.kind === 'human')).toHaveLength(1);
});

it.each(['removed', 'replaced', 'archived'] as const)(
  'rejects recovery when the member is %s',
  async (change) => {
    await group.send(id, '@Bob hello');
    await done(b, '', false);
    const failure = entries().at(-1)!;
    chats.update(id, (chat) => {
      if (change === 'removed') chat.members = [a, '11111111-1111-4111-8111-111111111111'];
      if (change === 'replaced') chat.sessions[b].conversationId = 'replacement';
      if (change === 'archived') chat.archivedAt = Date.now();
      return chat;
    });
    expect((await group.retry(id, failure.id)).ok).toBe(false);
    expect(retryConversation).not.toHaveBeenCalled();
  }
);

it('restores an interrupted reply as a recoverable failure without automatically rerunning it', async () => {
  await group.send(id, '@Bob hello');
  // 模拟进程中断，不走会清空 router.json 的正常 dispose。
  group = new GroupChatService({ bots, chats, host, emit });
  const interrupted = entries().at(-1)!;
  expect(interrupted).toMatchObject({ failure: { botId: b, mode: 'resume' } });
  expect(retryConversation).not.toHaveBeenCalled();
  const results = await Promise.all([
    group.retry(id, interrupted.id),
    group.retry(id, interrupted.id),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(retryConversation).toHaveBeenCalledTimes(1);
});
it('queued delivery only commits cursor after the worker receives the message', async () => {
  chats.update(id, (chat) => ({ ...chat, sessions: { [a]: { conversationId: a, cursor: 0 } } }));
  deliver.mockResolvedValueOnce({ ok: true, conversationId: a, queued: true });
  await group.send(id, 'hello');
  expect(chats.get(id)!.sessions[a].cursor).toBe(0);
  const options = deliver.mock.calls[0][3];
  deliverySent({ conversationId: a, deliveryId: options.deliveryId });
  expect(chats.get(id)!.sessions[a].cursor).toBe(1);
});
it('resending the same deliveryId is idempotent (phone offline outbox replay)', async () => {
  expect(await group.send(id, 'hello', { deliveryId: 'phone-1' })).toEqual({ ok: true });
  await done(a, 'hi');
  expect(await group.send(id, 'hello', { deliveryId: 'phone-1' })).toEqual({
    ok: true,
    duplicate: true,
  });
  expect(entries().filter((entry) => entry.kind === 'human')).toHaveLength(1);
  expect(deliver).toHaveBeenCalledTimes(1);
  await group.send(id, 'hello', { deliveryId: 'phone-2' });
  expect(entries().filter((entry) => entry.kind === 'human')).toHaveLength(2);
});

it('deduplicates an unconfirmed phone send even after a new conversation and restart', async () => {
  await group.send(id, 'old task', { deliveryId: 'phone-old' });
  await done(a, 'done');
  const boundary = chats.appendEntry(id, {
    kind: 'system',
    id: 'epoch',
    at: Date.now(),
    text: 'new',
    newConversation: true,
  })!;
  chats.update(id, (chat) => ({ ...chat, epochSeq: boundary.seq }));
  group.dispose();
  chats = new BotChatStore(join(root, 'chats'));
  group = new GroupChatService({ bots, chats, host, emit });
  expect(await group.send(id, 'old task', { deliveryId: 'phone-old' })).toEqual({
    ok: true,
    duplicate: true,
  });
  expect(deliver).toHaveBeenCalledTimes(1);
});
it('failed delivery is not a skip and continues to the next member', async () => {
  deliver.mockResolvedValueOnce({ ok: false, error: 'offline' });
  await group.send(id, '@Bob @Alice hello');
  expect(deliver.mock.calls.map((call) => call[1])).toEqual([b, a]);
  expect(entries()).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'system', text: 'Bob 暂时无法回复' })])
  );
});
it('a member over budget gets a system note and the queue moves on', async () => {
  deliver.mockResolvedValueOnce({ ok: false, error: 'budget-exceeded' });
  await group.send(id, '@Bob @Alice hello');
  expect(deliver.mock.calls.map((call) => call[1])).toEqual([b, a]);
  expect(entries().filter((entry) => entry.kind === 'system')).toEqual([
    expect.objectContaining({ text: 'Bob 今日预算已用完' }),
  ]);
});
it('a bot reply records the model that produced it', async () => {
  await group.send(id, '@Bob hello');
  finish({
    chatId: id,
    botId: b,
    conversationId: b,
    turnId: 't',
    text: 'hi',
    ok: true,
    model: 'glm-5.3',
  });
  await group.settled(id);
  expect(entries().at(-1)).toMatchObject({ kind: 'bot', botId: b, model: 'glm-5.3' });
});
it('a turn stopped by the budget writes the same note and relays onwards', async () => {
  await group.send(id, '@Bob @Alice hello');
  finish({
    chatId: id,
    botId: b,
    conversationId: b,
    text: '',
    ok: false,
    error: 'budget-exceeded',
  });
  await group.settled(id);
  expect(entries().at(-1)).toMatchObject({ kind: 'system', text: 'Bob 今日预算已用完' });
  expect(deliver.mock.calls.map((call) => call[1])).toEqual([b, a]);
});
it('a turn stopped by the per-turn token cap says so and relays onwards', async () => {
  await group.send(id, '@Bob @Alice hello');
  finish({
    chatId: id,
    botId: b,
    conversationId: b,
    text: '',
    ok: false,
    error: 'turn-token-limit',
  });
  await group.settled(id);
  expect(entries().at(-1)).toMatchObject({
    kind: 'system',
    text: 'Bob 本回合用量超过单回合上限，已停止',
  });
  expect(deliver.mock.calls.map((call) => call[1])).toEqual([b, a]);
});
it('a turn stopped by the estimated per-turn usage says it was estimated', async () => {
  await group.send(id, '@Bob hello');
  finish({
    chatId: id,
    botId: b,
    conversationId: b,
    text: '',
    ok: false,
    error: 'turn-token-limit',
    estimated: true,
  });
  await group.settled(id);
  expect(entries().at(-1)).toMatchObject({
    kind: 'system',
    text: 'Bob 本回合用量（按估算）超过单回合上限，已停止',
  });
});
it('a routine run over budget resolves with the budget error and notes it', async () => {
  deliver.mockResolvedValueOnce({ ok: false, error: 'budget-exceeded' });
  expect(await group.runAs(id, b, 'routine', 'check')).toEqual({
    ok: false,
    error: 'budget-exceeded',
  });
  expect(entries().at(-1)).toMatchObject({ kind: 'system', text: 'Bob 今日预算已用完' });
});
it('relays use fresh delivery ids and a duplicate delivery is reported instead of hanging', async () => {
  await group.send(id, 'hello', { deliveryId: 'human' });
  expect(deliver.mock.calls[0][3]).toMatchObject({ deliveryId: 'human' });
  deliver.mockResolvedValueOnce({ ok: true, conversationId: b, duplicate: true });
  await done(a, '@Bob go');
  expect(deliver.mock.calls[1][3].deliveryId).not.toBe('human');
  expect(entries().at(-1)).toMatchObject({
    kind: 'system',
    text: 'Bob 的投递已处理过，本次未发出',
  });
  expect(group.state(id)).toMatchObject({ current: null });
});
it('disposing prevents background relay and settles autonomous waiters', async () => {
  await group.send(id, 'hello');
  const pending = group.runAs(id, b, 'routine', 'routine');
  await group.settled(id);
  group.dispose();
  expect(await pending).toMatchObject({ ok: false });
  await done(a, '@Bob next');
  expect(deliver).toHaveBeenCalledTimes(1);
});

it('queues routine replies behind the group round and selects the requested member', async () => {
  await group.send(id, 'hello');
  const routine = group.runAs(id, b, '<routine title="check">check it</routine>', 'check', {
    deliveryId: 'r1',
  });
  await group.settled(id);
  expect(deliver).toHaveBeenCalledTimes(1);
  await done(a, 'done');
  expect(await routine).toMatchObject({ ok: true });
  expect(deliver.mock.calls[1]).toEqual([
    id,
    b,
    expect.stringMatching(/^<routine title="check">check it<\/routine>\n[\s\S]*hello[\s\S]*done/),
    { deliveryId: 'r1', queueIfBusy: true },
  ]);
  expect(
    entries().some((entry) => entry.kind === 'system' && entry.text === '例行任务：check')
  ).toBe(true);
  await done(b, 'routine reply');
  expect(
    entries().some(
      (entry) => entry.kind === 'bot' && entry.botId === b && entry.text === 'routine reply'
    )
  ).toBe(true);
});

it('limits relay and does not publish skip replies', async () => {
  chats.update(id, (c) => ({ ...c, routing: { mode: 'boss', maxHops: 1, maxTurnsPerBot: 2 } }));
  await group.send(id, 'go');
  await done(a, '@Bob go');
  await done(b, '@Alice again');
  expect(group.state(id)).toMatchObject({ current: null, hops: 1 });
  expect(entries().some((e) => e.kind === 'system' && e.text.includes('上限'))).toBe(true);
  await group.send(id, '@所有人');
  await done(a, ' [skip] ');
  expect(group.state(id)).toMatchObject({ current: b });
  expect(entries().filter((e) => e.kind === 'bot')).toHaveLength(2);
});

describe('all-skipped human rounds', () => {
  const targets = () => deliver.mock.calls.map((call) => call[1]);
  const notices = () => entries().filter((entry) => entry.kind === 'system');

  it('forwards a mentioned member skip to the boss once and retains the original image', async () => {
    const images = [{ data: 'cGljdHVyZQ==', mimeType: 'image/png' }];
    await group.send(
      id,
      '@Bob 这里怎么乱码了？',
      { images, deliveryId: 'human-image' },
      undefined,
      ['image.png']
    );
    await done(b, ' [SKIP] ');
    expect(targets()).toEqual([b, a]);
    expect(deliver.mock.calls[1][2]).toContain('这里怎么乱码了？');
    expect(deliver.mock.calls[1][3]).toMatchObject({ images });
    expect(deliver.mock.calls[1][3].deliveryId).not.toBe('human-image');
    expect(notices()).toMatchObject([{ text: '「Bob」已跳过，交给群主「Alice」回复。' }]);
    await done(a, '[skip]');
    expect(targets()).toEqual([b, a]);
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    expect(notices().at(-1)?.text).toContain('本轮无人回复');
    expect(entries().filter((entry) => entry.kind === 'bot')).toEqual([]);
  });

  it('reports no reply when the boss is the only skipped member', async () => {
    await group.send(id, 'hello');
    await done(a, '[skip]');
    expect(targets()).toEqual([a]);
    expect(notices()).toMatchObject([{ text: '「Alice」已跳过，本轮无人回复。' }]);
  });

  it('waits for the whole selected queue before forwarding and names every skipped member', async () => {
    const carol = bots.create({ name: 'Carol' }, []);
    if (!carol.ok) throw new Error('fixture');
    const c = carol.bot.id;
    chats.update(id, (chat) => ({ ...chat, members: [a, b, c] }));
    await group.send(id, '@Bob @Carol hello');
    await done(b, '[skip]');
    expect(targets()).toEqual([b, c]);
    expect(notices()).toEqual([]);
    await done(c, '[skip]');
    expect(targets()).toEqual([b, c, a]);
    expect(notices()).toMatchObject([{ text: '「Bob」「Carol」已跳过，交给群主「Alice」回复。' }]);
  });

  it('does not repeat the boss when everyone was explicitly selected', async () => {
    await group.send(id, '@所有人 hello');
    await done(a, '[skip]');
    expect(notices()).toEqual([]);
    await done(b, '[skip]');
    expect(targets()).toEqual([a, b]);
    expect(notices()).toMatchObject([{ text: '「Alice」「Bob」已跳过，本轮无人回复。' }]);
  });

  it('does not forward a skip after someone has already spoken', async () => {
    await group.send(id, '@Bob hello');
    await done(b, 'answer @Alice');
    await done(a, '[skip]');
    expect(targets()).toEqual([b, a]);
    expect(notices()).toEqual([]);
  });

  it.each(['deliver', 'turn'] as const)(
    'does not treat a %s failure as a skip',
    async (failure) => {
      if (failure === 'deliver') deliver.mockResolvedValueOnce({ ok: false, error: 'offline' });
      await group.send(id, '@Bob @Alice hello');
      if (failure === 'turn') await done(b, '[skip]', false);
      await done(a, '[skip]');
      expect(targets()).toEqual([b, a]);
      expect(notices()).toHaveLength(1);
      expect(notices()[0].text).not.toContain('本轮无人回复');
    }
  );

  it('does not forward autonomous skips or retain skip tracking from the previous round', async () => {
    await group.send(id, '@Bob hello');
    await done(b, '[skip]');
    await done(a, '[skip]');
    const count = notices().length;
    await group.runAs(id, b, 'routine', undefined);
    await done(b, '[skip]');
    expect(targets()).toEqual([b, a, b]);
    expect(notices()).toHaveLength(count);
  });

  it('旁路消息不丢弃原轮的 skip 兜底', async () => {
    await group.send(id, '@Bob old');
    await group.send(id, 'new');
    expect(targets()).toEqual([b, a]);
    const parallelId = deliver.mock.calls[1][3].deliveryId;
    await done(a, 'parallel', true, parallelId);
    await done(b, '[skip]');
    expect(targets()).toEqual([b, a, a]);
    expect(deliver.mock.calls[2][2]).not.toContain('new');
    expect(notices()[0].text).toContain('交给群主');
    await done(a, '[skip]');
    expect(notices().at(-1)?.text).toContain('本轮无人回复');
  });

  it('counts the fallback toward the existing hop and per-member limits', async () => {
    chats.update(id, (chat) => ({
      ...chat,
      routing: { ...chat.routing, maxHops: 1, maxTurnsPerBot: 1 },
    }));
    await group.send(id, '@Bob hello');
    await done(b, '[skip]');
    expect(group.state(id)).toMatchObject({ hops: 1, turnsByBot: { [a]: 1, [b]: 0 } });
    await done(a, '@Bob take another look');
    expect(targets()).toEqual([b, a]);
    expect(group.state(id)).toMatchObject({ current: null });
    expect(notices().at(-1)?.text).toContain('本轮接力已达上限');
  });

  it('does not forward twice even if the boss changes during the fallback', async () => {
    const carol = bots.create({ name: 'Carol' }, []);
    if (!carol.ok) throw new Error('fixture');
    const c = carol.bot.id;
    chats.update(id, (chat) => ({ ...chat, members: [a, b, c] }));
    await group.send(id, '@Bob hello');
    await done(b, '[skip]');
    chats.update(id, (chat) => ({ ...chat, bossBotId: c }));
    await done(a, '[skip]');
    expect(targets()).toEqual([b, a]);
    expect(notices().at(-1)?.text).toContain('本轮无人回复');
  });
});

it('continues after failed turns and delivery without advancing failed cursor', async () => {
  chats.update(id, (c) => ({ ...c, sessions: { [a]: { conversationId: a, cursor: 0 } } }));
  deliver.mockResolvedValueOnce({ ok: false, error: 'offline' });
  await group.send(id, '@Alice @Bob');
  expect(chats.get(id)!.sessions[a].cursor).toBe(0);
  expect(chats.get(id)!.sessions[b].cursor).toBeGreaterThan(0);
  expect(group.state(id)).toMatchObject({ current: b });
  await done(b, '@Alice ignored', false);
  expect(group.state(id)).toMatchObject({ current: null });
  expect(entries().filter((e) => e.kind === 'system')).toHaveLength(2);
});

it('只选中当前群主时沿用 steer，无 @ 连发不积压也不清原队列', async () => {
  await group.send(id, '@所有人');
  await group.send(id, '@Alice detail');
  expect(deliver.mock.calls[1][2]).toContain('detail');
  expect(group.state(id)).toMatchObject({ pendingHuman: false });
  await group.send(id, 'next');
  await group.send(id, 'another');
  expect(deliver).toHaveBeenCalledTimes(4);
  expect(deliver.mock.calls.slice(1).every((call) => !call[3].queueIfBusy)).toBe(true);
  expect(group.state(id)).toMatchObject({ current: a, queue: [b], pendingHuman: false });
  await done(a, '@Alice ignored');
  expect(group.state(id)).toMatchObject({
    current: b,
    queue: [],
    hops: 0,
    turnsByBot: { [a]: 1, [b]: 1 },
    pendingHuman: false,
  });
});

it('recovers interrupted routing without resuming and stop ignores late results', async () => {
  await group.send(id, '@所有人');
  group = new GroupChatService({ bots, chats: new BotChatStore(join(root, 'chats')), host, emit });
  expect(group.state(id)).toMatchObject({ current: null, queue: [] });
  expect(new BotChatStore(join(root, 'chats')).readEntries(id).at(-1)).toMatchObject({
    kind: 'system',
    text: '回复被中断',
  });
  await group.send(id, '@所有人');
  await group.stop(id);
  expect(stopTurn).toHaveBeenCalledWith(id, a);
  await done(a, 'late');
  expect(group.state(id)).toMatchObject({ current: null, queue: [] });
});

it('skips removed members and reports unavailable boss', async () => {
  await group.send(id, '@所有人');
  bots.remove(b);
  await done(a, 'done');
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(entries().at(-1)).toMatchObject({ kind: 'system', text: '请先指定群主' });
  bots.remove(a);
  await group.send(id, 'anyone');
  expect(entries().at(-1)).toMatchObject({ kind: 'system', text: '请先指定群主' });
});

it('enforces per-member turn limits and skips archived queued members', async () => {
  chats.update(id, (c) => ({ ...c, routing: { mode: 'boss', maxHops: 4, maxTurnsPerBot: 1 } }));
  await group.send(id, 'start');
  await done(a, '@Bob next');
  await done(b, '@Alice again');
  expect(group.state(id)).toMatchObject({ current: null });
  expect(entries().at(-1)).toMatchObject({
    kind: 'system',
    text: expect.stringContaining('本轮已回复 1 次'),
  });
  await group.send(id, '@所有人');
  bots.setArchived(b, true);
  await done(a, '[skip]');
  expect(group.state(id)).toMatchObject({ current: null });
  expect(deliver).toHaveBeenCalledTimes(3);
});

it('rolls back a newly created session cursor when delivery fails', async () => {
  deliver.mockImplementationOnce(async (_chatId, botId) => {
    chats.update(id, (c) => ({
      ...c,
      sessions: { [botId]: { conversationId: botId, cursor: chats.lastSeq(id) } },
    }));
    throw new Error('offline');
  });
  await group.send(id, '@Alice @Bob');
  expect(chats.get(id)!.sessions[a].cursor).toBe(0);
  expect(group.state(id)).toMatchObject({ current: b });
});

it('串行归并同时到达的人类消息，但被 @ 的其他成员立即收到投递', async () => {
  await Promise.all([group.send(id, '@Alice first'), group.send(id, '@Bob second')]);
  expect(deliver.mock.calls.map((call) => call[1])).toEqual([a, b]);
  expect(group.state(id)).toMatchObject({ current: a, pendingHuman: false });
  await done(a, 'done');
  expect(group.state(id)).toMatchObject({ current: null });
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(entries().map((e) => e.seq)).toEqual([1, 2, 3]);
});

it.each([true, false])(
  '并行回复先结束=%s：两人都写入时间线，新消息不重复投递也不接力',
  async (parallelFirst) => {
    await group.send(id, '@Alice first');
    deliver.mockResolvedValueOnce({ ok: true, conversationId: a, steered: true });
    await group.send(id, '@Alice @Bob second');
    expect(deliver.mock.calls.map((call) => call[1])).toEqual([a, a, b]);
    const parallelId = deliver.mock.calls[2][3].deliveryId;
    expect(deliver.mock.calls[1][2]).toContain('second');
    expect(group.state(id)).toMatchObject({ current: a, pendingHuman: false });
    expect(stopTurn).not.toHaveBeenCalled();
    if (parallelFirst) {
      await done(b, 'parallel @Alice', true, parallelId);
      expect(group.state(id)).toMatchObject({ current: a });
      await done(a, 'primary');
    } else {
      await done(a, 'primary');
      await done(b, 'parallel @Alice', true, parallelId);
    }
    expect(
      entries()
        .filter((entry) => entry.kind === 'bot')
        .map((entry) => entry.text)
        .sort()
    ).toEqual(['parallel @Alice', 'primary']);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(group.state(id)).toMatchObject({ current: null, pendingHuman: false });
  }
);

it('宿主回报 queued 前已送出 steer 时，不等待第二份结束事件', async () => {
  const onBatchSettled = vi.fn();
  group.dispose();
  group = new GroupChatService({ bots, chats, host, emit, onBatchSettled });
  await group.send(id, '@Alice start');
  deliver.mockImplementationOnce(async (_chatId, botId, _text, options) => {
    deliverySent({ conversationId: botId, deliveryId: options.deliveryId, steered: true });
    return { ok: true, conversationId: botId, queued: true };
  });
  await group.send(id, '@Alice supplement');
  await done(a, 'combined');
  expect(entries().filter((entry) => entry.kind === 'bot')).toHaveLength(1);
  expect(onBatchSettled).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledTimes(2);
});

it('并行成员也在原队列中时，保留队列且并行结果不能推进其后续回合', async () => {
  await group.send(id, '@Alice @Bob first');
  await group.send(id, '@Bob second');
  expect(group.state(id)).toMatchObject({ current: a, queue: [b] });
  expect(deliver).toHaveBeenCalledTimes(2);
  const parallelId = deliver.mock.calls[1][3].deliveryId;
  await done(a, 'primary');
  expect(deliver).toHaveBeenCalledTimes(3);
  expect(deliver.mock.calls[2][3]).toMatchObject({ queueIfBusy: true });
  await done(b, 'parallel @Alice', true, parallelId);
  expect(group.state(id)).toMatchObject({ current: b });
  await done(b, 'queued', true, deliver.mock.calls[2][3].deliveryId);
  expect(group.state(id)).toMatchObject({ current: null });
  expect(deliver).toHaveBeenCalledTimes(3);
});

it('宿主达到并发上限时，保留排队投递并在时间线说明成员名字', async () => {
  await group.send(id, '@Alice first');
  const send = deliver.getMockImplementation()!;
  deliver.mockImplementationOnce(async (...args) => ({ ...(await send(...args)), queued: true }));
  await group.send(id, '@Bob second');
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(deliver.mock.calls[1][3].queueIfBusy).toBeUndefined();
  expect(entries().at(-1)).toMatchObject({
    kind: 'system',
    text: expect.stringMatching(/Bob.*排队/),
  });
  await done(a, 'primary');
  await done(b, 'parallel', true, deliver.mock.calls[1][3].deliveryId);
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(entries().at(-1)).toMatchObject({ kind: 'bot', botId: b });
});

it('停止群回复会同时停止并行成员并忽略迟到结果', async () => {
  await group.send(id, '@Alice first');
  await group.send(id, '@Bob second');
  expect(deliver).toHaveBeenCalledTimes(2);
  const parallelId = deliver.mock.calls[1][3].deliveryId;
  await group.stop(id);
  expect(stopTurn.mock.calls).toEqual([
    [id, a],
    [id, b],
  ]);
  await done(b, 'late', true, parallelId);
  expect(entries().filter((entry) => entry.kind === 'bot')).toEqual([]);
});

it('并行投递失败有明确反馈，原回复正常结束且不重投失败消息', async () => {
  await group.send(id, '@Alice first');
  deliver.mockResolvedValueOnce({ ok: false, error: 'offline' });
  await group.send(id, '@Bob second');
  expect(entries().at(-1)).toMatchObject({
    kind: 'system',
    text: 'Bob 投递失败：offline',
    failure: { botId: b, mode: 'deliver' },
  });
  await done(a, 'primary');
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(entries().at(-1)).toMatchObject({ kind: 'bot', botId: a });
});

it('原回复已结束而并行成员仍在回复时，不提前发送整批完成通知', async () => {
  const settled = vi.fn();
  group.dispose();
  group = new GroupChatService({ bots, chats, host, emit, onBatchSettled: settled });
  await group.send(id, '@Alice first');
  await group.send(id, '@Bob second');
  await done(a, 'primary');
  expect(settled).not.toHaveBeenCalled();
  await done(b, 'parallel', true, deliver.mock.calls[1][3].deliveryId);
  expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ botIds: [a, b] }));
});

it('并行成员在重启后保留中断提示，不自动重放任务', async () => {
  await group.send(id, '@Alice first');
  await group.send(id, '@Bob second');
  await done(a, 'primary');
  group = new GroupChatService({ bots, chats, host, emit });
  expect(entries().at(-1)).toMatchObject({
    kind: 'system',
    text: '回复被中断',
    failure: { botId: b, conversationId: b, mode: 'resume' },
  });
  expect(deliver).toHaveBeenCalledTimes(2);
});

it('并行成员会话被移除后的结束事件不会永久阻塞整批结算', async () => {
  const settled = vi.fn();
  group.dispose();
  group = new GroupChatService({ bots, chats, host, emit, onBatchSettled: settled });
  await group.send(id, '@Alice first');
  await group.send(id, '@Bob second');
  await done(a, 'primary');
  chats.update(id, (chat) => {
    delete chat.sessions[b];
    return chat;
  });
  await done(b, 'removed', false, deliver.mock.calls[1][3].deliveryId);
  expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ botIds: [a] }));
  expect(entries().filter((entry) => entry.kind === 'bot')).toHaveLength(1);
});

it('同一成员的多个排队投递不重复包含已排队的人类消息', async () => {
  await group.send(id, '@Alice first');
  const send = deliver.getMockImplementation()!;
  deliver.mockImplementation(async (...args) => ({ ...(await send(...args)), queued: true }));
  await group.send(id, '@Bob second');
  await group.send(id, '@Bob third');
  expect(deliver.mock.calls[1][2]).toContain('second');
  expect(deliver.mock.calls[2][2]).toContain('third');
  expect(deliver.mock.calls[2][2]).not.toContain('second');
  expect(chats.get(id)!.sessions[b].cursor).toBe(0);
});

it('多次追加 @ 同一成员使用不同投递身份，迟到的重复结果不结算后续接力', async () => {
  await group.send(id, '@Alice @Bob first');
  await group.send(id, '@Bob second');
  await group.send(id, '@Bob third');
  const second = deliver.mock.calls[1][3].deliveryId;
  const third = deliver.mock.calls[2][3].deliveryId;
  expect(second).not.toBe(third);
  await done(a, 'primary');
  await done(b, 'second', true, second);
  await done(b, 'second duplicate', true, second);
  expect(group.state(id)).toMatchObject({ current: b });
  await done(b, 'third', true, third);
  expect(group.state(id)).toMatchObject({ current: b });
  await done(b, 'relay', true, deliver.mock.calls[3][3].deliveryId);
  expect(
    entries()
      .filter((entry) => entry.kind === 'bot')
      .map((entry) => entry.text)
  ).toEqual(['primary', 'second', 'third', 'relay']);
  expect(deliver).toHaveBeenCalledTimes(4);
});

it('refuses a new round until a failed stop is successfully retried', async () => {
  await group.send(id, '@所有人');
  stopTurn.mockRejectedValueOnce(new Error('release timed out'));
  expect(await group.stop(id)).toMatchObject({ ok: false });
  expect(await group.send(id, 'too soon')).toMatchObject({ ok: false });
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(await group.stop(id)).toEqual({ ok: true });
  await group.send(id, 'next');
  expect(deliver).toHaveBeenCalledTimes(2);
});

describe('smart routing', () => {
  const deferred = () => {
    let resolve!: (value: SmartRouteDecision) => void;
    const promise = new Promise<SmartRouteDecision>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const select =
    vi.fn<(input: SmartRouteInput, signal: AbortSignal) => Promise<SmartRouteDecision>>();
  const next = vi.fn<
    (input: DiscussNextInput, signal: AbortSignal) => Promise<DiscussNextDecision>
  >(async () => ({ end: true }));
  let timeoutMs = 1000;
  const useResponder = () => {
    group.dispose();
    group = new GroupChatService({
      bots,
      chats,
      host,
      emit,
      responder: { timeoutMs: () => timeoutMs, select, next },
    });
  };
  beforeEach(() => {
    select.mockReset();
    next.mockReset().mockResolvedValue({ end: true });
    timeoutMs = 1000;
    useResponder();
  });

  it('新群缺省智能选人：选中成员回复，并在其发言上标 routedBy', async () => {
    select.mockResolvedValueOnce({ ids: [b] });
    await group.send(id, '帮忙改个接口');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(b);
    const input = select.mock.calls[0][0];
    expect(input.message).toBe('帮忙改个接口');
    expect(input.candidates.map((c) => c.id)).toEqual([a, b]);
    await done(b, 'ok');
    expect(entries().at(-1)).toMatchObject({ kind: 'bot', botId: b, routedBy: 'smart' });
    select.mockResolvedValueOnce({ ids: [a] });
    await group.send(id, '大家觉得呢');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    await done(a, 'fine');
    expect(entries().at(-1)).not.toHaveProperty('routedBy');
  });

  it('分类期间 chatState 暴露 routing，超时兜底群主并提示选人不可用', async () => {
    timeoutMs = 20;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    select.mockImplementationOnce(() => new Promise(() => {}));
    await group.send(id, 'hello');
    expect(group.state(id)).toMatchObject({ routing: true, current: null });
    expect(deliver).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(a);
    expect(group.state(id)).toMatchObject({ routing: false, current: a });
    expect(
      entries()
        .filter((e) => e.kind === 'system')
        .at(-1)
    ).toMatchObject({
      text: '智能选人不可用（选人超时），已交给群主',
    });
    await done(a, 'hi');
    expect(entries().at(-1)).toMatchObject({ kind: 'bot', botId: a });
    expect(entries().at(-1)).not.toHaveProperty('routedBy');
    warn.mockRestore();
  });

  it('出错或选中不在群成员时兜底群主', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    select.mockRejectedValueOnce(new Error('模型 gpt-5：鉴权失败'));
    await group.send(id, 'one');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(a);
    expect(
      entries()
        .filter((e) => e.kind === 'system')
        .at(-1)
    ).toMatchObject({
      text: '智能选人不可用（模型 gpt-5：鉴权失败），已交给群主',
    });
    await done(a, 'ok');
    select.mockResolvedValueOnce({ ids: ['ghost'] });
    await group.send(id, 'two');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1][1]).toBe(a);
    warn.mockRestore();
  });

  it.each(['judge', 'pi-classifier'] as const)(
    '%s 返回无法识别的结果：提示「判断结果无法识别」后交给群主；明确选群主不提示',
    async (source) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const judge = vi
        .fn<SmartRouterDeps['judge']>()
        .mockResolvedValueOnce('INTENT: build\nmaybe Dave')
        .mockResolvedValueOnce('INTENT: answer\nBOSS');
      let memberCalls = 0;
      const classify = vi.fn<SmartRouterDeps['classify']>(async (_config, question) => {
        if ('build' in question.criteria) return null;
        memberCalls += 1;
        return memberCalls === 1 ? { ghost: 1 } : { [a]: 0.9, [b]: 0.1 };
      });
      group.dispose();
      group = new GroupChatService({
        bots,
        chats,
        host,
        emit,
        responder: createSmartRouter({
          settings: () => ({
            botRouteClassifier: {
              source,
              model: { providerId: 'p', modelId: 'm' },
              timeoutMs: 3000,
            },
          }),
          judge,
          classify,
        }),
      });
      const systems = () =>
        entries()
          .filter((e) => e.kind === 'system')
          .map((e) => e.text);
      await group.send(id, 'one');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      expect(deliver.mock.calls[0][1]).toBe(a);
      expect(systems()).toEqual(['智能选人不可用（判断结果无法识别），已交给群主']);
      await done(a, 'ok');
      await group.send(id, 'two');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(deliver.mock.calls[1][1]).toBe(a);
      expect(systems()).toEqual(['智能选人不可用（判断结果无法识别），已交给群主']);
      await done(a, 'ok');
      expect(source === 'judge' ? judge : classify).toHaveBeenCalled();
      warn.mockRestore();
    }
  );

  it('选人模型实测失败时提示原因并兜底群主', async () => {
    select.mockResolvedValueOnce({ ids: [], failure: '模型 gpt-5：调用超时' });
    await group.send(id, 'hello');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(a);
    expect(
      entries()
        .filter((e) => e.kind === 'system')
        .at(-1)
    ).toMatchObject({
      text: '智能选人不可用（模型 gpt-5：调用超时），已交给群主',
    });
    await done(a, 'ok');
  });

  it('分类期间来新消息：放弃本次结果，按合并后的消息重新判定', async () => {
    const first = deferred();
    const second = deferred();
    select.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await group.send(id, 'first', { deliveryId: 'd1' });
    await group.send(id, 'second', { deliveryId: 'd2' });
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[0][1].aborted).toBe(true);
    expect(select.mock.calls[1][0].message).toBe('second');
    expect(select.mock.calls[1][0].recent.at(-1)).toEqual({ speaker: 'Human', text: 'first' });
    first.resolve({ ids: [a] });
    await group.settled(id);
    expect(deliver).not.toHaveBeenCalled();
    second.resolve({ ids: [b] });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(b);
    expect(deliver.mock.calls[0][3]).toMatchObject({ deliveryId: 'd2' });
  });

  it('分类期间来 @ 消息直接按 @ 路由', async () => {
    select.mockReturnValueOnce(new Promise(() => {}));
    await group.send(id, 'first');
    await group.send(id, '@Bob 你来');
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][1].aborted).toBe(true);
    expect(deliver.mock.calls.map((c) => c[1])).toEqual([b]);
    expect(group.state(id)).toMatchObject({ routing: false, current: b });
  });

  it('@ 消息与 boss 模式不调用分类器', async () => {
    await group.send(id, '@Bob hi');
    await done(b, 'ok');
    await group.send(id, '@所有人 hi');
    await done(a, 'ok');
    await done(b, 'ok');
    chats.update(id, (c) => ({ ...c, routing: { ...c.routing, mode: 'boss' } }));
    await group.send(id, 'no mention');
    expect(select).not.toHaveBeenCalled();
    expect(deliver.mock.calls.at(-1)?.[1]).toBe(a);
  });

  it('当前回复未结束即智能选人投递，结束后不重复投递', async () => {
    await group.send(id, '@Alice start');
    select.mockResolvedValueOnce({ ids: [b] });
    await group.send(id, 'follow up');
    expect(select).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1][1]).toBe(b);
    expect(deliver.mock.calls[1][3].queueIfBusy).toBeUndefined();
    expect(group.state(id)).toMatchObject({ current: a, pendingHuman: false });
    expect(stopTurn).not.toHaveBeenCalled();
    await done(a, 'done');
    await done(b, 'parallel', true, deliver.mock.calls[1][3].deliveryId);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(group.state(id)).toMatchObject({ current: null, pendingHuman: false });
    expect(entries().filter((entry) => entry.kind === 'bot')).toHaveLength(2);
  });

  it('智能选人只选当前成员时 steer，不排第二个会话', async () => {
    await group.send(id, '@Bob @Alice start');
    select.mockResolvedValueOnce({ ids: [b] });
    await group.send(id, 'follow up');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1][1]).toBe(b);
    expect(deliver.mock.calls[1][3].queueIfBusy).toBeUndefined();
    expect(group.state(id)).toMatchObject({ current: b, queue: [a], pendingHuman: false });
    await done(b, 'done');
    await done(a, 'done');
    expect(deliver.mock.calls.map((call) => call[1])).toEqual([b, b, a]);
  });

  it('主回复已结束但并行回复仍在时，新消息继续旁路选人', async () => {
    await group.send(id, '@Alice start');
    await group.send(id, '@Bob parallel');
    const parallelId = deliver.mock.calls[1][3].deliveryId;
    await done(a, 'primary');
    const before = group.state(id);
    select.mockResolvedValueOnce({ ids: [a, b] });
    await group.send(id, 'follow up');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(4));
    expect(deliver.mock.calls.slice(2).map((call) => call[1])).toEqual([a, b]);
    expect(deliver.mock.calls.slice(2).every((call) => !call[3].queueIfBusy)).toBe(true);
    expect(group.state(id)).toEqual(before);
    await done(b, 'parallel', true, parallelId);
    expect(deliver).toHaveBeenCalledTimes(4);
  });

  it.each(['follow up', '@Alice follow up'])(
    'current 插话 %s 被宿主排队时仍记录结果',
    async (text) => {
      await group.send(id, '@Alice start');
      select.mockResolvedValueOnce({ ids: [a] });
      deliver.mockResolvedValueOnce({ ok: true, conversationId: a, queued: true });
      await group.send(id, text);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      const deliveryId = deliver.mock.calls[1][3].deliveryId;
      expect(entries().at(-1)).toMatchObject({ text: 'Alice 正在排队，等待可用会话' });
      await done(a, 'main');
      await done(a, 'queued interjection', true, deliveryId);
      expect(
        entries()
          .filter((entry) => entry.kind === 'bot')
          .map((entry) => entry.text)
      ).toEqual(['main', 'queued interjection']);
      expect(deliver).toHaveBeenCalledTimes(2);
    }
  );

  it('选人期间主轮已结束，迟到结果仅旁路投递一次', async () => {
    await group.send(id, '@Alice start');
    const pick = deferred();
    select.mockReturnValueOnce(pick.promise);
    await group.send(id, 'follow up');
    await done(a, 'main');
    const before = group.state(id);
    pick.resolve({ ids: [b] });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(group.state(id)).toEqual({ ...before, routing: false });
    await done(b, 'parallel', true, deliver.mock.calls[1][3].deliveryId);
    expect(entries().filter((entry) => entry.kind === 'bot')).toHaveLength(2);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('旁路 build 仍带执行指令和标记，主轮图片不被旁路选项覆盖', async () => {
    const images = [{ data: 'b2xk', mimeType: 'image/png' }];
    await group.send(id, '@Alice @Bob start', { images, source: 'human' });
    select.mockResolvedValueOnce({ ids: [b], intent: 'build' });
    await group.send(id, '改代码', { source: 'human' });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1][2]).toContain('先动手完成');
    expect(deliver.mock.calls[1][3].images).toBeUndefined();
    await done(b, 'changed', true, deliver.mock.calls[1][3].deliveryId);
    expect(entries().at(-1)).toMatchObject({ botId: b, routedBy: 'smart:build' });
    await done(a, 'primary');
    expect(deliver.mock.calls[2][3]).toMatchObject({ images, source: 'bot' });
  });

  it.each(['@Alice detail', '@Bob detail'])(
    '旁路分类期间 %s 沿用 steer 或 parallel',
    async (text) => {
      await group.send(id, '@Alice @Bob start');
      const pick = deferred();
      select.mockReturnValueOnce(pick.promise);
      await group.send(id, 'follow up');
      await group.send(id, text);
      expect(select.mock.calls[0][1].aborted).toBe(true);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliver.mock.calls[1][1]).toBe(text.includes('Alice') ? a : b);
      expect(deliver.mock.calls[1][3].queueIfBusy).toBeUndefined();
      expect(group.state(id)).toMatchObject({ current: a, queue: [b], routing: false });
      pick.resolve({ ids: [b] });
      await group.settled(id);
      expect(deliver).toHaveBeenCalledTimes(2);
    }
  );

  it('旁路选人连发只取消旁路，主轮继续接力，旧结果不落地', async () => {
    await group.send(id, '@Alice @Bob start');
    const first = deferred();
    const second = deferred();
    select.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await group.send(id, 'first');
    await group.send(id, 'second');
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[0][1].aborted).toBe(true);
    expect(select.mock.calls[1][0].message).toBe('second');
    expect(select.mock.calls[1][0].recent.at(-1)).toEqual({ speaker: 'Human', text: 'first' });
    expect(group.state(id)).toMatchObject({ current: a, queue: [b], routing: true });
    await done(a, 'primary');
    expect(deliver.mock.calls.map((call) => call[1])).toEqual([a, b]);
    first.resolve({ ids: [a] });
    deliver.mockResolvedValueOnce({ ok: true, conversationId: b, steered: true });
    second.resolve({ ids: [b, a] });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(4));
    expect(deliver.mock.calls.slice(2).map((call) => call[1])).toEqual([b, a]);
    expect(group.state(id)).toMatchObject({ current: b, queue: [], routing: false });
    expect(stopTurn).not.toHaveBeenCalled();
    await done(b, 'primary second');
    await done(a, 'parallel', true, deliver.mock.calls[3][3].deliveryId);
    expect(deliver).toHaveBeenCalledTimes(4);
  });

  it('旁路超时兜底群主，排队提示可见且主轮不变', async () => {
    timeoutMs = 20;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await group.send(id, '@Bob start');
    select.mockReturnValueOnce(new Promise(() => {}));
    deliver.mockResolvedValueOnce({ ok: true, conversationId: a, queued: true });
    await group.send(id, 'follow up');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1][1]).toBe(a);
    expect(deliver.mock.calls[1][3].queueIfBusy).toBeUndefined();
    expect(entries().at(-1)).toMatchObject({ text: 'Alice 正在排队，等待可用会话' });
    expect(group.state(id)).toMatchObject({ current: b, pendingHuman: false });
    warn.mockRestore();
  });

  it('停止会取消旁路选人及主回复，迟到选人不投递', async () => {
    await group.send(id, '@Bob start');
    const pick = deferred();
    select.mockReturnValueOnce(pick.promise);
    await group.send(id, 'follow up');
    await group.stop(id);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][1].aborted).toBe(true);
    expect(stopTurn).toHaveBeenCalledWith(id, b);
    pick.resolve({ ids: [a] });
    await group.settled(id);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('例行任务在分类结束后再派发', async () => {
    const pick = deferred();
    select.mockReturnValueOnce(pick.promise);
    await group.send(id, 'hello');
    const routine = group.runAs(id, b, 'routine', undefined);
    await group.settled(id);
    expect(deliver).not.toHaveBeenCalled();
    pick.resolve({ ids: [b] });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(b);
    await done(b, 'reply');
    expect(await routine).toMatchObject({ ok: true });
  });

  it('stop、删除群与 dispose 取消进行中的分类', async () => {
    const pick = deferred();
    select.mockReturnValueOnce(pick.promise);
    await group.send(id, 'hello');
    expect(await group.stop(id)).toEqual({ ok: true });
    expect(select.mock.calls[0][1].aborted).toBe(true);
    expect(group.state(id)).toMatchObject({ routing: false });
    pick.resolve({ ids: [b] });
    await group.settled(id);
    expect(deliver).not.toHaveBeenCalled();

    select.mockReturnValueOnce(new Promise(() => {}));
    await group.send(id, 'again');
    group.discard(id);
    expect(select.mock.calls[1][1].aborted).toBe(true);

    select.mockReturnValueOnce(new Promise(() => {}));
    await group.send(id, 'third');
    group.dispose();
    expect(select.mock.calls[2][1].aborted).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('选中多人时依次回复，后一位的增量上下文含前一位刚发的回复，均标 routedBy', async () => {
    select.mockResolvedValueOnce({ ids: [b, a] });
    await group.send(id, '这个需求怎么做');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(b);
    expect(group.state(id)).toMatchObject({ current: b, queue: [a], hops: 0 });
    await done(b, '后端这边加个接口');
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][1]).toBe(a);
    expect(deliver.mock.calls[1][2]).toContain('后端这边加个接口');
    await done(a, '同意');
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    const replies = entries().filter((e) => e.kind === 'bot');
    expect(replies).toMatchObject([
      { botId: b, routedBy: 'smart' },
      { botId: a, routedBy: 'smart' },
    ]);
  });

  it('智能选中成员全跳过时保留原图交群主，不再调用分类器', async () => {
    select.mockResolvedValueOnce({ ids: [b] });
    const images = [{ data: 'cGljdHVyZQ==', mimeType: 'image/png' }];
    await group.send(id, '这里怎么乱码了？', { images }, undefined, ['image.png']);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await done(b, '[skip]');
    expect(deliver.mock.calls.map((call) => call[1])).toEqual([b, a]);
    expect(deliver.mock.calls[1][2]).toContain('这里怎么乱码了？');
    expect(deliver.mock.calls[1][3]).toMatchObject({ images });
    expect(select).toHaveBeenCalledTimes(1);
    await done(a, '我来检查');
    expect(group.state(id)).toMatchObject({ current: null, hops: 1 });
    expect(entries().filter((entry) => entry.kind === 'bot')).toMatchObject([{ botId: a }]);
    expect(entries().at(-1)).not.toHaveProperty('routedBy');
  });

  it('多人队列中第二位 [skip]：不写条目、不报错并结束本轮', async () => {
    select.mockResolvedValueOnce({ ids: [b, a] });
    await group.send(id, 'q');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await done(b, 'answer');
    await done(a, ' [skip] ');
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    expect(entries().filter((e) => e.kind === 'bot')).toMatchObject([{ botId: b }]);
    expect(entries().some((e) => e.kind === 'system')).toBe(false);
    expect(chats.get(id)!.sessions[a].cursor).toBe(chats.lastSeq(id));
  });

  it('多人选人含 current 时也补入当前轮，保留原智能队列及标记', async () => {
    select.mockResolvedValueOnce({ ids: [b, a] });
    await group.send(id, 'q');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    select.mockResolvedValueOnce({ ids: [b, a] });
    deliver.mockResolvedValueOnce({ ok: true, conversationId: b, steered: true });
    await group.send(id, '换个问题');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
    expect(select.mock.calls[1][0].message).toBe('换个问题');
    expect(deliver.mock.calls.map((c) => c[1])).toEqual([b, b, a]);
    expect(group.state(id)).toMatchObject({ current: b, queue: [a], pendingHuman: false });
    await done(a, 'parallel', true, deliver.mock.calls[2][3].deliveryId);
    await done(b, 'answer');
    expect(entries().at(-1)).toMatchObject({ botId: b, routedBy: 'smart' });
    expect(deliver.mock.calls.map((c) => c[1])).toEqual([b, b, a, a]);
    expect(group.state(id)).toMatchObject({ current: a, queue: [] });
  });

  it('build：投递附「先动手」指令（只附一次），发言标 smart:build', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'build' });
    await group.send(id, '把 README 标题改成 X');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(b);
    expect(deliver.mock.calls[0][2]).toContain('这是执行类请求：先动手完成，再简要汇报');
    await done(b, '@Alice 改好了');
    expect(entries().at(-1)).toMatchObject({ kind: 'bot', botId: b, routedBy: 'smart:build' });
    expect(deliver.mock.calls[1][1]).toBe(a);
    expect(deliver.mock.calls[1][2]).not.toContain('先动手完成');
  });

  it('discuss 多人发言均标 smart:discuss', async () => {
    select.mockResolvedValueOnce({ ids: [b, a], intent: 'discuss' });
    await group.send(id, '大家讨论下方案');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][2]).not.toContain('先动手完成');
    await done(b, 'x');
    await done(a, 'y');
    expect(entries().filter((e) => e.kind === 'bot')).toMatchObject([
      { botId: b, routedBy: 'smart:discuss' },
      { botId: a, routedBy: 'smart:discuss' },
    ]);
    // 讨论模式开关缺省关闭：判为 discuss 也只按名单说完，不判断下一位
    expect(next).not.toHaveBeenCalled();
  });

  it('build 无写能力成员：交给群主并写系统说明，不附指令', async () => {
    select.mockResolvedValueOnce({ ids: [], intent: 'build', noWriter: true });
    await group.send(id, '改一下配置');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(a);
    expect(deliver.mock.calls[0][2]).not.toContain('先动手完成');
    expect(entries().find((e) => e.kind === 'system')).toMatchObject({
      text: expect.stringContaining('没有能改代码或执行命令的成员'),
    });
  });

  describe.each([
    ['关', false],
    ['开', true],
  ] as const)(
    'judge 名单首位是群主且意图是 build（真实 createSmartRouter，讨论模式%s）',
    (_label, discussOn) => {
      const judge = vi.fn<SmartRouterDeps['judge']>();
      const systems = () =>
        entries()
          .filter((e) => e.kind === 'system')
          .map((e) => e.text);
      const setup = (ownerTools: 'all' | 'readonly') => {
        const updated = bots.update(a, { tools: ownerTools }, []);
        if (!updated.ok) throw new Error('fixture');
        judge.mockReset();
        group.dispose();
        group = new GroupChatService({
          bots,
          chats,
          host,
          emit,
          responder: createSmartRouter({
            settings: () => ({}),
            judge,
            classify: vi.fn<SmartRouterDeps['classify']>(async () => null),
          }),
          discussEnabled: () => discussOn,
        });
      };
      /** 串行：空闲时选人；旁路：主轮进行中选人，走并行投递 */
      const sendBuild = async (path: '串行' | '旁路', reply: string) => {
        if (path === '旁路') await group.send(id, '@Alice @Bob start');
        const before = deliver.mock.calls.length;
        judge.mockResolvedValueOnce(reply);
        await group.send(id, '把 README 标题改成 X');
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(before + 1));
        expect(judge).toHaveBeenCalledTimes(1);
        return deliver.mock.calls[before];
      };
      const cases = [
        ['串行', 'INTENT: build\nBOSS'],
        ['串行', 'INTENT: build\nAlice\nBob'],
        ['旁路', 'INTENT: build\nBOSS'],
        ['旁路', 'INTENT: build\nAlice\nBob'],
      ] as const;

      it('只读群主优先不进入讨论，回复不标 smart', async () => {
        setup('readonly');
        const call = await sendBuild('串行', 'INTENT: build\nAlice, Bob');
        expect(call[1]).toBe(a);
        expect(call[2]).not.toContain(SMART_ROUTE_BUILD_NOTE);
        await done(a, '交给我安排');
        expect(group.state(id)).toMatchObject({ current: null, queue: [] });
        expect(judge).toHaveBeenCalledTimes(1);
        expect(entries().at(-1)).toMatchObject({ kind: 'bot', botId: a });
        expect(entries().at(-1)).not.toHaveProperty('routedBy');
      });

      it('群主不能被静音：存储归一化剔除群主静音项，能执行时仍附执行提示', async () => {
        setup('all');
        chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, muted: [a] } }));
        expect(chats.get(id)?.routing.muted ?? []).not.toContain(a);
        const call = await sendBuild('串行', 'INTENT: build\nBOSS');
        expect(call[1]).toBe(a);
        expect(call[2]).toContain(SMART_ROUTE_BUILD_NOTE);
      });

      it.each(cases)(
        '群主只读（%s，judge 回 %j）：投递给群主，不附执行提示、不提示选人不可用',
        async (path, reply) => {
          setup('readonly');
          const call = await sendBuild(path, reply);
          expect(call[1]).toBe(a);
          expect(call[2]).not.toContain(SMART_ROUTE_BUILD_NOTE);
          // 不改派给能动手的 Bob（旁路时 Bob 只在主轮排队，尚未投递）
          expect(deliver.mock.calls.some((c) => c[1] === b)).toBe(false);
          expect(systems().filter((text) => text.includes('智能选人不可用'))).toEqual([]);
        }
      );

      it.each(cases)(
        '群主能执行（%s，judge 回 %j）：投递给群主并附执行提示',
        async (path, reply) => {
          setup('all');
          const call = await sendBuild(path, reply);
          expect(call[1]).toBe(a);
          expect(call[2]).toContain(SMART_ROUTE_BUILD_NOTE);
          expect(systems().filter((text) => text.includes('智能选人不可用'))).toEqual([]);
        }
      );
    }
  );

  it('静音成员：不进候选、智能名单与群主兜底都跳过，只在点名 @ 时回复', async () => {
    const carol = bots.create({ name: 'Carol' }, []);
    if (!carol.ok) throw new Error('fixture');
    const c = carol.bot.id;
    chats.update(id, (chat) => ({
      ...chat,
      members: [a, b, c],
      routing: { ...chat.routing, muted: [b] },
    }));
    select.mockResolvedValueOnce({ ids: [b] });
    await group.send(id, 'hello');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(select.mock.calls[0][0].candidates.map((m) => m.id)).toEqual([a, c]);
    expect(deliver.mock.calls[0][1]).toBe(a);
    await done(a, 'ok');
    await group.send(id, '@所有人 报个到');
    expect(group.state(id)).toMatchObject({ current: a, queue: [c] });
    await done(a, 'a');
    await done(c, 'c');
    await group.send(id, '@Bob 你来');
    expect(deliver.mock.calls.at(-1)?.[1]).toBe(b);
    await done(b, 'b');
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, muted: [b, c] } }));
    await group.send(id, 'anyone');
    expect(select).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls.at(-1)?.[1]).toBe(a);
  });
});

describe('群主派单后的汇总提醒', () => {
  let c: string;
  const routerFile = () =>
    JSON.parse(readFileSync(join(dirname(chats.workspaceDir(id)), 'router.json'), 'utf8'));
  const to = () => deliver.mock.calls.map((call) => call[1]);
  beforeEach(() => {
    const carol = bots.create({ name: 'Carol' }, []);
    if (!carol.ok) throw new Error('fixture');
    c = carol.bot.id;
    chats.update(id, (chat) => ({ ...chat, members: [a, b, c] }));
  });

  it('派出的成员都回复后提醒群主汇总一次，汇总发言带 routedBy: summary', async () => {
    await group.send(id, '出方案');
    await done(a, '@Bob @Carol 各给一个方案');
    expect(routerFile().state.waiting).toEqual([b, c]);
    await done(b, 'B 方案');
    await done(c, 'C 方案');
    expect(to()).toEqual([a, b, c, a]);
    const seqOf = (botId: string) =>
      entries().find((e) => e.kind === 'bot' && e.botId === botId && e.text.endsWith('方案'))!.seq;
    const note = String(deliver.mock.calls[3][2]);
    expect(note).toContain('<routing-note>');
    expect(note).toContain(`seq ${seqOf(b)}`);
    expect(note).toContain(`seq ${seqOf(c)}`);
    expect(entries().filter((e) => e.kind === 'human')).toHaveLength(1);
    await done(a, '结论：用 B');
    expect(entries().at(-1)).toMatchObject({ kind: 'bot', botId: a, routedBy: 'summary' });
    expect(entries().filter((e) => e.kind === 'bot' && e.routedBy)).toHaveLength(1);
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    expect(to()).toHaveLength(4);
    expect(routerFile().state.waiting).toBeUndefined();
  });

  it('无 @ 插话不清派单名单，原轮仍汇总', async () => {
    await group.send(id, '出方案');
    await done(a, '@Bob @Carol 各给一个方案');
    await group.send(id, '换个话题');
    expect(to()).toEqual([a, b, a]);
    const parallelId = deliver.mock.calls[2][3].deliveryId;
    await done(a, '好', true, parallelId);
    await done(b, 'B 方案');
    expect(to()).toEqual([a, b, a, c]);
    await done(c, 'C 方案');
    expect(to()).toEqual([a, b, a, c, a]);
    expect(deliver.mock.calls[4][2]).toContain('routing-note');
    await done(a, '汇总');
    expect(group.state(id)).toMatchObject({ current: null });
  });

  it('接力到上限时不提醒，写一条 system', async () => {
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, maxHops: 2 } }));
    await group.send(id, '出方案');
    await done(a, '@Bob @Carol 各给一个方案');
    await done(b, 'B');
    await done(c, 'C');
    expect(to()).toEqual([a, b, c]);
    expect(entries().at(-1)).toMatchObject({
      kind: 'system',
      text: expect.stringContaining('汇总'),
    });
  });
});

describe('压缩后补群状态', () => {
  const text = (call: number) => String(deliver.mock.calls[call][2]);
  const withState = () =>
    new GroupChatService({
      bots,
      chats,
      host,
      emit,
      groupState: () => ({
        delegations: [{ from: a, to: b, state: 'running', task: '写登录页' }],
        tasks: [{ seq: 1, title: '部署', status: 'todo' }],
      }),
    });

  it('压缩后的下一次投递在增量前带 <group-state>，且只带一次', async () => {
    group = withState();
    await group.send(id, 'first');
    await done(a, 'ok');
    expect(text(0)).not.toContain('<group-state>');
    group.markCompacted(id, a, a);
    await group.send(id, 'second');
    expect(text(1).startsWith('<group-state>')).toBe(true);
    expect(text(1)).toContain('写登录页');
    expect(text(1)).toContain('#1 部署');
    expect(text(1)).toContain('second');
    await done(a, 'ok');
    await group.send(id, 'third');
    expect(text(2)).not.toContain('<group-state>');
  });

  it('未压缩不带；会话不匹配 / 私聊的标记被忽略', async () => {
    group = withState();
    await group.send(id, 'first');
    await done(a, 'ok');
    group.markCompacted(id, a, 'stale-conversation');
    group.markCompacted(id, b, a);
    await group.send(id, 'second');
    expect(text(1)).not.toContain('<group-state>');
  });

  it('投递失败不清标记，下次成功投递仍带上', async () => {
    group = withState();
    await group.send(id, 'first');
    await done(a, 'ok');
    group.markCompacted(id, a, a);
    deliver.mockResolvedValueOnce({ ok: false, error: 'offline' });
    await group.send(id, 'second');
    expect(text(1)).toContain('<group-state>');
    await group.send(id, '@Alice third');
    expect(text(2)).toContain('<group-state>');
    await done(a, 'ok');
    await group.send(id, 'fourth');
    expect(text(3)).not.toContain('<group-state>');
  });

  it('删群 / 会话退役 / 删成员时清标记', async () => {
    group = withState();
    await group.send(id, 'first');
    await done(a, 'ok');
    group.markCompacted(id, a, a);
    group.clearCompacted({ conversationId: a });
    await group.send(id, 'x');
    expect(text(1)).not.toContain('<group-state>');
    await done(a, 'ok');
    group.markCompacted(id, a, a);
    group.clearCompacted({ botId: a });
    await group.send(id, 'y');
    expect(text(2)).not.toContain('<group-state>');
    await done(a, 'ok');
    group.markCompacted(id, a, a);
    group.discard(id);
    await group.send(id, 'z');
    expect(text(3)).not.toContain('<group-state>');
  });

  it('标记只在内存：服务重建（重启）后丢失，不会补发', async () => {
    group = withState();
    await group.send(id, 'first');
    await done(a, 'ok');
    group.markCompacted(id, a, a);
    group.dispose();
    group = withState();
    await group.send(id, 'second');
    expect(text(1)).not.toContain('<group-state>');
  });
});

describe('输入框引用', () => {
  it('人类条目只存引用标识；投递时按被投递成员附加展开内容', async () => {
    const refsAppendix = vi.fn(
      async (_chat: unknown, botId: string, list: readonly { kind: string }[]) =>
        list.some((entry) => entry.kind === 'human') ? `<appendix for="${botId}"/>` : ''
    );
    group.dispose();
    group = new GroupChatService({ bots, chats, host, emit, refsAppendix });
    await group.send(id, '@Alice 看看', { deliveryId: 'd1' }, { chats: [id], skill: 's1' });
    const human = entries().find((entry) => entry.kind === 'human');
    expect(human).toMatchObject({ refs: { chats: [id], skill: 's1' } });
    expect(deliver.mock.calls[0][2]).toContain(`<appendix for="${a}"/>`);
    expect(refsAppendix.mock.calls[0][1]).toBe(a);
  });
});

it('reports one settled batch per relay round with every participant, skipping [skip] replies', async () => {
  const batches: unknown[] = [];
  group = new GroupChatService({
    bots,
    chats,
    host,
    emit,
    onBatchSettled: (batch) => batches.push(batch),
  });
  await group.send(id, '@Bob @Alice hello');
  await done(b, 'from bob');
  expect(batches).toEqual([]);
  await done(a, '[skip]');
  expect(batches).toEqual([
    { chatId: id, botIds: [b], failed: [], lastBotId: b, lastText: 'from bob' },
  ]);
  await group.send(id, '@Bob ping');
  await done(b, 'boom', false);
  expect(batches.at(-1)).toEqual({ chatId: id, botIds: [], failed: [b] });
  await group.send(id, '@Alice stop me');
  await group.stop(id);
  expect(batches).toHaveLength(2);
});

it('a member reply run on its own (delegation result, routine) also catches up on the group', async () => {
  await group.send(id, 'hello');
  await done(a, '@Bob please build #5');
  await done(b, '#5 is done');
  await done(a, 'great');
  await group.send(id, '@Bob anything else?');
  await done(b, 'nothing');
  expect(group.state(id)).toMatchObject({ current: null });
  deliver.mockClear();
  const cursor = chats.get(id)!.sessions[a].cursor;
  const result = '<delegation-result id="d1" from="Bob" status="completed">ok</delegation-result>';
  expect(await group.runAs(id, a, result, undefined, { deliveryId: 'd1' })).toMatchObject({
    ok: true,
  });
  const text = deliver.mock.calls[0][2] as string;
  expect(text.startsWith(result)).toBe(true);
  expect(text).toContain('anything else?');
  expect(text).toContain('nothing');
  expect(text).not.toContain('#5 is done');
  expect(chats.get(id)!.sessions[a].cursor).toBeGreaterThan(cursor);
  expect(chats.get(id)!.sessions[a].cursor).toBe(chats.lastSeq(id));
});

describe('讨论模式', () => {
  let c: string;
  const select =
    vi.fn<(input: SmartRouteInput, signal: AbortSignal) => Promise<SmartRouteDecision>>();
  const next =
    vi.fn<(input: DiscussNextInput, signal: AbortSignal) => Promise<DiscussNextDecision>>();
  const settledBatch = vi.fn();
  let delegated: string[] = [];
  let timeoutMs = 1000;
  /** 讨论模式开关：现有讨论用例按打开跑；「讨论模式开关关闭」一组改为关闭 */
  let discussOn = true;
  /** 输入框引用展开：投递拼增量时 await 它，用来模拟投递准备期间开关被关掉 */
  let appendix: ConstructorParameters<typeof GroupChatService>[0]['refsAppendix'];
  const wrapNote = '请你作为群主收尾';
  const to = () => deliver.mock.calls.map((call) => call[1]);
  const systems = () =>
    entries()
      .filter((e) => e.kind === 'system')
      .map((e) => e.text);
  const make = () => {
    group.dispose();
    group = new GroupChatService({
      bots,
      chats,
      host,
      emit,
      onBatchSettled: settledBatch,
      delegatedTargets: () => delegated,
      responder: { timeoutMs: () => timeoutMs, select, next },
      discussEnabled: () => discussOn,
      ...(appendix ? { refsAppendix: appendix } : {}),
    });
  };
  const finishTurn = async (botId: string, text: string, ok = true) => {
    finish({
      chatId: id,
      botId,
      conversationId: botId,
      turnId: String(entries().length),
      turnKey: `k-${entries().length}`,
      text,
      ok,
      ...(ok ? {} : { error: 'broken' }),
    });
    await group.settled(id);
  };
  const deferredNext = () => {
    let resolve!: (value: DiscussNextDecision) => void;
    const promise = new Promise<DiscussNextDecision>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  beforeEach(() => {
    const carol = bots.create({ name: 'Carol' }, []);
    if (!carol.ok) throw new Error('fixture');
    c = carol.bot.id;
    chats.update(id, (chat) => ({ ...chat, members: [a, b, c] }));
    select.mockReset();
    next.mockReset().mockResolvedValue({ end: true });
    settledBatch.mockReset();
    delegated = [];
    timeoutMs = 1000;
    discussOn = true;
    appendix = undefined;
    make();
  });
  /** b、c 各说一句，判断 END（默认）：交给群主 a 收尾，收尾已投递 */
  const toWrapUp = async () => {
    select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await finishTurn(b, 'B');
    await finishTurn(c, 'C');
    await vi.waitFor(() => expect(to()).toEqual([b, c, a]));
    await group.settled(id);
  };

  it('END 且有 2 条发言：群主收尾，附收尾附注、标 wrap-up、不带讨论附注；批次在收尾后只结算一次', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论下方案');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][2]).toContain('在本回合内直接完成，不要委派');
    next.mockResolvedValueOnce({ next: c });
    await finishTurn(b, '我建议先做 A');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(to()).toEqual([b, c]);
    const judged = next.mock.calls[0][0];
    expect(judged.candidates.map((m) => m.id)).toEqual([a, c]);
    expect(judged.candidates.find((m) => m.id === a)?.owner).toBe(true);
    expect(judged.progress).toEqual({ used: 1, max: 50 });
    expect(judged.topic).toBe('讨论下方案');
    expect(judged.lastSpeaker).toBe('Bob');
    expect(deliver.mock.calls[1][2]).toContain('我建议先做 A');
    expect(deliver.mock.calls[1][2]).toContain('没有新内容就回 [skip]');
    expect(group.state(id)).toMatchObject({ current: c, hops: 0, discuss: { turns: 2, max: 50 } });
    await finishTurn(c, '同意');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
    expect(next.mock.calls[1][0].candidates.map((m) => m.id)).toEqual([a, b]);
    expect(to()).toEqual([b, c, a]);
    const wrap = String(deliver.mock.calls[2][2]);
    expect(wrap).toContain(wrapNote);
    expect(wrap).toContain('判断认为讨论已有结论');
    expect(wrap).not.toContain(DISCUSS_NOTE);
    expect(wrap).not.toContain('已经写过的不要重复');
    expect(systems()).toEqual([]);
    expect(group.state(id)).toMatchObject({ current: a, routing: false, wrapUp: true });
    expect(group.state(id)).not.toHaveProperty('discuss');
    expect(settledBatch).not.toHaveBeenCalled();
    await finishTurn(a, '结论：先做 A');
    expect(entries().filter((e) => e.kind === 'bot')).toMatchObject([
      { botId: b, routedBy: 'smart:discuss' },
      { botId: c, routedBy: 'smart:discuss' },
      { botId: a, routedBy: 'wrap-up' },
    ]);
    expect(next).toHaveBeenCalledTimes(2);
    expect(to()).toEqual([b, c, a]);
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
    expect(group.state(id)).not.toHaveProperty('wrapUp');
    expect(settledBatch).toHaveBeenCalledTimes(1);
    expect(settledBatch.mock.calls[0][0]).toMatchObject({
      botIds: [b, c, a],
      lastBotId: a,
      lastText: '结论：先做 A',
    });
  });

  it('判断期间 routing 为 true，批次不提前结算，例行任务等讨论结束才跑', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论下方案');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const pending = deferredNext();
    next.mockReturnValueOnce(pending.promise);
    await finishTurn(b, '观点');
    expect(group.state(id)).toMatchObject({ routing: true, current: null });
    expect(settledBatch).not.toHaveBeenCalled();
    const job = group.runAs(id, a, 'routine', '日报');
    await group.settled(id);
    expect(deliver).toHaveBeenCalledTimes(1);
    pending.resolve({ end: true });
    await job;
    await group.settled(id);
    expect(to()).toEqual([b, a]);
    expect(deliver.mock.calls[1][2]).toContain('routine');
  });

  it('判断超时、失败、无法识别：结束并在群里提示，不交给群主', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    timeoutMs = 20;
    make();
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, 'q1');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    next.mockImplementationOnce(() => new Promise(() => {}));
    await finishTurn(b, 'x');
    await vi.waitFor(() => expect(systems()).toContain('讨论判断不可用（判断超时），讨论结束'));
    expect(to()).toEqual([b]);
    timeoutMs = 1000;
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, 'q2');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    next.mockResolvedValueOnce({ failure: '判断结果无法识别' });
    await finishTurn(b, 'y');
    await vi.waitFor(() =>
      expect(systems()).toContain('讨论判断不可用（判断结果无法识别），讨论结束')
    );
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, 'q3');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
    next.mockRejectedValueOnce(new Error('模型 x：鉴权失败'));
    await finishTurn(b, 'z');
    await vi.waitFor(() =>
      expect(systems()).toContain('讨论判断不可用（模型 x：鉴权失败），讨论结束')
    );
    expect(to()).toEqual([b, b, b]);
    warn.mockRestore();
  });

  it('讨论不受 maxHops=1 / maxTurnsPerBot=1 限制：继续由判断决定，判 END 后由群主收尾', async () => {
    chats.update(id, (chat) => ({
      ...chat,
      routing: { ...chat.routing, maxHops: 1, maxTurnsPerBot: 1 },
    }));
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    next.mockResolvedValueOnce({ next: c }).mockResolvedValueOnce({ next: b });
    await finishTurn(b, 'x');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    await finishTurn(c, 'y');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
    expect(to()).toEqual([b, c, b]);
    await finishTurn(b, 'z');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(4));
    expect(next).toHaveBeenCalledTimes(3);
    expect(to()).toEqual([b, c, b, a]);
    expect(String(deliver.mock.calls[3][2])).toContain(wrapNote);
    expect(systems().filter((text) => text.includes('上限'))).toEqual([]);
  });

  it.each(['judge', 'pi-classifier'] as const)(
    '%s 后端不响应：群层超时取消请求，晚到结果不能再开启下一位',
    async (source) => {
      let complete!: (value: never) => void;
      const pending = new Promise<never>((resolve) => {
        complete = resolve;
      });
      const judge = vi.fn(() => pending);
      const classify = vi.fn(() => pending);
      const responder = createSmartRouter({
        settings: () => ({
          botRouteClassifier: {
            source,
            model: { providerId: 'p', modelId: 'm' },
            timeoutMs: 20,
          },
        }),
        judge,
        classify,
      });
      group.dispose();
      group = new GroupChatService({
        bots,
        chats,
        host,
        emit,
        responder,
        discussEnabled: () => true,
      });
      // 显式全员绕过初始选人，只测真实 next 后端的超时与取消。
      await group.send(id, '@所有人 讨论方案');
      await finishTurn(a, 'A');
      await finishTurn(b, 'B');
      await finishTurn(c, 'C');
      // 已有 3 条有效发言：判断不可用时先提示，再交给群主收尾
      await vi.waitFor(() =>
        expect(systems()).toContain('讨论判断不可用（判断超时），交给群主「Alice」收尾。')
      );
      const backend = source === 'judge' ? judge : classify;
      expect(backend).toHaveBeenCalledTimes(1);
      const call = backend.mock.calls[0] as unknown as unknown[];
      expect((call.at(-1) as AbortSignal).aborted).toBe(true);
      complete((source === 'judge' ? 'NEXT: Alice' : { [a]: 1 }) as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await group.settled(id);
      expect(to()).toEqual([a, b, c, a]);
      expect(String(deliver.mock.calls[3][2])).toContain(wrapNote);
      expect(group.state(id)).toMatchObject({ current: a, wrapUp: true, routing: false });
      group.dispose();
    }
  );

  it('回复里的 @ 优先，不判断', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await finishTurn(b, '@Carol 你怎么看');
    expect(to()).toEqual([b, c]);
    expect(next).not.toHaveBeenCalled();
  });

  it('讨论中本回合发起了委派：讨论就此结束，不判断', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    delegated = [c];
    await finishTurn(b, '我让 Carol 去查一下');
    expect(next).not.toHaveBeenCalled();
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
    expect(systems()).toEqual([]);
    // 委派结束讨论：不收尾
    expect(to()).toEqual([b]);
  });

  it('讨论中全员 [skip]：直接结束，不交给群主兜底', async () => {
    select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await finishTurn(b, '[skip]');
    await finishTurn(c, '[skip]');
    expect(to()).toEqual([b, c]);
    expect(next).not.toHaveBeenCalled();
    expect(systems()).toEqual(['「Bob」「Carol」已跳过，本轮无人回复。']);
    // 全员 [skip]：不收尾
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
  });

  it('讨论中首位发起委派后立即结束，不继续投递原有候选队列', async () => {
    select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    delegated = [a];
    await finishTurn(b, '已委派 Alice 查证');
    expect(to()).toEqual([b]);
    expect(next).not.toHaveBeenCalled();
    expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
  });

  it('成员失败只当没开口，讨论继续由判断决定', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    next.mockResolvedValueOnce({ next: a });
    await finishTurn(b, '', false);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(to()).toEqual([b, a]);
  });

  it('answer / build 不进入讨论', async () => {
    for (const intent of ['answer', 'build'] as const) {
      select.mockResolvedValueOnce({ ids: [b], intent });
      await group.send(id, `q-${intent}`);
      await vi.waitFor(() => expect(to().at(-1)).toBe(b));
      await finishTurn(b, 'done');
    }
    expect(next).not.toHaveBeenCalled();
  });

  it('smart 模式 @所有人 与「大家」进入讨论；boss 模式 @所有人 不判断', async () => {
    await group.send(id, '@所有人 说说看法');
    await finishTurn(a, 'a');
    await finishTurn(b, 'b');
    await finishTurn(c, 'c');
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    // 3 条有效发言、判 END：交给群主收尾，收尾说完这一轮才结束
    await vi.waitFor(() => expect(to()).toEqual([a, b, c, a]));
    await finishTurn(a, '收尾 1');
    select.mockResolvedValueOnce({ ids: [a, b, c], everyone: true });
    await group.send(id, '大家说说');
    await vi.waitFor(() => expect(to().length).toBe(5));
    await finishTurn(a, 'a2');
    await finishTurn(b, 'b2');
    await finishTurn(c, 'c2');
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(to().length).toBe(8));
    await finishTurn(a, '收尾 2');
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, mode: 'boss' } }));
    await group.send(id, '@所有人 再说一次');
    await finishTurn(a, 'a3');
    await finishTurn(b, 'b3');
    await finishTurn(c, 'c3');
    expect(next).toHaveBeenCalledTimes(2);
    expect(to()).toEqual([a, b, c, a, a, b, c, a, a, b, c]);
  });

  it('判断进行中来了人类消息：取消判断，按新消息重开一轮', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const pending = deferredNext();
    next.mockReturnValueOnce(pending.promise);
    await finishTurn(b, 'x');
    select.mockResolvedValueOnce({ ids: [c], intent: 'answer' });
    await group.send(id, '先回答我一个问题');
    expect(next.mock.calls[0][1].aborted).toBe(true);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(select.mock.calls[1][0].message).toBe('先回答我一个问题');
    pending.resolve({ next: a });
    await group.settled(id);
    expect(to()).toEqual([b, c]);
    expect(group.state(id)).toMatchObject({ current: c, hops: 0 });
  });

  it('Grok 式重开：有人正在说话时来了没 @ 的消息，等他说完放弃剩下的讨论，按新消息重开', async () => {
    select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await group.send(id, '换个话题：午饭吃什么');
    expect(select).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(group.state(id)).toMatchObject({ current: b, pendingHuman: true });
    select.mockResolvedValueOnce({ ids: [a], intent: 'answer' });
    await finishTurn(b, '我说完了');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(select.mock.calls[1][0].message).toBe('换个话题：午饭吃什么');
    expect(to()).toEqual([b, a]);
    expect(next).not.toHaveBeenCalled();
    expect(group.state(id)).toMatchObject({
      current: a,
      queue: [],
      hops: 0,
      turnsByBot: { [a]: 1 },
    });
    // 按新消息重开：被放弃的讨论不收尾
    expect(group.state(id)).not.toHaveProperty('wrapUp');
  });

  it('停止取消进行中的判断', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const pending = deferredNext();
    next.mockReturnValueOnce(pending.promise);
    await finishTurn(b, 'x');
    expect(await group.stop(id)).toEqual({ ok: true });
    expect(next.mock.calls[0][1].aborted).toBe(true);
    pending.resolve({ next: a });
    await group.settled(id);
    expect(to()).toEqual([b]);
    expect(group.state(id)).toMatchObject({ routing: false });
  });

  it('dispose 取消讨论判断，迟到结果不能重新投递或写时间线', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const pending = deferredNext();
    next.mockReturnValueOnce(pending.promise);
    await finishTurn(b, '观点');
    const before = entries();
    group.dispose();
    expect(next.mock.calls[0][1].aborted).toBe(true);
    pending.resolve({ next: c });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await group.settled(id);
    expect(to()).toEqual([b]);
    expect(entries()).toEqual(before);
  });

  it('讨论成员委派后回 skip 也必须结束，不能重新交给群主兜底', async () => {
    select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    delegated = [c];
    await finishTurn(b, '[skip]');
    expect(to()).toEqual([b]);
    expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
    expect(next).not.toHaveBeenCalled();
  });

  it('讨论期间并行发言者发起委派也要结束讨论，不再投递剩余候选', async () => {
    select.mockResolvedValueOnce({ ids: [b, a], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await group.send(id, '@Carol 帮忙查一下');
    const deliveryId = deliver.mock.calls[1][3].deliveryId;
    delegated = [a];
    finish({
      chatId: id,
      botId: c,
      conversationId: c,
      deliveryId,
      turnId: 'parallel-delegate',
      turnKey: 'parallel-key',
      text: '已委派查证',
      ok: true,
    });
    await group.settled(id);
    delegated = [];
    await finishTurn(b, '当前发言结束');
    expect(to()).toEqual([b, c]);
    expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
    expect(next).not.toHaveBeenCalled();
  });

  it('判断期间其他成员全部不可用：结束并提示没人可选', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const pending = deferredNext();
    next.mockReturnValueOnce(pending.promise);
    await finishTurn(b, '观点');
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, muted: [c] } }));
    bots.setArchived(a, true);
    pending.resolve({ next: c });
    await vi.waitFor(() => expect(group.state(id)).toMatchObject({ routing: false }));
    expect(to()).toEqual([b]);
    expect(systems()).toContain('没有其他可接话的成员，讨论结束。');
  });

  it('判断期间选中的人被静音但还有别人可选：按当前名单重新判断，不静默结束', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const pending = deferredNext();
    next.mockReturnValueOnce(pending.promise);
    await finishTurn(b, '观点');
    expect(next.mock.calls[0][0].candidates.map((m) => m.id)).toEqual([a, c]);
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, muted: [c] } }));
    next.mockResolvedValueOnce({ next: a });
    pending.resolve({ next: c });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls[1][0].candidates.map((m) => m.id)).toEqual([a]);
    expect(to()).toEqual([b, a]);
    expect(group.state(id)).toMatchObject({ current: a, hops: 0, discuss: { turns: 2, max: 50 } });
  });

  it('判断选中的人在投递附录等待期间被静音：不投递给 TA，按当前名单重新判断', async () => {
    let gate = false;
    let ready!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const waiting = new Promise<string>((resolve) => {
      resume = () => resolve('');
    });
    appendix = async (_chat, botId) => {
      if (!gate || botId !== c) return '';
      ready();
      return waiting;
    };
    make();
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    gate = true;
    next.mockResolvedValueOnce({ next: c }).mockResolvedValueOnce({ next: a });
    const finishing = finishTurn(b, '观点');
    await entered;
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, muted: [c] } }));
    resume();
    await finishing;
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    await group.settled(id);
    expect(to()).toEqual([b, a]);
    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls[1][0].candidates.map((m) => m.id)).toEqual([a]);
    expect(systems()).toEqual([]);
    expect(group.state(id)).toMatchObject({ current: a, hops: 0, discuss: { turns: 2, max: 50 } });
  });

  it('讨论中成功但空白的回复按 [skip]：不写正文、不算有效发言，不判断、不收尾', async () => {
    select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await finishTurn(b, '');
    await finishTurn(c, '   ');
    await group.settled(id);
    expect(to()).toEqual([b, c]);
    expect(next).not.toHaveBeenCalled();
    expect(entries().filter((e) => e.kind === 'bot')).toEqual([]);
    expect(systems()).toEqual(['「Bob」「Carol」已跳过，本轮无人回复。']);
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
    expect(group.state(id)).not.toHaveProperty('wrapUp');
    expect(settledBatch).not.toHaveBeenCalled();
  });

  it('讨论中一条有效发言后空白回复：不算第 2 条有效发言，不交群主收尾', async () => {
    select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await finishTurn(b, 'B');
    await finishTurn(c, '');
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(group.state(id)).toMatchObject({ routing: false }));
    await group.settled(id);
    expect(next.mock.calls[0][0].candidates.map((m) => m.id)).toEqual([a]);
    expect(to()).toEqual([b, c]);
    expect(entries().filter((e) => e.kind === 'bot')).toMatchObject([{ botId: b, text: 'B' }]);
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
    expect(group.state(id)).not.toHaveProperty('wrapUp');
  });

  it('群主收尾时成功但空白：不写收尾条目，提示未给出收尾', async () => {
    await toWrapUp();
    await finishTurn(a, '  ');
    expect(entries().filter((e) => e.kind === 'bot')).toMatchObject([
      { botId: b, text: 'B' },
      { botId: c, text: 'C' },
    ]);
    expect(systems()).toEqual(['群主「Alice」未给出收尾。']);
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
    expect(settledBatch).toHaveBeenCalledTimes(1);
  });

  it('判断返回名单外的成员：按判断结果无法识别结束并提示', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    next.mockResolvedValueOnce({ next: 'ghost' });
    await finishTurn(b, '观点');
    await vi.waitFor(() =>
      expect(systems()).toContain('讨论判断不可用（判断结果无法识别），讨论结束')
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(to()).toEqual([b]);
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
  });

  it('判断返回本次名单外、但等待期间变为可选的成员：仍按无法识别结束，不投递', async () => {
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, muted: [c] } }));
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const pending = deferredNext();
    next.mockReturnValueOnce(pending.promise);
    await finishTurn(b, '观点');
    expect(next.mock.calls[0][0].candidates.map((m) => m.id)).toEqual([a]);
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, muted: [] } }));
    pending.resolve({ next: c });
    await vi.waitFor(() => expect(group.state(id)).toMatchObject({ routing: false }));
    expect(to()).toEqual([b]);
    expect(next).toHaveBeenCalledTimes(1);
    expect(systems()).toContain('讨论判断不可用（判断结果无法识别），讨论结束');
    expect(group.state(id)).toMatchObject({ current: null });
  });

  it('找不到开场的人类消息：不调用判断，提示后结束', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    // 模拟时间线损坏 / 被外部截断：读出的时间线里没有开场消息
    const readAfter = chats.readAfter.bind(chats);
    const spy = vi
      .spyOn(chats, 'readAfter')
      .mockImplementation((chatId, afterSeq) =>
        readAfter(chatId, afterSeq).filter((entry) => entry.kind !== 'human')
      );
    await finishTurn(b, '观点');
    spy.mockRestore();
    expect(next).not.toHaveBeenCalled();
    expect(to()).toEqual([b]);
    expect(systems()).toContain('讨论判断不可用（找不到开场消息），讨论结束');
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
  });

  it('判断期间并行成员发起委派：取消判断，迟到结果不再开启下一位', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await group.send(id, '@Carol 帮忙查一下');
    const deliveryId = deliver.mock.calls[1][3].deliveryId;
    const pending = deferredNext();
    next.mockReturnValueOnce(pending.promise);
    await finishTurn(b, '观点');
    expect(group.state(id)).toMatchObject({ routing: true });
    delegated = [a];
    finish({
      chatId: id,
      botId: c,
      conversationId: c,
      deliveryId,
      turnId: 'parallel-delegate',
      turnKey: 'parallel-key',
      text: '已委派查证',
      ok: true,
    });
    await group.settled(id);
    expect(next.mock.calls[0][1].aborted).toBe(true);
    pending.resolve({ next: a });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await group.settled(id);
    expect(to()).toEqual([b, c]);
    expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
  });

  it('判断超时 / 无法识别 / 鉴权失败且已有 2 条发言：先提示交给群主收尾，再投递收尾', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    timeoutMs = 20;
    make();
    const cases = [
      { arm: () => next.mockImplementationOnce(() => new Promise(() => {})), reason: '判断超时' },
      {
        arm: () => next.mockResolvedValueOnce({ failure: '判断结果无法识别' }),
        reason: '判断结果无法识别',
      },
      {
        arm: () => next.mockRejectedValueOnce(new Error('模型 x：鉴权失败')),
        reason: '模型 x：鉴权失败',
      },
    ];
    for (const [i, item] of cases.entries()) {
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, `q${i}`);
      await vi.waitFor(() => expect(to().at(-1)).toBe(b));
      await finishTurn(b, `b${i}`);
      item.arm();
      await finishTurn(c, `c${i}`);
      const notice = `讨论判断不可用（${item.reason}），交给群主「Alice」收尾。`;
      await vi.waitFor(() => expect(systems()).toContain(notice));
      await vi.waitFor(() => expect(to().at(-1)).toBe(a));
      const wrap = String(deliver.mock.calls.at(-1)?.[2]);
      // 提示先写进时间线，群主在收尾的增量里能看到原因
      expect(wrap).toContain(notice);
      expect(wrap).toContain(`讨论判断不可用（${item.reason}），讨论先停在这里`);
      await finishTurn(a, `收尾${i}`);
    }
    expect(to()).toEqual([b, c, a, b, c, a, b, c, a]);
    expect(systems().filter((text) => text.endsWith('讨论结束'))).toEqual([]);
    warn.mockRestore();
  });

  it('END 但只有 1 条有效发言：安静结束，不收尾', async () => {
    select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await finishTurn(b, '观点');
    await finishTurn(c, '[skip]');
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(group.state(id)).toMatchObject({ routing: false }));
    await group.settled(id);
    expect(to()).toEqual([b, c]);
    expect(systems()).toEqual([]);
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
    expect(settledBatch).toHaveBeenCalledTimes(1);
  });

  it('到安全上限（设为 5，[skip] 与失败都计入）：提示后由群主收尾，附注要求写明未达成结论', async () => {
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, discussMaxTurns: 5 } }));
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    next
      .mockResolvedValueOnce({ next: c })
      .mockResolvedValueOnce({ next: a })
      .mockResolvedValueOnce({ next: b })
      .mockResolvedValueOnce({ next: c });
    await finishTurn(b, 'B1');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(group.state(id)).toMatchObject({ current: c, discuss: { turns: 2, max: 5 } });
    // 成员失败也计入上限
    await finishTurn(c, '', false);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
    expect(group.state(id)).toMatchObject({ current: a, discuss: { turns: 3, max: 5 } });
    await finishTurn(a, 'A1');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(4));
    await finishTurn(b, '[skip]');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(5));
    expect(group.state(id)).toMatchObject({ current: c, discuss: { turns: 5, max: 5 } });
    await finishTurn(c, 'C1');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(6));
    expect(next).toHaveBeenCalledTimes(4);
    expect(to()).toEqual([b, c, a, b, c, a]);
    expect(systems()).toContain('本次讨论已达安全上限（5 次成员发言），交给群主「Alice」收尾。');
    const wrap = String(deliver.mock.calls[5][2]);
    expect(wrap).toContain('收尾开头写明「未达成结论」');
    expect(wrap).toContain('安全上限（5 次成员发言）');
    expect(group.state(id)).toMatchObject({ current: a, wrapUp: true });
  });

  it('收尾中人类发来没 @ 的消息：等收尾说完再按新消息重开', async () => {
    await toWrapUp();
    await group.send(id, '还有个问题');
    expect(select).toHaveBeenCalledTimes(1);
    expect(group.state(id)).toMatchObject({ current: a, wrapUp: true, pendingHuman: true });
    select.mockResolvedValueOnce({ ids: [c], intent: 'answer' });
    await finishTurn(a, '收尾');
    await vi.waitFor(() => expect(to()).toEqual([b, c, a, c]));
    expect(select.mock.calls[1][0].message).toBe('还有个问题');
    expect(entries().find((e) => e.kind === 'bot' && e.botId === a)).toMatchObject({
      routedBy: 'wrap-up',
    });
    expect(group.state(id)).toMatchObject({ current: c });
    expect(group.state(id)).not.toHaveProperty('wrapUp');
  });

  it('收尾中只 @ 群主：steer 进收尾这一回合，不另起一轮', async () => {
    await toWrapUp();
    await group.send(id, '@Alice 记得写风险');
    expect(to()).toEqual([b, c, a, a]);
    expect(select).toHaveBeenCalledTimes(1);
    expect(group.state(id)).toMatchObject({ current: a, wrapUp: true, pendingHuman: false });
  });

  it('收尾回复里的 @ 不接力、不再进入讨论，也不再判断', async () => {
    await toWrapUp();
    await finishTurn(a, '结论：做 A。@Bob @Carol 请落实');
    expect(to()).toEqual([b, c, a]);
    expect(next).toHaveBeenCalledTimes(1);
    expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
    expect(systems()).toEqual([]);
    expect(settledBatch).toHaveBeenCalledTimes(1);
  });

  it('收尾回 [skip]：补一条提示，本轮结束', async () => {
    await toWrapUp();
    await finishTurn(a, '[skip]');
    expect(systems()).toEqual(['群主「Alice」未给出收尾。']);
    expect(to()).toEqual([b, c, a]);
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
  });

  it('收尾时委派：结果回群后由群主普通回复（@ 按普通接力），不讨论、不收尾', async () => {
    await toWrapUp();
    delegated = [b];
    await finishTurn(a, '我让 Bob 去落实');
    delegated = [];
    expect(group.state(id)).toMatchObject({ current: null });
    const result = group.runAs(
      id,
      a,
      '<delegation-result id="d1" from="Bob" status="completed">done</delegation-result>',
      undefined,
      {}
    );
    await vi.waitFor(() => expect(to()).toEqual([b, c, a, a]));
    expect(await result).toMatchObject({ ok: true });
    const text = String(deliver.mock.calls[3][2]);
    expect(text).not.toContain(DISCUSS_NOTE);
    expect(text).not.toContain(wrapNote);
    await finishTurn(a, '@Carol 再确认一下');
    expect(to()).toEqual([b, c, a, a, c]);
    expect(String(deliver.mock.calls[4][2])).not.toContain(DISCUSS_NOTE);
    await finishTurn(c, '确认');
    // 普通接力：群主派出的人回复后照 main 规则追加汇总跳
    expect(to()).toEqual([b, c, a, a, c, a]);
    expect(String(deliver.mock.calls[5][2])).toContain('你派出的成员都已回复');
    await finishTurn(a, '汇总');
    expect(next).toHaveBeenCalledTimes(1);
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
    expect(entries().filter((e) => e.kind === 'bot' && e.routedBy === 'wrap-up')).toHaveLength(1);
  });

  it('收尾正常结束后（maxTurnsPerBot=1）：下一条人类消息的新一轮按全新额度，讨论与收尾的发言不占用', async () => {
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, maxTurnsPerBot: 1 } }));
    make();
    await toWrapUp();
    await finishTurn(a, '收尾');
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    await group.send(id, '@Alice 安排一下');
    await vi.waitFor(() => expect(to()).toEqual([b, c, a, a]));
    await finishTurn(a, '@Bob @Carol 请落实');
    expect(to()).toEqual([b, c, a, a, b]);
    await finishTurn(b, '好');
    expect(to()).toEqual([b, c, a, a, b, c]);
    await finishTurn(c, '好');
    // 新一轮里群主已回复过一次：汇总跳按上限拦下
    expect(to()).toEqual([b, c, a, a, b, c]);
    expect(systems()).toEqual(['「Alice」本轮已回复 1 次，达到上限，未再请 TA 汇总。']);
    expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
  });

  it('收尾时委派（maxTurnsPerBot=1）：结果回群后群主的普通回复按全新额度接力', async () => {
    chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, maxTurnsPerBot: 1 } }));
    make();
    await toWrapUp();
    delegated = [b];
    await finishTurn(a, '我让 Bob 去落实');
    delegated = [];
    const result = group.runAs(
      id,
      a,
      '<delegation-result id="d1" from="Bob" status="completed">done</delegation-result>',
      undefined,
      {}
    );
    await vi.waitFor(() => expect(to()).toEqual([b, c, a, a]));
    expect(await result).toMatchObject({ ok: true });
    await finishTurn(a, '@Carol 再确认一下');
    expect(to()).toEqual([b, c, a, a, c]);
    await finishTurn(c, '确认');
    // 群主这次普通回复已占用额度：汇总跳按上限拦下
    expect(to()).toEqual([b, c, a, a, c]);
    expect(systems()).toEqual(['「Alice」本轮已回复 1 次，达到上限，未再请 TA 汇总。']);
    expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
  });

  it('判断点到群主：附裁决提示；群主是讨论最后一位发言人时照样收尾，并提示不要重复', async () => {
    select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][2]).not.toContain(DISCUSS_OWNER_NOTE);
    next.mockResolvedValueOnce({ next: a });
    await finishTurn(b, '方案 B');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(to()).toEqual([b, a]);
    expect(deliver.mock.calls[1][2]).toContain(DISCUSS_NOTE);
    expect(deliver.mock.calls[1][2]).toContain(DISCUSS_OWNER_NOTE);
    await finishTurn(a, '拍板：用 B');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
    expect(to()).toEqual([b, a, a]);
    const wrap = String(deliver.mock.calls[2][2]);
    expect(wrap).toContain(wrapNote);
    expect(wrap).toContain('已经写过的不要重复');
    expect(wrap).not.toContain(DISCUSS_OWNER_NOTE);
  });

  it('群主已归档：讨论有结论也不收尾，提示交给用户', async () => {
    select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await finishTurn(b, 'B');
    bots.setArchived(a, true);
    await finishTurn(c, 'C');
    await vi.waitFor(() =>
      expect(systems()).toContain('讨论已有结论，但群里没有可用的群主，未收尾。')
    );
    await group.settled(id);
    expect(next).toHaveBeenCalledTimes(1);
    expect(to()).toEqual([b, c]);
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
  });

  it('收尾投递失败：沿用投递失败提示，批次随后结算', async () => {
    select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
    await group.send(id, '讨论');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await finishTurn(b, 'B');
    // c 已在 b 说完时投递；下一次投递就是收尾
    deliver.mockResolvedValueOnce({ ok: false, error: 'session-busy' });
    await finishTurn(c, 'C');
    await vi.waitFor(() => expect(systems()).toContain('Alice 暂时无法回复'));
    await group.settled(id);
    expect(to()).toEqual([b, c, a]);
    expect(group.state(id)).toMatchObject({ current: null, routing: false });
    expect(settledBatch).toHaveBeenCalledTimes(1);
    expect(settledBatch.mock.calls[0][0]).toMatchObject({ botIds: [b, c] });
  });

  it('收尾期间例行任务要等收尾结束才跑', async () => {
    await toWrapUp();
    const job = group.runAs(id, b, 'routine', '日报');
    await group.settled(id);
    expect(to()).toEqual([b, c, a]);
    await finishTurn(a, '收尾');
    await job;
    await group.settled(id);
    expect(to()).toEqual([b, c, a, b]);
    expect(deliver.mock.calls[3][2]).toContain('routine');
  });

  it('手动停止收尾：不再投递，批次不报，迟到的收尾结果不落地', async () => {
    await toWrapUp();
    expect(await group.stop(id)).toEqual({ ok: true });
    expect(stopTurn).toHaveBeenCalledWith(id, a);
    await finishTurn(a, '迟到的收尾');
    expect(to()).toEqual([b, c, a]);
    expect(entries().some((e) => e.kind === 'bot' && e.botId === a)).toBe(false);
    expect(group.state(id)).toMatchObject({ current: null });
    expect(group.state(id)).not.toHaveProperty('wrapUp');
    expect(settledBatch).not.toHaveBeenCalled();
  });

  it('讨论中群主 @ 派人：不追加汇总跳，只在讨论结束后收尾一次', async () => {
    select.mockResolvedValueOnce({ ids: [a], intent: 'discuss' });
    await group.send(id, '出方案');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await finishTurn(a, '@Bob @Carol 各给一个方案');
    expect(to()).toEqual([a, b]);
    await finishTurn(b, 'B 方案');
    await finishTurn(c, 'C 方案');
    await vi.waitFor(() => expect(to()).toEqual([a, b, c, a]));
    const texts = deliver.mock.calls.map((call) => String(call[2]));
    expect(texts.filter((text) => text.includes('你派出的成员都已回复'))).toEqual([]);
    expect(texts.filter((text) => text.includes(wrapNote))).toHaveLength(1);
    await finishTurn(a, '结论');
    const routed = entries().flatMap((e) => (e.kind === 'bot' ? [e.routedBy] : []));
    expect(routed).not.toContain('summary');
    expect(routed.filter((value) => value === 'wrap-up')).toHaveLength(1);
    expect(to()).toEqual([a, b, c, a]);
  });

  it('router.json 残留收尾状态：只用于崩溃恢复，重启只提示中断，不重放收尾', async () => {
    await toWrapUp();
    const saved = JSON.parse(
      readFileSync(join(dirname(chats.workspaceDir(id)), 'router.json'), 'utf8')
    );
    expect(saved.state).toMatchObject({ wrapUp: true, current: a });
    group = new GroupChatService({
      bots,
      chats,
      host,
      emit,
      responder: { timeoutMs: () => timeoutMs, select, next },
      discussEnabled: () => discussOn,
    });
    expect(entries().at(-1)).toMatchObject({ kind: 'system', text: '回复被中断' });
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    expect(group.state(id)).not.toHaveProperty('wrapUp');
    await finishTurn(a, '迟到的收尾');
    expect(to()).toEqual([b, c, a]);
    expect(entries().some((e) => e.kind === 'bot' && e.botId === a)).toBe(false);
  });

  describe('讨论模式开关关闭', () => {
    const NOTICE = '讨论模式已关闭，本轮讨论结束';
    const hasDiscussNote = () =>
      deliver.mock.calls.some((call) => String(call[2]).includes(DISCUSS_NOTE));
    beforeEach(() => {
      discussOn = false;
      make();
    });

    it('关闭时 smart 群判为 discuss 不进入讨论：首轮名单说完即结束，不调用 next()，投递不附讨论 note', async () => {
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论下方案');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      await finishTurn(b, '我建议先做 A');
      await finishTurn(c, '同意');
      await group.settled(id);
      expect(to()).toEqual([b, c]);
      expect(next).not.toHaveBeenCalled();
      expect(hasDiscussNote()).toBe(false);
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
      // 历史标签照常写，和 main 一致
      expect(entries().filter((e) => e.kind === 'bot')).toMatchObject([
        { botId: b, routedBy: 'smart:discuss' },
        { botId: c, routedBy: 'smart:discuss' },
      ]);
      expect(systems()).toEqual([]);
      expect(settledBatch).toHaveBeenCalledTimes(1);
    });

    it('关闭时 @所有人 / 「大家」按全员依次回复，不判断下一位', async () => {
      await group.send(id, '@所有人 说说看法');
      await finishTurn(a, 'a');
      await finishTurn(b, 'b');
      await finishTurn(c, 'c');
      select.mockResolvedValueOnce({ ids: [a, b, c], everyone: true });
      await group.send(id, '大家说说');
      await vi.waitFor(() => expect(to().length).toBe(4));
      await finishTurn(a, 'a2');
      await finishTurn(b, 'b2');
      await finishTurn(c, 'c2');
      await group.settled(id);
      expect(to()).toEqual([a, b, c, a, b, c]);
      expect(next).not.toHaveBeenCalled();
      expect(hasDiscussNote()).toBe(false);
      expect(group.state(id)).toMatchObject({ current: null, routing: false });
    });

    it('关闭时有人在说话、来了没 @ 的人类消息走旁路选人，不排到当前发言者之后', async () => {
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      select.mockResolvedValueOnce({ ids: [a], intent: 'answer' });
      await group.send(id, '换个话题：午饭吃什么');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(select).toHaveBeenCalledTimes(2);
      expect(to()).toEqual([b, a]);
      expect(group.state(id)).toMatchObject({ current: b, queue: [c], pendingHuman: false });
    });

    it('关闭时成员委派后回 [skip] 按原规则交群主兜底', async () => {
      select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      delegated = [c];
      await finishTurn(b, '[skip]');
      expect(to()).toEqual([b, a]);
      expect(next).not.toHaveBeenCalled();
      expect(systems()).toEqual(['「Bob」已跳过，交给群主「Alice」回复。']);
    });

    it('关闭时全员 [skip] 交群主兜底', async () => {
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      await finishTurn(b, '[skip]');
      await finishTurn(c, '[skip]');
      expect(to()).toEqual([b, c, a]);
      expect(next).not.toHaveBeenCalled();
      expect(systems()).toEqual(['「Bob」「Carol」已跳过，交给群主「Alice」回复。']);
    });

    it('讨论进行中关闭开关：在锁内取消判断，迟到结果不投递、不写时间线，只提示一次', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      const pending = deferredNext();
      next.mockReturnValueOnce(pending.promise);
      await finishTurn(b, '观点');
      expect(group.state(id)).toMatchObject({ routing: true });
      discussOn = false;
      await group.syncDiscussMode();
      expect(next.mock.calls[0][1].aborted).toBe(true);
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
      expect(systems()).toEqual([NOTICE]);
      expect(settledBatch).toHaveBeenCalledTimes(1);
      const before = entries();
      pending.resolve({ next: c });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await group.settled(id);
      expect(to()).toEqual([b]);
      expect(entries()).toEqual(before);
      await group.syncDiscussMode();
      expect(systems()).toEqual([NOTICE]);
    });

    it('讨论进行中关闭开关：当前发言者说完就停，不判断、不收尾，剩余候选丢弃', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      discussOn = false;
      await group.syncDiscussMode();
      expect(group.state(id)).toMatchObject({ current: b, queue: [] });
      expect(systems()).toEqual([NOTICE]);
      await finishTurn(b, '我说完了');
      expect(to()).toEqual([b]);
      expect(next).not.toHaveBeenCalled();
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
      expect(systems()).toEqual([NOTICE]);
      expect(settledBatch).toHaveBeenCalledTimes(1);
    });

    it('讨论进行中关闭开关：这一批还没人正常回复，当前发言者回 [skip] 按 main 规则交群主兜底', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      discussOn = false;
      await group.syncDiscussMode();
      await finishTurn(b, '[skip]');
      expect(to()).toEqual([b, a]);
      expect(next).not.toHaveBeenCalled();
      expect(systems()).toEqual([NOTICE, '「Bob」已跳过，交给群主「Alice」回复。']);
      expect(group.state(id)).toMatchObject({ current: a, queue: [] });
      await finishTurn(a, '我来回答');
      expect(to()).toEqual([b, a]);
      expect(next).not.toHaveBeenCalled();
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
    });

    it('讨论进行中关闭开关：关闭前同批已有人 [skip]，当前发言者再 [skip] 时一并计入并交群主', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      await finishTurn(b, '[skip]');
      expect(group.state(id)).toMatchObject({ current: c });
      discussOn = false;
      await group.syncDiscussMode();
      await finishTurn(c, '[skip]');
      expect(to()).toEqual([b, c, a]);
      expect(next).not.toHaveBeenCalled();
      expect(systems()).toEqual([NOTICE, '「Bob」「Carol」已跳过，交给群主「Alice」回复。']);
    });

    it('讨论进行中关闭开关：关闭前同批已有人正常回复，当前发言者回 [skip] 不兜底', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      await finishTurn(b, '观点');
      expect(group.state(id)).toMatchObject({ current: c });
      discussOn = false;
      await group.syncDiscussMode();
      await finishTurn(c, '[skip]');
      expect(to()).toEqual([b, c]);
      expect(next).not.toHaveBeenCalled();
      expect(systems()).toEqual([NOTICE]);
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
      expect(settledBatch).toHaveBeenCalledTimes(1);
    });

    it('讨论进行中关闭开关：判断选出的发言者回 [skip] 不兜底（之前已有人正常回复）', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      next.mockResolvedValueOnce({ next: c });
      await finishTurn(b, '观点');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(group.state(id)).toMatchObject({ current: c });
      discussOn = false;
      await group.syncDiscussMode();
      await finishTurn(c, '[skip]');
      expect(to()).toEqual([b, c]);
      expect(next).toHaveBeenCalledTimes(1);
      expect(systems()).toEqual([NOTICE]);
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
    });

    it('讨论进行中关闭开关：当前发言者回复里的 @ 照常接力（与 main 一致），之后不判断', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      discussOn = false;
      await group.syncDiscussMode();
      await finishTurn(b, '@Alice 你来补充');
      expect(to()).toEqual([b, a]);
      expect(deliver.mock.calls[1][2]).not.toContain(DISCUSS_NOTE);
      await finishTurn(a, '补充完毕');
      expect(to()).toEqual([b, a]);
      expect(next).not.toHaveBeenCalled();
      expect(group.state(id)).toMatchObject({ current: null, routing: false });
    });

    it('关闭开关但尚未同步时：state() 不因判断报 routing，迟到的判断结果在锁内再拦一次', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      const pending = deferredNext();
      next.mockReturnValueOnce(pending.promise);
      await finishTurn(b, '观点');
      discussOn = false;
      expect(group.state(id)).toMatchObject({ routing: false });
      pending.resolve({ next: c });
      await vi.waitFor(() => expect(systems()).toEqual([NOTICE]));
      await group.settled(id);
      expect(to()).toEqual([b]);
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
      await group.syncDiscussMode();
      expect(systems()).toEqual([NOTICE]);
    });

    it('讨论已自然结束的群、没有讨论的群：关闭开关不提示，进行中的普通接力不受影响', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      await finishTurn(b, '观点');
      await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
      await group.settled(id);
      const other = chats.create({
        kind: 'group',
        title: 'Other',
        members: [a, b, c],
        bossBotId: a,
        workspace: { kind: 'chat-home', projectId: 'home-2' },
      })!.id;
      await group.send(other, '@Bob @Carol 看一下');
      expect(group.state(other)).toMatchObject({ current: b, queue: [c] });
      discussOn = false;
      await group.syncDiscussMode();
      expect(systems()).toEqual([]);
      expect(chats.readEntries(other).filter((e) => e.kind === 'system')).toEqual([]);
      expect(group.state(other)).toMatchObject({ current: b, queue: [c] });
    });

    it('关闭时只在确实中断了讨论的群里提示', async () => {
      discussOn = true;
      make();
      const other = chats.create({
        kind: 'group',
        title: 'Other',
        members: [a, b, c],
        bossBotId: a,
        workspace: { kind: 'chat-home', projectId: 'home-2' },
      })!.id;
      await group.send(other, '@Bob 看一下');
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      discussOn = false;
      await group.syncDiscussMode();
      expect(systems()).toEqual([NOTICE]);
      expect(chats.readEntries(other).filter((e) => e.kind === 'system')).toEqual([]);
    });

    it('重新打开不追溯当前轮：开关打开前发出的消息不进入讨论，下一条人类消息才生效', async () => {
      let resolvePick!: (value: SmartRouteDecision) => void;
      select.mockReturnValueOnce(
        new Promise<SmartRouteDecision>((resolve) => {
          resolvePick = resolve;
        })
      );
      await group.send(id, '讨论下方案');
      discussOn = true;
      await group.syncDiscussMode();
      resolvePick({ ids: [b], intent: 'discuss' });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      expect(deliver.mock.calls[0][2]).not.toContain(DISCUSS_NOTE);
      await finishTurn(b, '观点');
      await group.settled(id);
      expect(next).not.toHaveBeenCalled();
      select.mockResolvedValueOnce({ ids: [b], intent: 'discuss' });
      await group.send(id, '再讨论一次');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(deliver.mock.calls[1][2]).toContain(DISCUSS_NOTE);
      await finishTurn(b, '观点 2');
      await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    });

    it('router.json 残留讨论状态：关闭开关后重启只提示中断，不恢复讨论', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      const saved = JSON.parse(
        readFileSync(join(dirname(chats.workspaceDir(id)), 'router.json'), 'utf8')
      );
      expect(saved.state).toMatchObject({ discuss: true, current: b, queue: [c] });
      discussOn = false;
      // 模拟进程中断后重启：不走会清空 router.json 的 dispose
      group = new GroupChatService({
        bots,
        chats,
        host,
        emit,
        responder: { timeoutMs: () => timeoutMs, select, next },
        discussEnabled: () => discussOn,
      });
      expect(entries().at(-1)).toMatchObject({ kind: 'system', text: '回复被中断' });
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
      await finishTurn(b, '迟到的回复');
      expect(to()).toEqual([b]);
      expect(next).not.toHaveBeenCalled();
      expect(systems()).not.toContain(NOTICE);
    });

    it('关闭时委派结果以成员身份回群（runAs）与 hideDelegationIds 照常生效', async () => {
      await group.send(id, '@Bob 开始');
      await finishTurn(b, 'ok');
      for (const delegationId of ['d1', 'd2'])
        chats.appendEntry(id, {
          kind: 'bot',
          botId: b,
          text: `结果全文-${delegationId}`,
          conversationId: `child-${delegationId}`,
          turnId: `t-${delegationId}`,
          delegationId,
          id: `e-${delegationId}`,
          at: Date.now(),
        });
      deliver.mockClear();
      const lead =
        '<delegation-result id="d1" from="Bob" status="completed">ok</delegation-result>';
      expect(
        await group.runAs(
          id,
          a,
          lead,
          undefined,
          { deliveryId: 'r1' },
          { hideDelegationIds: ['d1'] }
        )
      ).toMatchObject({ ok: true });
      const text = String(deliver.mock.calls[0][2]);
      expect(text.startsWith(lead)).toBe(true);
      expect(text).not.toContain('结果全文-d1');
      expect(text).toContain('结果全文-d2');
      expect(text).not.toContain(DISCUSS_NOTE);
      expect(next).not.toHaveBeenCalled();
    });

    it('关闭时不收尾：不判断、不收尾，discussMaxTurns 不生效但存储值保留，maxHops 提示照旧，state 不带 discuss / wrapUp', async () => {
      chats.update(id, (chat) => ({
        ...chat,
        routing: { ...chat.routing, discussMaxTurns: 5, maxHops: 1 },
      }));
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论下方案');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      expect(group.state(id)).not.toHaveProperty('discuss');
      await finishTurn(b, '@Alice 你看看');
      await finishTurn(c, '@Bob 再说说');
      expect(systems()).toEqual(['本轮接力已达上限（1 次），未再交给「Bob」。']);
      await finishTurn(a, '好');
      await group.settled(id);
      expect(to()).toEqual([b, c, a]);
      expect(next).not.toHaveBeenCalled();
      expect(deliver.mock.calls.some((call) => String(call[2]).includes(wrapNote))).toBe(false);
      expect(entries().some((e) => e.kind === 'bot' && e.routedBy === 'wrap-up')).toBe(false);
      expect(group.state(id)).not.toHaveProperty('wrapUp');
      expect(group.state(id)).not.toHaveProperty('discuss');
      expect(chats.get(id)?.routing.discussMaxTurns).toBe(5);
      expect(settledBatch).toHaveBeenCalledTimes(1);
    });

    it('讨论结束、收尾还没投递出去时关闭开关：丢弃收尾，只提示一次「讨论模式已关闭」', async () => {
      discussOn = true;
      // 模拟收尾投递准备期间（拼增量时的 await）用户关掉了开关
      appendix = async (_chat, botId) => {
        if (botId === a) discussOn = false;
        return '';
      };
      make();
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      await finishTurn(b, 'B');
      await finishTurn(c, 'C');
      await vi.waitFor(() => expect(systems()).toEqual([NOTICE]));
      await group.settled(id);
      expect(to()).toEqual([b, c]);
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
      expect(settledBatch).toHaveBeenCalledTimes(1);
      await group.syncDiscussMode();
      expect(systems()).toEqual([NOTICE]);
      expect(
        JSON.parse(readFileSync(join(dirname(chats.workspaceDir(id)), 'router.json'), 'utf8')).state
      ).not.toHaveProperty('wrapUp');
    });

    it('迟到的判断结果在开关关闭后不能触发收尾', async () => {
      discussOn = true;
      make();
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      const pending = deferredNext();
      next.mockReturnValueOnce(pending.promise);
      await finishTurn(b, 'B');
      await finishTurn(c, 'C');
      discussOn = false;
      pending.resolve({ end: true });
      await vi.waitFor(() => expect(systems()).toEqual([NOTICE]));
      await group.settled(id);
      expect(to()).toEqual([b, c]);
      expect(group.state(id)).toMatchObject({ current: null, routing: false });
    });

    it('群主已在收尾时关闭开关：让 TA 说完，回复按 main 规则处理（@ 照常接力），不提示', async () => {
      discussOn = true;
      make();
      await toWrapUp();
      expect(group.state(id)).toMatchObject({ current: a, wrapUp: true });
      discussOn = false;
      await group.syncDiscussMode();
      expect(systems()).toEqual([]);
      expect(group.state(id)).toMatchObject({ current: a });
      expect(
        JSON.parse(readFileSync(join(dirname(chats.workspaceDir(id)), 'router.json'), 'utf8')).state
      ).not.toHaveProperty('wrapUp');
      await finishTurn(a, '结论：做 A。@Bob 去落实');
      expect(to()).toEqual([b, c, a, b]);
      expect(entries().find((e) => e.kind === 'bot' && e.botId === a)).toMatchObject({
        routedBy: 'wrap-up',
      });
      expect(String(deliver.mock.calls[3][2])).not.toContain(DISCUSS_NOTE);
      await finishTurn(b, '收到');
      // 与 main 一致：群主 @ 派出的人回复后追加一跳汇总
      expect(to()).toEqual([b, c, a, b, a]);
      expect(String(deliver.mock.calls[4][2])).toContain('你派出的成员都已回复');
      expect(String(deliver.mock.calls[4][2])).not.toContain(wrapNote);
      await finishTurn(a, '汇总');
      expect(next).toHaveBeenCalledTimes(1);
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
      expect(systems()).toEqual([]);
    });

    it('群主收尾中关闭开关（maxTurnsPerBot=1）：讨论里的发言次数不占普通额度，群主这次收尾计一次', async () => {
      discussOn = true;
      chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, maxTurnsPerBot: 1 } }));
      make();
      await toWrapUp();
      discussOn = false;
      await group.syncDiscussMode();
      await finishTurn(a, '@Bob 请落实');
      expect(to()).toEqual([b, c, a, b]);
      expect(systems()).toEqual([]);
      await finishTurn(b, '收到');
      // 群主这次收尾发言已占用普通额度：汇总跳按上限拦下
      expect(to()).toEqual([b, c, a, b]);
      expect(systems()).toEqual(['「Alice」本轮已回复 1 次，达到上限，未再请 TA 汇总。']);
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
    });

    it('讨论进行中关闭开关（maxTurnsPerBot=1）：当前发言者说完后的 @ 接力按全新额度', async () => {
      discussOn = true;
      chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, maxTurnsPerBot: 1 } }));
      make();
      select.mockResolvedValueOnce({ ids: [b, c], intent: 'discuss' });
      await group.send(id, '讨论');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      discussOn = false;
      await group.syncDiscussMode();
      await finishTurn(b, '@Carol 你看下');
      expect(to()).toEqual([b, c]);
      expect(systems()).toEqual([NOTICE]);
      await finishTurn(c, '好');
      expect(group.state(id)).toMatchObject({ current: null, queue: [], routing: false });
    });
  });
});

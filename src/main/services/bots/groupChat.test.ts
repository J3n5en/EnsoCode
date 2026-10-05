import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartRouteDecision, SmartRouteInput } from '../../../shared/bots/smartRoute';
import type { BotTurnFinished } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { GroupChatService } from './groupChat';

let root: string;
let bots: BotStore;
let chats: BotChatStore;
let group: GroupChatService;
let a: string;
let b: string;
let id: string;
let finish: (event: BotTurnFinished) => void;
let deliverySent: (event: { conversationId: string; deliveryId: string }) => void;
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
const done = async (botId: string, text: string, ok = true) => {
  finish({
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

it('steers only current mentions and restarts with merged pending humans', async () => {
  await group.send(id, '@所有人');
  await group.send(id, '@Alice detail');
  expect(deliver.mock.calls[1][2]).toContain('detail');
  expect(group.state(id)).toMatchObject({ pendingHuman: false });
  await group.send(id, '@Bob next');
  await group.send(id, 'another');
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(group.state(id)).toMatchObject({ pendingHuman: true });
  await done(a, '@Alice ignored');
  expect(group.state(id)).toMatchObject({
    current: b,
    queue: [],
    hops: 0,
    turnsByBot: { [b]: 1 },
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

it('serializes simultaneous human messages without starting two members', async () => {
  await Promise.all([group.send(id, '@Alice first'), group.send(id, '@Bob second')]);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(group.state(id)).toMatchObject({ current: a, pendingHuman: true });
  await done(a, 'done');
  expect(group.state(id)).toMatchObject({ current: b });
  expect(entries().map((e) => e.seq)).toEqual([1, 2, 3]);
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
  let timeoutMs = 1000;
  const useResponder = () => {
    group.dispose();
    group = new GroupChatService({
      bots,
      chats,
      host,
      emit,
      responder: { timeoutMs: () => timeoutMs, select },
    });
  };
  beforeEach(() => {
    select.mockReset();
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

  it('分类期间 chatState 暴露 routing，超时兜底群主且不写报错条目', async () => {
    timeoutMs = 20;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    select.mockImplementationOnce(() => new Promise(() => {}));
    await group.send(id, 'hello');
    expect(group.state(id)).toMatchObject({ routing: true, current: null });
    expect(deliver).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(a);
    expect(group.state(id)).toMatchObject({ routing: false, current: a });
    expect(entries().some((e) => e.kind === 'system')).toBe(false);
    await done(a, 'hi');
    expect(entries().at(-1)).toMatchObject({ kind: 'bot', botId: a });
    expect(entries().at(-1)).not.toHaveProperty('routedBy');
    warn.mockRestore();
  });

  it('出错或选中不在群成员时兜底群主', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    select.mockRejectedValueOnce(new Error('boom'));
    await group.send(id, 'one');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0][1]).toBe(a);
    await done(a, 'ok');
    select.mockResolvedValueOnce({ ids: ['ghost'] });
    await group.send(id, 'two');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1][1]).toBe(a);
    warn.mockRestore();
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

  it('成员回复期间积压的无 @ 消息在其说完后智能选人', async () => {
    await group.send(id, '@Alice start');
    await group.send(id, 'follow up');
    expect(select).not.toHaveBeenCalled();
    select.mockResolvedValueOnce({ ids: [b] });
    await done(a, 'done');
    expect(select).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1][1]).toBe(b);
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

  it('多人队列中人类插话：当前说完后丢弃剩余名单，按新消息重新选人', async () => {
    select.mockResolvedValueOnce({ ids: [b, a] });
    await group.send(id, 'q');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await group.send(id, '换个问题');
    expect(group.state(id)).toMatchObject({ current: b, pendingHuman: true });
    select.mockResolvedValueOnce({ ids: [b] });
    await done(b, 'answer');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(select.mock.calls[1][0].message).toBe('换个问题');
    expect(deliver.mock.calls.map((c) => c[1])).toEqual([b, b]);
    expect(group.state(id)).toMatchObject({ current: b, queue: [] });
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

  it('人类插话打断本轮时清空名单，不再提醒', async () => {
    await group.send(id, '出方案');
    await done(a, '@Bob @Carol 各给一个方案');
    await group.send(id, '换个话题');
    await done(b, 'B 方案');
    expect(to()).toEqual([a, b, a]);
    await done(a, '好');
    expect(group.state(id)).toMatchObject({ current: null });
    expect(deliver.mock.calls.some((call) => String(call[2]).includes('routing-note'))).toBe(false);
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

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import { BotSessionHost } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { GroupChatService } from './groupChat';
import type { MemberTaskClassifier } from './memberTaskClassifier';

let root: string;
let host: BotSessionHost;
let bots: BotStore;
let chats: BotChatStore;
let registry: SourceAuthorityRegistry;
const classify = vi.fn<MemberTaskClassifier>(async () => 'serial');
const prepare = vi.fn(async (_botId: string) => {});
const runtime = {
  spawn: vi.fn(async () => ({ ok: true })),
  prompt: vi.fn((_id: string, _text: string) => ({ ok: true })),
  steer: vi.fn(() => ({ ok: true })),
  retry: vi.fn(() => ({ ok: true })),
  release: vi.fn(async () => {}),
  abort: vi.fn(),
  removeSessionFiles: vi.fn(),
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** 会话最近一次 spawn 的实例号：结束事件要回显它才算该实例结束 */
const instanceOf = (id: string) =>
  (runtime.spawn.mock.calls as unknown as [{ conversationId: string; instanceId: string }][])
    .filter(([spec]) => spec.conversationId === id)
    .at(-1)?.[0].instanceId;
const human = { kind: 'human' as const, readOnly: false };
const roots = new Map<string, string>();
beforeEach(() => {
  vi.resetAllMocks();
  roots.clear();
  classify.mockResolvedValue('serial');
  runtime.spawn.mockResolvedValue({ ok: true });
  runtime.prompt.mockReturnValue({ ok: true });
  runtime.steer.mockReturnValue({ ok: true });
  runtime.retry.mockReturnValue({ ok: true });
  runtime.release.mockResolvedValue();
  root = mkdtempSync(join(tmpdir(), 'bot-admission-'));
  registry = new SourceAuthorityRegistry({ registryFile: join(root, 'registry.json') });
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'chats'));
  host = new BotSessionHost({
    bots,
    chats,
    authority: registry,
    runtime,
    emit: () => {},
    classifyMemberTask: classify,
    budget: { prepare, verdict: () => null },
  });
});
afterEach(() => {
  host.dispose();
  rmSync(root, { recursive: true, force: true });
});
function member() {
  const result = bots.create(
    { name: `Dev${bots.list().length}`, title: '', scope: '', persona: '' },
    []
  );
  if (!result.ok) throw new Error(result.reason);
  return result.bot.id;
}
/** 同一成员再次调用时返回同一聊天发起的委派子会话：同成员准入只在同一聊天内生效 */
function session(botId: string) {
  const root = roots.get(botId);
  if (root) return delegated(botId, root, registry.conversation(root)!.bot!.chatId);
  const id = chatSession(botId);
  roots.set(botId, id);
  return id;
}
function chatSession(botId: string) {
  const chat = chats.create({
    kind: 'direct',
    title: '',
    members: [botId],
    bossBotId: null,
    workspace: { kind: 'member-home' },
  });
  if (!chat) throw new Error('chat');
  const result = host.ensureSession(chat.id, botId);
  if (!result.ok) throw new Error(result.error);
  return result.conversationId;
}
function delegated(botId: string, parent: string, chatId: string | null) {
  const child = registry.createBotConversation(registry.conversation(parent)!.projectId, {
    botId,
    chatId: null,
    delegationId: randomUUID(),
  })!;
  host.registerDelegation(child.conversationId, bots.get(botId)!, {
    parentConversationId: parent,
    chatId,
  });
  return child.conversationId;
}
function done(id: string) {
  host.observe({
    seq: 1,
    identity: { sessionId: id, generation: 'g' },
    type: 'turn-completed',
    turnId: 't',
  } as AgentWorkerEvent);
}
async function interjectionFixture() {
  const botId = member();
  const chat = chats.create({
    kind: 'group',
    title: 'Team',
    members: [botId, member()],
    bossBotId: botId,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!;
  const parent = host.ensureSession(chat.id, botId);
  if (!parent.ok) throw new Error(parent.error);
  const child = delegated(botId, parent.conversationId, chat.id);
  await host.deliverConversation(child, 'long delegated task');
  host.observe({
    seq: 1,
    identity: { sessionId: child, generation: 'g' },
    type: 'status',
    status: 'running',
  });
  const group = new GroupChatService({ bots, chats, host, emit: () => {} });
  await group.send(chat.id, `@${bots.get(botId)!.name} use iPhone 13`, { source: 'human' });
  await flush();
  return { botId, chatId: chat.id, child, parent: parent.conversationId, group };
}
it('redirects a human queue item only after the delegated worker consumes it, without duplicate group delivery', async () => {
  const { chatId, child, group, parent } = await interjectionFixture();
  const queued = host.queueState()[0];
  expect(queued).toMatchObject({ canInterject: true, deliveryId: expect.any(String) });
  const result = host.interjectQueued(chatId, queued.deliveryId!, human);
  await flush();
  expect(host.queueState()).toHaveLength(1);
  const call = runtime.steer.mock.calls[0] as unknown as [string, string, unknown, string];
  expect(call[0]).toBe(child);
  expect(call[1]).toContain('来自群「Team」的插话：');
  expect(call[1]).toContain('use iPhone 13');
  host.observe({
    seq: 2,
    identity: { sessionId: child, generation: 'g' },
    type: 'delivery-settled',
    deliveryId: call[3],
  });
  expect(await result).toMatchObject({ ok: true });
  await group.settled(chatId);
  expect(host.queueState()).toHaveLength(0);
  expect(chats.readEntries(chatId)).toContainEqual(
    expect.objectContaining({ kind: 'system', text: '已转给 Dev0 当前任务' })
  );
  expect(chats.get(chatId)!.sessions[queued.botId].cursor).toBeGreaterThan(0);
  done(child);
  await flush();
  expect(runtime.prompt.mock.calls.filter((call) => call[0] === parent)).toHaveLength(0);
  expect(group.state(chatId)).toMatchObject({ current: null });
});
it.each([
  { kind: 'human' as const, readOnly: true },
  { kind: 'bot' as const, readOnly: false },
])('rejects untrusted interjection actor %j', async (actor) => {
  const { chatId } = await interjectionFixture();
  const queued = host.queueState()[0];
  expect(await host.interjectQueued(chatId, queued.deliveryId!, actor)).toMatchObject({
    ok: false,
  });
  expect(host.queueState()).toHaveLength(1);
  expect(runtime.steer).not.toHaveBeenCalled();
});
it('keeps the queued item when the target turn has ended', async () => {
  const { chatId, child } = await interjectionFixture();
  const queued = host.queueState()[0];
  // Prevent automatic dequeue while testing the late click.
  await host.deliverConversation(chatSession(member()), 'occupy capacity');
  host.setMaxRunningTurns(1);
  done(child);
  expect(await host.interjectQueued(chatId, queued.deliveryId!, human)).toMatchObject({
    ok: false,
    error: 'Dev0 当前任务已结束，消息继续排队',
  });
  expect(host.queueState().some((item) => item.deliveryId === queued.deliveryId)).toBe(true);
  expect(runtime.steer).not.toHaveBeenCalled();
});
it('does not turn a deferred interjection into a new delegated prompt', async () => {
  const { chatId, child } = await interjectionFixture();
  const queued = host.queueState()[0];
  const result = host.interjectQueued(chatId, queued.deliveryId!, human);
  await flush();
  const call = runtime.steer.mock.calls[0] as unknown as [string, string, unknown, string];
  host.observe({
    seq: 2,
    identity: { sessionId: child, generation: 'g' },
    type: 'delivery-deferred',
    deliveryId: call[3],
  });
  expect(await result).toMatchObject({ ok: false });
  expect(host.queueState()[0].conversationId).toBe(queued.conversationId);
  expect(host.queueState()).toHaveLength(1);
});
it('rejects repeated clicks while waiting for the worker receipt', async () => {
  const { chatId, child } = await interjectionFixture();
  const queued = host.queueState()[0];
  const result = host.interjectQueued(chatId, queued.deliveryId!, human);
  await flush();
  expect(await host.interjectQueued(chatId, queued.deliveryId!, human)).toMatchObject({
    ok: false,
  });
  expect(runtime.steer).toHaveBeenCalledTimes(1);
  expect(host.queueState()[0].canInterject).toBe(false);
  done(child);
  expect(await result).toMatchObject({ ok: false });
  await flush();
  expect(
    runtime.prompt.mock.calls.filter((call) => call[0] === queued.conversationId)
  ).toHaveLength(1);
  expect(
    chats
      .readEntries(chatId)
      .some((entry) => entry.kind === 'system' && entry.text.startsWith('已转给'))
  ).toBe(false);
});
it('does not offer or accept transfer of a member-authored queued message', async () => {
  const { chatId, group, parent, child } = await interjectionFixture();
  await group.stop(chatId);
  await host.deliverConversation(parent, 'member message', {
    source: 'bot',
    deliveryId: 'member-message',
  });
  await flush();
  const queued = host.queueState()[0];
  expect(queued.canInterject).toBe(false);
  expect(await host.interjectQueued(chatId, queued.deliveryId!, human)).toMatchObject({
    ok: false,
  });
  expect(runtime.steer).not.toHaveBeenCalled();
  done(child);
});
it('does not offer the button while the delegated task is stopping', async () => {
  const { chatId, child } = await interjectionFixture();
  let released!: () => void;
  runtime.release.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        released = resolve;
      })
  );
  const stop = host.abortConversation(child);
  await flush();
  const queued = host.queueState()[0];
  expect(queued.canInterject).toBe(false);
  expect(await host.interjectQueued(chatId, queued.deliveryId!, human)).toMatchObject({
    ok: false,
  });
  released();
  await stop;
});
it('does not offer transfer before the delegated worker reports running', async () => {
  const { chatId, child, parent, group } = await interjectionFixture();
  await group.stop(chatId);
  // Queue the next human message behind a child still waiting to spawn.
  await host.abortConversation(child);
  let spawned!: () => void;
  runtime.spawn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        spawned = () => resolve({ ok: true });
      })
  );
  const delegatedStart = host.deliverConversation(child, 'next long task');
  await flush();
  await host.deliverConversation(parent, 'queued', {
    source: 'human',
    deliveryId: 'preparing-human',
  });
  expect(host.queueState()[0].canInterject).toBe(false);
  spawned();
  await delegatedStart;
});
it.each(['turn-retry', 'idle'] as const)('does not offer interjection during %s', async (state) => {
  const { child } = await interjectionFixture();
  host.observe({
    seq: 2,
    identity: { sessionId: child, generation: 'g' },
    type: 'status',
    status: 'running',
  });
  host.observe(
    state === 'idle'
      ? { seq: 3, identity: { sessionId: child, generation: 'g' }, type: 'status', status: 'idle' }
      : {
          seq: 3,
          identity: { sessionId: child, generation: 'g' },
          type: 'turn-retry',
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1000,
          error: 'retry',
        }
  );
  expect(host.queueState()[0].canInterject).toBeFalsy();
});
it('keeps direct human steer into an active group reply, without offering a transfer', async () => {
  const botId = member();
  const chat = chats.create({
    kind: 'group',
    title: 'Team',
    members: [botId, member()],
    bossBotId: botId,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!;
  const group = new GroupChatService({ bots, chats, host, emit: () => {} });
  await group.send(chat.id, '@Dev0 reply', { source: 'human' });
  await group.send(chat.id, '@Dev0 use iPhone 13', { source: 'human' });
  expect(runtime.steer).toHaveBeenCalledTimes(1);
  expect(host.queueState()).toEqual([]);
});
it('does not classify idle tasks, serializes conflicts and lets other members run', async () => {
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  await host.deliverConversation(a, 'deploy service');
  expect(classify).not.toHaveBeenCalled();
  expect(await host.deliverConversation(b, 'deploy same service')).toMatchObject({ queued: true });
  await flush();
  expect(classify).toHaveBeenCalledTimes(1);
  await host.deliverConversation(session(member()), 'independent');
  expect(runtime.prompt).toHaveBeenCalledTimes(2);
  done(a);
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(3);
});
it('parallel verdict permits independent work without consuming a classification slot', async () => {
  classify.mockResolvedValue('parallel');
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  await host.deliverConversation(a, 'query A');
  await host.deliverConversation(b, 'query B');
  await flush();
  expect(host.runningCount()).toBe(2);
  expect(runtime.prompt).toHaveBeenCalledTimes(2);
});
it('holds stopping occupancy until release, ignoring late completion', async () => {
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  await host.deliverConversation(a, 'deploy');
  let release!: () => void;
  runtime.release.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const stopped = host.abortConversation(a);
  await flush();
  done(a);
  await host.deliverConversation(b, 'query');
  await flush();
  expect(host.runningCount()).toBe(1);
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
  expect(classify).not.toHaveBeenCalled();
  release();
  await stopped;
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(2);
});
it('preserves same-member FIFO even when a human arrives after background work', async () => {
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  const c = session(bot);
  await host.deliverConversation(a, 'first');
  await host.deliverConversation(b, 'second', { source: 'background' });
  await host.deliverConversation(c, 'third', { source: 'human' });
  await flush();
  done(a);
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['first', 'second']);
  done(b);
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['first', 'second', 'third']);
});
it('drops a canceled classification', async () => {
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  const c = session(bot);
  let verdict!: (value: 'parallel') => void;
  classify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        verdict = resolve;
      })
  );
  await host.deliverConversation(a, 'first');
  await host.deliverConversation(b, 'canceled');
  await flush();
  await host.abortConversation(b);
  await host.deliverConversation(c, 'third');
  await flush();
  verdict('parallel');
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
  done(a);
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['first', 'third']);
});
it('retry goes through the same member admission', async () => {
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  await host.deliverConversation(b, 'old');
  done(b);
  await host.deliverConversation(a, 'active');
  expect(await host.retryConversation(b, { delegation: true })).toMatchObject({
    ok: true,
    queued: true,
  });
  await flush();
  expect(runtime.retry).not.toHaveBeenCalled();
  done(a);
  await flush();
  expect(runtime.retry).toHaveBeenCalledTimes(1);
});
it('limit one delegation advances only after its actual parent terminal event', async () => {
  host.setMaxRunningTurns(1);
  const bot = member();
  const parent = session(bot);
  await host.deliverConversation(parent, 'delegate');
  const projectId = registry.conversation(parent)!.projectId;
  const child = registry.createBotConversation(projectId, {
    botId: bot,
    chatId: null,
    delegationId: 'delegated',
  })!;
  host.registerDelegation(child.conversationId, bots.get(bot)!, {
    parentConversationId: parent,
    chatId: null,
  });
  await host.deliverConversation(child.conversationId, 'child');
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
  done(parent);
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(2);
  expect(host.runningCount()).toBe(1);
});

it('reclassifies after steering changes the active task instead of accepting a stale parallel verdict', async () => {
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  let verdict!: (value: 'parallel') => void;
  classify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        verdict = resolve;
      })
  );
  await host.deliverConversation(a, 'query first');
  await host.deliverConversation(b, 'deploy production');
  await flush();
  await host.deliverConversation(a, 'also deploy production');
  await flush();
  verdict('parallel');
  await flush();
  expect(classify).toHaveBeenCalledTimes(2);
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
});

it('serializes decisions for simultaneous arrivals and includes the first reservation in the next snapshot', async () => {
  classify.mockResolvedValueOnce('parallel').mockResolvedValue('serial');
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  const c = session(bot);
  await host.deliverConversation(a, 'active');
  await Promise.all([host.deliverConversation(b, 'one'), host.deliverConversation(c, 'two')]);
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(2);
  expect(classify).toHaveBeenCalledTimes(2);
  expect(classify.mock.calls[1]?.[0]).toMatchObject({
    active: expect.arrayContaining([{ task: 'one', state: 'running' }]),
  });
});

it('cancels during spawn without sending a prompt or freeing capacity before release', async () => {
  let spawned!: () => void;
  let released!: () => void;
  runtime.spawn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        spawned = () => resolve({ ok: true });
      })
  );
  runtime.release.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        released = resolve;
      })
  );
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  const sent = host.deliverConversation(a, 'first');
  await flush();
  const stopped = host.abortConversation(a);
  await host.deliverConversation(b, 'second');
  spawned();
  await sent;
  await flush();
  expect(runtime.prompt).not.toHaveBeenCalled();
  expect(host.runningCount()).toBe(1);
  released();
  await stopped;
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
});

it('keeps retired task occupancy until actual release', async () => {
  let released!: () => void;
  runtime.release.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        released = resolve;
      })
  );
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  await host.deliverConversation(a, 'first');
  host.retireSession(a);
  await flush();
  await host.deliverConversation(b, 'second');
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
  expect(host.runningCount()).toBe(1);
  released();
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(2);
});

it('settles a canceled queued reservation exactly once, including during spawn', async () => {
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  const finished = vi.fn();
  host.onTurnFinished(finished);
  await host.deliverConversation(a, 'first');
  await host.deliverConversation(b, 'second', { deliveryId: 'second' });
  await flush();
  let spawned!: () => void;
  runtime.spawn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        spawned = () => resolve({ ok: true });
      })
  );
  done(a);
  await flush();
  const stopped = host.abortConversation(b);
  spawned();
  await stopped;
  await flush();
  expect(
    finished.mock.calls.map(([event]) => event).filter((event) => event.conversationId === b)
  ).toMatchObject([{ ok: false, stopped: true, deliveryId: 'second' }]);
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
});

it.each(['parent-ended', 'worker-exited'] as const)(
  'recovers a release timeout only on authoritative %s',
  async (type) => {
    host.setMaxRunningTurns(1);
    const bot = member();
    const a = session(bot);
    const b = session(bot);
    await host.deliverConversation(a, 'first');
    runtime.release.mockRejectedValueOnce(new Error('release timeout'));
    await expect(host.abortConversation(a)).rejects.toThrow('release timeout');
    await host.deliverConversation(b, 'second');
    done(a);
    await flush();
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
    host.observe(
      type === 'worker-exited'
        ? { type }
        : ({
            type,
            reason: 'ended',
            seq: 2,
            identity: { sessionId: a, generation: 'g' },
            instanceId: instanceOf(a),
          } as AgentWorkerEvent)
    );
    await flush();
    expect(runtime.prompt).toHaveBeenCalledTimes(2);
    expect(host.runningCount()).toBe(1);
  }
);

it('does not classify retry using a newer prompt that the worker rejected', async () => {
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  await host.deliverConversation(a, 'deploy X');
  done(a);
  runtime.prompt.mockReturnValueOnce({ ok: false });
  expect(await host.deliverConversation(a, 'query Y')).toMatchObject({ ok: false });
  await host.deliverConversation(b, 'deploy X');
  await host.retryConversation(a);
  await flush();
  expect(classify).toHaveBeenLastCalledWith(
    expect.objectContaining({ task: 'deploy X' }),
    expect.any(AbortSignal)
  );
});

it('preserves other members source priority after a FIFO predecessor is canceled', async () => {
  host.setMaxRunningTurns(1);
  const active = session(member());
  const bot = member();
  const low = session(bot);
  const high = session(bot);
  const other = session(member());
  await host.deliverConversation(active, 'active');
  await host.deliverConversation(low, 'background', { source: 'background' });
  await host.deliverConversation(high, 'human', { source: 'human' });
  await host.deliverConversation(other, 'bot', { source: 'bot' });
  await host.abortConversation(low);
  done(active);
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['active', 'human']);
});

it('does not overtake an earlier same-member request still preparing its budget', async () => {
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  let prepared!: () => void;
  prepare.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        prepared = resolve;
      })
  );
  const first = host.deliverConversation(a, 'first');
  await flush();
  await host.deliverConversation(b, 'second');
  await flush();
  expect(runtime.prompt).not.toHaveBeenCalled();
  expect(host.runningCount()).toBe(0);
  prepared();
  await first;
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['first']);
});

it('steers the active turn without waiting behind the same member next task', async () => {
  host.setMaxRunningTurns(1);
  const blocker = session(member());
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  await host.deliverConversation(blocker, 'blocker');
  await host.deliverConversation(a, 'first');
  await host.deliverConversation(b, 'second', { queueIfBusy: true });
  await host.deliverConversation(a, 'supplement');
  done(blocker);
  await flush();
  expect(runtime.steer).toHaveBeenCalledTimes(1);
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['blocker', 'first']);
});

it('does not send an already dequeued steer after cancellation during spawn', async () => {
  host.setMaxRunningTurns(1);
  const blocker = session(member());
  const a = session(member());
  await host.deliverConversation(blocker, 'blocker');
  await host.deliverConversation(a, 'first');
  await host.deliverConversation(a, 'supplement');
  let spawned!: () => void;
  runtime.spawn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        spawned = () => resolve({ ok: true });
      })
  );
  done(blocker);
  await flush();
  const stopped = host.abortConversation(a);
  spawned();
  await stopped;
  await flush();
  expect(runtime.steer).not.toHaveBeenCalled();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['blocker']);
});

it('registers retry FIFO order before an immediately following new task', async () => {
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  await host.deliverConversation(a, 'old');
  done(a);
  const retried = host.retryConversation(a);
  const sent = host.deliverConversation(b, 'new');
  await Promise.all([retried, sent]);
  await flush();
  expect(runtime.retry).toHaveBeenCalledTimes(1);
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['old']);
  done(a);
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['old', 'new']);
});

it('keeps dequeued steering in same-member FIFO until its session lock is acquired', async () => {
  host.setMaxRunningTurns(1);
  const blocker = session(member());
  const bot = member();
  const a = session(bot);
  const b = session(bot);
  await host.deliverConversation(blocker, 'blocker');
  await host.deliverConversation(a, 'first');
  await host.deliverConversation(a, 'supplement');
  await host.deliverConversation(b, 'other chat');
  runtime.prompt.mockImplementationOnce(() => {
    done(a);
    return { ok: true };
  });
  done(blocker);
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual([
    'blocker',
    'first',
    'supplement',
  ]);
  expect(runtime.steer).not.toHaveBeenCalled();
  done(a);
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual([
    'blocker',
    'first',
    'supplement',
    'other chat',
  ]);
});

function receipt(id: string, deliveryId: string, type: string) {
  host.observe({
    type,
    identity: { sessionId: id, generation: 'g' },
    seq: 2,
    deliveryId,
  } as AgentWorkerEvent);
}

it('不把 IPC 下发当作插话成功，worker 拒绝空闲插话后按原 ID 重投一次', async () => {
  const a = session(member());
  const sent = vi.fn();
  host.onDeliverySent(sent);
  await host.deliverConversation(a, 'first');
  sent.mockClear();
  expect(await host.deliverConversation(a, 'late', { deliveryId: 'late' })).toMatchObject({
    queued: true,
    steerPending: true,
  });
  expect(sent).not.toHaveBeenCalled();
  done(a);
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
  receipt(a, 'late', 'delivery-deferred');
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['first', 'late']);
  expect(sent).toHaveBeenCalledWith({ conversationId: a, deliveryId: 'late' });
  receipt(a, 'late', 'delivery-deferred');
  done(a);
  await flush();
  expect(runtime.prompt).toHaveBeenCalledTimes(2);
});

it('插话消费回执才推进游标；重复回执不重复确认', async () => {
  const a = session(member());
  const sent = vi.fn();
  host.onDeliverySent(sent);
  await host.deliverConversation(a, 'first');
  await host.deliverConversation(a, 'supplement', { deliveryId: 's' });
  expect(sent).not.toHaveBeenCalled();
  receipt(a, 's', 'delivery-settled');
  receipt(a, 's', 'delivery-settled');
  expect(sent).toHaveBeenCalledExactlyOnceWith({
    conversationId: a,
    deliveryId: 's',
    steered: true,
  });
});

it.each(['worker-exited', 'parent-ended'] as const)(
  '未确认插话在 %s 时显式失败，不静默丢弃',
  async (type) => {
    const a = session(member());
    const finished = vi.fn();
    host.onTurnFinished(finished);
    await host.deliverConversation(a, 'first');
    await host.deliverConversation(a, 'pending', { deliveryId: 'pending' });
    done(a);
    host.observe(
      type === 'worker-exited'
        ? { type }
        : {
            type,
            seq: 4,
            identity: { sessionId: a, generation: 'g' },
            reason: 'ended',
            instanceId: instanceOf(a),
          }
    );
    expect(finished.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({ deliveryId: 'pending', ok: false })
    );
    receipt(a, 'pending', 'delivery-deferred');
    await flush();
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
  }
);

it('较新的 steer 不越过同会话明确排队的消息', async () => {
  const a = session(member());
  await host.deliverConversation(a, 'first');
  await host.deliverConversation(a, 'older', { queueIfBusy: true });
  await host.deliverConversation(a, 'newer');
  expect(runtime.steer).not.toHaveBeenCalled();
  done(a);
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['first', 'older']);
  expect(runtime.steer).toHaveBeenCalledTimes(1);
});

it('同一成员在不同聊天里直接并行，不调分类器也不排在别的聊天后面', async () => {
  const bot = member();
  const a = session(bot);
  const queued = session(bot);
  const other = chatSession(bot);
  await host.deliverConversation(a, 'long task in A');
  await host.deliverConversation(queued, 'same chat follow-up');
  await flush();
  classify.mockClear();
  expect(await host.deliverConversation(other, 'task in B')).not.toHaveProperty('queued');
  await flush();
  expect(classify).not.toHaveBeenCalled();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['long task in A', 'task in B']);
  expect(host.queueState()).toMatchObject([{ conversationId: queued, reason: 'member-serial' }]);
});

it('委派子会话按发起它的聊天归属，沿委派链追到根聊天', async () => {
  const bot = member();
  const a = session(bot);
  await host.deliverConversation(a, 'long task in A');
  const chatB = registry.conversation(chatSession(member()))!;
  const fromB = delegated(bot, chatB.conversationId, chatB.bot!.chatId);
  const nested = delegated(bot, fromB, null);
  expect(await host.deliverConversation(fromB, 'delegated from B')).not.toHaveProperty('queued');
  expect(await host.deliverConversation(nested, 'nested from B')).toMatchObject({ queued: true });
  await flush();
  expect(classify).toHaveBeenCalledOnce();
  expect(classify.mock.calls[0]?.[0].active).toEqual([
    { task: 'delegated from B', state: 'running' },
  ]);
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual([
    'long task in A',
    'delegated from B',
  ]);
});

it('跨聊天不排同成员队，但全局并发上限照旧按 capacity 排队', async () => {
  host.setMaxRunningTurns(1);
  const bot = member();
  const a = session(bot);
  const other = chatSession(bot);
  await host.deliverConversation(a, 'long task in A');
  const queued = await host.deliverConversation(other, 'task in B');
  expect(queued).toMatchObject({ queued: true });
  expect(queued).not.toHaveProperty('steerPending');
  await flush();
  expect(classify).not.toHaveBeenCalled();
  expect(host.queueState()).toMatchObject([{ conversationId: other, reason: 'capacity' }]);
  done(a);
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['long task in A', 'task in B']);
});

it('委派归属缺失也不允许新消息越过同会话未确认的旧插话', async () => {
  const bot = member();
  const parent = session(bot);
  const child = registry.createBotConversation(registry.conversation(parent)!.projectId, {
    botId: bot,
    chatId: null,
    delegationId: randomUUID(),
  })!;
  const id = child.conversationId;
  host.registerDelegation(id, bots.get(bot)!);
  await host.deliverConversation(id, 'first');
  await host.deliverConversation(id, 'older', { deliveryId: 'older' });
  done(id);
  await host.deliverConversation(id, 'newer', { queueIfBusy: true });
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['first']);
  receipt(id, 'older', 'delivery-deferred');
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['first', 'older']);
  done(id);
  await flush();
  expect(runtime.prompt.mock.calls.map((call) => call[1])).toEqual(['first', 'older', 'newer']);
});

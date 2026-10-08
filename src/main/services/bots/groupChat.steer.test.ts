import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SmartRouteDecision, SmartRouteInput } from '../../../shared/bots/smartRoute';
import type { AgentWorkerEvent, AttachedImage } from '../../../shared/types/agent';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import { BotSessionHost } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { GroupChatService } from './groupChat';

let root: string;
let host: BotSessionHost;
let group: GroupChatService;
let chats: BotChatStore;
let chatId: string;
let a: string;
let b: string;
let c: string;
let turn = 0;
const prepare = vi.fn(async () => {});
const select = vi.fn<() => Promise<SmartRouteDecision>>();
const settled = vi.fn();
const runtime = {
  spawn: vi.fn(async () => ({ ok: true })),
  prompt: vi.fn((_id: string, _text: string) => ({ ok: true })),
  steer: vi.fn((_id: string, _text: string, _images?: AttachedImage[], _deliveryId?: string) => ({
    ok: true,
  })),
  release: vi.fn(async () => {}),
  abort: vi.fn(),
  removeSessionFiles: vi.fn(),
};
const session = (botId: string) => chats.get(chatId)!.sessions[botId].conversationId;
const replies = () => chats.readEntries(chatId).filter((entry) => entry.kind === 'bot');
function received(id: string, deliveryId: string) {
  host.observe({
    type: 'delivery-settled',
    identity: { sessionId: id, generation: 'g' },
    seq: ++turn,
    deliveryId,
  });
}
function done(botId: string, text: string) {
  const identity = { sessionId: session(botId), generation: 'g' };
  host.observe({
    seq: ++turn,
    identity,
    type: 'message-upsert',
    index: turn,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as AgentWorkerEvent);
  host.observe({
    seq: ++turn,
    identity,
    type: 'turn-completed',
    turnId: String(turn),
  } as AgentWorkerEvent);
}
beforeEach(() => {
  vi.resetAllMocks();
  runtime.spawn.mockResolvedValue({ ok: true });
  runtime.prompt.mockReturnValue({ ok: true });
  runtime.steer.mockImplementation((id, _text, _images, deliveryId) => {
    received(id, deliveryId!);
    return { ok: true };
  });
  root = mkdtempSync(join(tmpdir(), 'group-steer-'));
  const bots = new BotStore(join(root, 'bots'));
  [a, b, c] = ['Alice', 'Bob', 'Carol'].map((name) => {
    const result = bots.create({ name }, []);
    if (!result.ok) throw new Error('fixture');
    return result.bot.id;
  });
  chats = new BotChatStore(join(root, 'chats'));
  chatId = chats.create({
    kind: 'group',
    title: 'Team',
    members: [a, b, c],
    bossBotId: a,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!.id;
  host = new BotSessionHost({
    bots,
    chats,
    runtime,
    emit: () => {},
    authority: new SourceAuthorityRegistry({ registryFile: join(root, 'registry.json') }),
    budget: { prepare, verdict: () => null },
  });
  group = new GroupChatService({
    bots,
    chats,
    host,
    emit: () => {},
    onBatchSettled: settled,
    responder: { timeoutMs: () => 1000, select, next: async () => ({ end: true as const }) },
  });
});
afterEach(() => {
  group.dispose();
  host.dispose();
  rmSync(root, { recursive: true, force: true });
});

it.each([true, false])(
  'mixed targets steer the primary and parallel members and start the idle member (mentions=%s)',
  async (mentions) => {
    await group.send(chatId, '@Alice start');
    await group.send(chatId, '@Bob parallel');
    select.mockResolvedValueOnce({ ids: [a, b, c] });
    await group.send(chatId, mentions ? '@Alice @Bob @Carol supplement' : 'supplement');
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(3));
    expect(runtime.steer.mock.calls.map(([id]) => id)).toEqual([session(a), session(b)]);
    expect(runtime.steer.mock.calls.every(([, text]) => text.includes('supplement'))).toBe(true);
    expect(host.queueState()).toEqual([]);
    expect(runtime.abort).not.toHaveBeenCalled();
    done(a, 'primary');
    done(b, 'parallel');
    done(c, 'idle');
    await group.settled(chatId);
    expect(replies().map((entry) => entry.text)).toEqual(['primary', 'parallel', 'idle']);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(runtime.prompt).toHaveBeenCalledTimes(3);
  }
);

it.each([true, false])(
  'a message delivered across primary completion starts exactly once and keeps its result (mentions=%s)',
  async (mentions) => {
    await group.send(chatId, '@Alice start');
    select.mockResolvedValueOnce({ ids: [a] });
    let resume!: () => void;
    prepare.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        })
    );
    const send = group.send(chatId, mentions ? '@Alice supplement' : 'supplement');
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    done(a, 'old result');
    resume();
    await send;
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(2));
    await group.settled(chatId);
    done(a, 'new result');
    await group.settled(chatId);
    expect(replies().map((entry) => entry.text)).toEqual(['old result', 'new result']);
    expect(runtime.steer).not.toHaveBeenCalled();
    expect(runtime.prompt).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledTimes(1);
  }
);

it('smart routing sees busy members with the message each is working on', async () => {
  const busyOf = (call: number) => {
    const [input] = select.mock.calls[call] as unknown as [SmartRouteInput];
    return Object.fromEntries(input.candidates.map((cand) => [cand.id, cand.busy?.task]));
  };
  await group.send(chatId, '@Alice pull the reference projects');
  select.mockResolvedValueOnce({ ids: [b] });
  await group.send(chatId, 'check open issues');
  await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(2));
  expect(busyOf(0)).toEqual({
    [a]: '@Alice pull the reference projects',
    [b]: undefined,
    [c]: undefined,
  });
  select.mockResolvedValueOnce({ ids: [c] });
  await group.send(chatId, 'and review the PRs');
  await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(3));
  expect(busyOf(1)).toEqual({
    [a]: '@Alice pull the reference projects',
    [b]: 'check open issues',
    [c]: undefined,
  });
  done(a, 'pulled');
  done(b, 'issues');
  done(c, 'prs');
  await group.settled(chatId);
  select.mockResolvedValueOnce({ ids: [a] });
  await group.send(chatId, 'next');
  await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(3));
  expect(busyOf(2)).toEqual({ [a]: undefined, [b]: undefined, [c]: undefined });
});

it('completion immediately after steer does not create another turn or leave a pending reply', async () => {
  await group.send(chatId, '@Alice start');
  runtime.steer.mockImplementationOnce((id, _text, _images, deliveryId) => {
    received(id, deliveryId!);
    done(a, 'combined result');
    return { ok: true };
  });
  await group.send(chatId, '@Alice supplement');
  await group.settled(chatId);
  expect(replies().map((entry) => entry.text)).toEqual(['combined result']);
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
  expect(runtime.steer).toHaveBeenCalledTimes(1);
  expect(settled).toHaveBeenCalledTimes(1);
});

const notices = () =>
  chats
    .readEntries(chatId)
    .filter((entry) => entry.kind === 'system')
    .map((entry) => entry.text);

it('a separate task routed to a busy member waits for its own turn instead of steering', async () => {
  await group.send(chatId, '@Alice pull the reference projects');
  select.mockResolvedValueOnce({ ids: [a], intent: 'build', separate: true });
  await group.send(chatId, 'check open issues');
  await vi.waitFor(() => expect(notices()).toContain('Alice 正在忙，这条新任务排在当前任务之后'));
  expect(runtime.steer).not.toHaveBeenCalled();
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
  done(a, 'pulled');
  await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(2));
  expect(runtime.prompt.mock.calls[1][1]).toContain('check open issues');
  done(a, 'issues');
  await group.settled(chatId);
  expect(replies().map((entry) => entry.text)).toEqual(['pulled', 'issues']);
});

it('a steer waiting for the current step says it will be inserted, not queued', async () => {
  await group.send(chatId, '@Alice start');
  runtime.steer.mockImplementationOnce(() => ({ ok: true }));
  select.mockResolvedValueOnce({ ids: [a] });
  await group.send(chatId, 'also the changelog');
  await vi.waitFor(() => expect(runtime.steer).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(notices()).toContain('Alice 正在忙，这条补充会在当前步骤结束后插入')
  );
  expect(notices().some((text) => text.includes('正在排队'))).toBe(false);
});

it('steers a lone parallel member after the primary has finished', async () => {
  await group.send(chatId, '@Alice start');
  await group.send(chatId, '@Bob parallel');
  done(a, 'primary');
  await group.settled(chatId);
  select.mockResolvedValueOnce({ ids: [b] });
  await group.send(chatId, 'supplement');
  await vi.waitFor(() => expect(runtime.steer).toHaveBeenCalledTimes(1));
  expect(runtime.steer.mock.calls[0][0]).toBe(session(b));
  expect(runtime.prompt).toHaveBeenCalledTimes(2);
  done(b, 'combined');
  await group.settled(chatId);
  expect(replies().map((entry) => entry.text)).toEqual(['primary', 'combined']);
  expect(settled).toHaveBeenCalledTimes(1);
});

it('steering the primary among multiple targets preserves its original relay queue', async () => {
  await group.send(chatId, '@Alice @Carol start');
  await group.send(chatId, '@Alice @Bob supplement');
  expect(group.state(chatId)).toMatchObject({ current: a, queue: [c] });
  expect(runtime.steer.mock.calls.map(([id]) => id)).toEqual([session(a)]);
  expect(runtime.prompt).toHaveBeenCalledTimes(2);
  done(b, 'parallel');
  done(a, 'primary');
  await group.settled(chatId);
  expect(runtime.prompt).toHaveBeenCalledTimes(3);
  expect(runtime.prompt.mock.calls[2][0]).toBe(session(c));
  done(c, 'relay');
  await group.settled(chatId);
  expect(replies().map((entry) => entry.text)).toEqual(['parallel', 'primary', 'relay']);
  expect(settled).toHaveBeenCalledTimes(1);
});

it('a capacity-queued supplement becomes steer and no longer waits for a separate completion', async () => {
  host.setMaxRunningTurns(1);
  await group.send(chatId, '@Alice start');
  await group.send(chatId, '@Bob queued');
  await group.send(chatId, '@Bob supplement');
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
  done(a, 'primary');
  await vi.waitFor(() => expect(runtime.steer).toHaveBeenCalledTimes(1));
  expect(runtime.prompt).toHaveBeenCalledTimes(2);
  expect(runtime.steer.mock.calls[0][1]).toContain('supplement');
  done(b, 'combined');
  await group.settled(chatId);
  expect(replies().map((entry) => entry.text)).toEqual(['primary', 'combined']);
  expect(settled).toHaveBeenCalledTimes(1);
  expect(host.queueState()).toEqual([]);
});

it('a queued steer rechecks activity after acquiring the session lock', async () => {
  host.setMaxRunningTurns(1);
  await group.send(chatId, '@Alice start');
  await group.send(chatId, '@Bob queued');
  await group.send(chatId, '@Bob supplement');
  runtime.prompt.mockImplementationOnce(() => {
    done(b, 'first Bob result');
    return { ok: true };
  });
  done(a, 'primary');
  await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(3));
  expect(runtime.steer).not.toHaveBeenCalled();
  await group.settled(chatId);
  done(b, 'second Bob result');
  await group.settled(chatId);
  expect(replies().map((entry) => entry.text)).toEqual([
    'primary',
    'first Bob result',
    'second Bob result',
  ]);
  expect(settled).toHaveBeenCalledTimes(1);
});

it('queues rather than steers after authoritative idle while awaiting turn-completed', async () => {
  await group.send(chatId, '@Alice start');
  for (const status of ['running', 'idle'] as const)
    host.observe({
      seq: ++turn,
      identity: { sessionId: session(a), generation: 'g' },
      type: 'status',
      status,
    } as AgentWorkerEvent);
  await group.send(chatId, '@Alice supplement');
  expect(runtime.steer).not.toHaveBeenCalled();
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
  done(a, 'old result');
  await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(2));
  await group.settled(chatId);
  done(a, 'new result');
  await group.settled(chatId);
  expect(replies().map((entry) => entry.text)).toEqual(['old result', 'new result']);
  expect(settled).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  'worker idle receipt re-admits an unconsumed supplement once (completion first=%s)',
  async (completionFirst) => {
    await group.send(chatId, '@Alice start');
    runtime.steer.mockReturnValueOnce({ ok: true });
    await group.send(chatId, '@Alice supplement');
    await group.settled(chatId);
    const [id, , , deliveryId] = runtime.steer.mock.calls[0]!;
    const before = chats.get(chatId)?.sessions[a]?.cursor;
    expect(settled).not.toHaveBeenCalled();
    if (completionFirst) done(a, 'original');
    host.observe({
      type: 'delivery-deferred',
      identity: { sessionId: id, generation: 'g' },
      seq: ++turn,
      deliveryId: deliveryId!,
    });
    if (!completionFirst) {
      expect(chats.get(chatId)?.sessions[a]?.cursor).toBe(before);
      expect(runtime.prompt).toHaveBeenCalledTimes(1);
      done(a, 'original');
    }
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(2));
    await group.settled(chatId);
    done(a, 'supplement reply');
    await group.settled(chatId);
    expect(replies().map((entry) => entry.text)).toEqual(['original', 'supplement reply']);
    expect(runtime.steer).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
  }
);

it('an input hook consumption receipt arriving after completion settles the group batch', async () => {
  await group.send(chatId, '@Alice original');
  runtime.steer.mockReturnValueOnce({ ok: true });
  await group.send(chatId, '@Alice handled by input hook');
  done(a, 'original result');
  await group.settled(chatId);
  expect(settled).not.toHaveBeenCalled();
  const [id, , , deliveryId] = runtime.steer.mock.calls[0]!;
  received(id, deliveryId!);
  await group.settled(chatId);
  expect(settled).toHaveBeenCalledTimes(1);
  expect(runtime.prompt).toHaveBeenCalledTimes(1);
});

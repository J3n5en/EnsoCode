import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import { BotSessionHost, type BotTurnFinished } from './botSessionHost';
import {
  type BotProbeResult,
  bindBotHarness,
  bot,
  bots,
  chats,
  cleanupBotHarness,
  direct,
  ev,
  events,
  flush,
  registry,
  resetBotHarness,
  runtime,
} from './botSessionHost.testUtils';

let host: BotSessionHost;
let probeResult: BotProbeResult;
bindBotHarness({
  get host() {
    return host;
  },
  set host(value) {
    host = value;
  },
  get probeResult() {
    return probeResult;
  },
  set probeResult(value) {
    probeResult = value;
  },
});

beforeEach(() => {
  resetBotHarness();
});
afterEach(() => {
  cleanupBotHarness();
});

describe('BotSessionHost budget gate', () => {
  function budgeted(over: Set<string>) {
    const checked: string[] = [];
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      budget: {
        prepare: async (botId) => {
          checked.push(botId);
        },
        verdict: (botId) => (over.has(botId) ? 'tokens' : null),
      },
    });
    return checked;
  }

  it('rejects a delivery before it reaches the worker and announces it', async () => {
    const over = new Set<string>();
    budgeted(over);
    const alice = bot('Alice');
    const chat = direct(alice.id);
    over.add(alice.id);
    expect(await host.deliver(chat.id, alice.id, 'hi')).toEqual({
      ok: false,
      error: 'budget-exceeded',
    });
    expect(runtime.spawns).toHaveLength(0);
    expect(runtime.prompts).toHaveLength(0);
    expect(events).toContainEqual({ kind: 'budget', chatId: chat.id });
  });

  it('checks a delegation child against the target member', async () => {
    const over = new Set<string>();
    const checked = budgeted(over);
    const alice = bot('Alice');
    const bob = bot('Bob');
    const chat = direct(alice.id);
    const parent = host.ensureSession(chat.id, alice.id);
    if (!parent.ok) throw new Error(parent.error);
    const projectId = registry.conversation(parent.conversationId)!.projectId;
    const child = registry.createBotConversation(projectId, {
      botId: bob.id,
      chatId: null,
      delegationId: 'd1',
    })!;
    expect(host.registerDelegation(child.conversationId, bob)).toBe(true);
    over.add(bob.id);
    expect(await host.deliverConversation(child.conversationId, 'task')).toEqual({
      ok: false,
      error: 'budget-exceeded',
    });
    expect(checked).toEqual([bob.id]);
  });

  it('settles a queued delivery with the budget error when it would start', async () => {
    const over = new Set<string>();
    budgeted(over);
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const first = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!first.ok) throw new Error(first.error);
    await host.deliver(chat.id, alice.id, 'routine', { queueIfBusy: true, deliveryId: 'r' });
    over.add(alice.id);
    host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    await flush();
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first']);
    expect(results.at(-1)).toMatchObject({ deliveryId: 'r', ok: false, error: 'budget-exceeded' });
  });

  it('stops the running turn once a finished assistant message pushes usage over the cap', async () => {
    const over = new Set<string>();
    budgeted(over);
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const sent = await host.deliver(chat.id, alice.id, 'work', { deliveryId: 'w' });
    if (!sent.ok) throw new Error(sent.error);
    host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
    const upsert = (index: number) =>
      host.observe(
        ev(
          {
            type: 'message-upsert',
            index,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'step' }],
              stopReason: 'toolUse',
              usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
            },
          },
          sent.conversationId
        )
      );
    upsert(1);
    await flush();
    expect(runtime.aborted).toEqual([]);
    over.add(alice.id);
    upsert(3);
    await flush();
    await flush();
    expect(runtime.aborted).toEqual([sent.conversationId]);
    expect(results).toMatchObject([{ deliveryId: 'w', ok: false, error: 'budget-exceeded' }]);
    expect(events).toContainEqual({ kind: 'budget', chatId: chat.id });
    expect(host.isBusy(sent.conversationId)).toBe(false);
  });
});

describe('BotSessionHost budget reservation and per-turn cap', () => {
  function reserving(limit: number) {
    const asked: number[] = [];
    const recorded: Array<[string, string, number]> = [];
    let used = 0;
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      budget: {
        prepare: async () => {},
        verdict: (_botId, reserved) => {
          asked.push(reserved);
          return used + reserved >= limit ? 'tokens' : null;
        },
        record: (botId, conversationId, index, message) => {
          recorded.push([botId, conversationId, index]);
          const u = message.usage!;
          used += u.input + u.output + u.cacheRead + u.cacheWrite;
        },
      },
    });
    return { asked, recorded };
  }
  const usage = (id: string, index: number, input: number, stopReason?: string) =>
    host.observe(
      ev(
        {
          type: 'message-upsert',
          index,
          message: {
            role: 'assistant',
            content: [],
            timestamp: index,
            ...(stopReason ? { stopReason } : {}),
            usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
        id
      )
    );
  async function twoChats() {
    const alice = bot('Alice');
    const one = direct(alice.id);
    const two = direct(alice.id);
    return { alice, one, two };
  }

  it('holds 32k per running turn of the member so concurrent turns cannot all pass the cap', async () => {
    const { asked } = reserving(50_000);
    const { alice, one, two } = await twoChats();
    const first = await host.deliver(one.id, alice.id, 'a');
    if (!first.ok) throw new Error(first.error);
    expect(asked).toEqual([0]);
    host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
    // 本回合已用的部分从预留里扣掉
    usage(first.conversationId, 1, 20_000, 'toolUse');
    await flush();
    expect(asked.at(-1)).toBe(0);
    const second = await host.deliver(two.id, alice.id, 'b');
    expect(second.ok).toBe(true);
    expect(asked.at(-1)).toBe(12_000);
    host.observe(ev({ type: 'turn-completed', turnId: 't' }, first.conversationId));
    await flush();
    // 回合结束即释放；另一回合的预留仍在
    usage(second.ok ? second.conversationId : '', 1, 5_000, 'toolUse');
    await flush();
    expect(asked.at(-1)).toBe(0);
  });

  it('lets only one of two simultaneous turns start when both together would pass the cap', async () => {
    reserving(30_000);
    const { alice, one, two } = await twoChats();
    const results = await Promise.all([
      host.deliver(one.id, alice.id, 'a'),
      host.deliver(two.id, alice.id, 'b'),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(results[1]).toMatchObject({ error: 'budget-exceeded' });
    expect(runtime.prompts).toHaveLength(1);
  });

  it('caps the reservation by maxTokensPerTurn', async () => {
    const { asked } = reserving(1_000_000);
    const { alice, one, two } = await twoChats();
    bots.update(alice.id, { maxTokensPerTurn: 10_000 }, []);
    const first = await host.deliver(one.id, alice.id, 'a');
    if (!first.ok) throw new Error(first.error);
    usage(first.conversationId, 1, 4_000, 'toolUse');
    await host.deliver(two.id, alice.id, 'b');
    expect(asked.at(-1)).toBe(6_000);
  });

  it('records each finished assistant message once into the ledger, streaming parts not', async () => {
    const { recorded } = reserving(1_000_000);
    const { alice, one } = await twoChats();
    const sent = await host.deliver(one.id, alice.id, 'a');
    if (!sent.ok) throw new Error(sent.error);
    usage(sent.conversationId, 1, 10);
    host.observe(
      ev(
        {
          type: 'message-upsert',
          index: 1,
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'stop',
            timing: { stepStartMs: 1 },
            usage: { input: 15, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
        sent.conversationId
      )
    );
    expect(recorded).toEqual([]);
    usage(sent.conversationId, 1, 20, 'stop');
    expect(recorded).toEqual([[alice.id, sent.conversationId, 1]]);
  });

  it('stops a turn whose streamed usage passes maxTokensPerTurn, and resets for the next turn', async () => {
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
    });
    const alice = bot('Alice');
    bots.update(alice.id, { maxTokensPerTurn: 1_000 }, []);
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const sent = await host.deliver(chat.id, alice.id, 'a', { deliveryId: 'a' });
    if (!sent.ok) throw new Error(sent.error);
    host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
    usage(sent.conversationId, 1, 600, 'toolUse');
    usage(sent.conversationId, 3, 300);
    usage(sent.conversationId, 3, 400);
    await flush();
    expect(runtime.aborted).toEqual([]);
    usage(sent.conversationId, 3, 401);
    await flush();
    await flush();
    expect(runtime.aborted).toEqual([sent.conversationId]);
    expect(results).toEqual([
      expect.objectContaining({ deliveryId: 'a', ok: false, error: 'turn-token-limit' }),
    ]);
    expect(results[0]).not.toHaveProperty('stopped');
    const next = await host.deliver(chat.id, alice.id, 'b');
    if (!next.ok) throw new Error(next.error);
    usage(next.conversationId, 5, 900, 'toolUse');
    await flush();
    expect(runtime.aborted).toHaveLength(1);
  });

  // enso-server 是纯 Node，未处理的拒绝会让整个进程退出；worker 不回执时 release 超时 reject
  it('超额停回合时 release 失败，不留下无人处理的 Promise 拒绝', async () => {
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
    });
    const alice = bot('Alice');
    bots.update(alice.id, { maxTokensPerTurn: 1_000 }, []);
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'a');
    if (!sent.ok) throw new Error(sent.error);
    runtime.release = async (conversationId) => {
      runtime.released.push(conversationId);
      throw new Error('release timed out');
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      usage(sent.conversationId, 1, 1_001, 'toolUse');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runtime.released).toEqual([sent.conversationId]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('flags user stops but not budget stops as stopped', async () => {
    reserving(100);
    const { alice, one } = await twoChats();
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const sent = await host.deliver(one.id, alice.id, 'a');
    if (!sent.ok) throw new Error(sent.error);
    usage(sent.conversationId, 1, 200, 'toolUse');
    await flush();
    await flush();
    expect(results.at(-1)).toMatchObject({ ok: false, error: 'budget-exceeded' });
    expect(results.at(-1)).not.toHaveProperty('stopped');
  });

  it('estimates streamed output (~4 chars per token) when the provider reports usage only at the end', async () => {
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
    });
    const alice = bot('Alice');
    bots.update(alice.id, { maxTokensPerTurn: 1_000 }, []);
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'a');
    if (!sent.ok) throw new Error(sent.error);
    const stream = (text: string, args: unknown) =>
      host.observe(
        ev(
          {
            type: 'message-upsert',
            index: 1,
            // pi 的流式中间态也带 stopReason，只有 message_end 才有 completedMs
            message: {
              role: 'assistant',
              stopReason: 'stop',
              timing: { stepStartMs: 1 },
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              content: [
                { type: 'thinking', text },
                { type: 'toolCall', id: 'c', name: 'write', arguments: args },
              ],
            },
          },
          sent.conversationId
        )
      );
    stream('x'.repeat(2_000), { body: 'y'.repeat(1_900) });
    await flush();
    expect(runtime.aborted).toEqual([]);
    stream('x'.repeat(2_000), { body: 'y'.repeat(2_100) });
    await flush();
    await flush();
    expect(runtime.aborted).toEqual([sent.conversationId]);
  });

  it('does not double count: the reported usage replaces the estimate once the message ends', async () => {
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
    });
    const alice = bot('Alice');
    bots.update(alice.id, { maxTokensPerTurn: 1_000 }, []);
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'a');
    if (!sent.ok) throw new Error(sent.error);
    host.observe(
      ev(
        {
          type: 'message-upsert',
          index: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(2_800) }] },
        },
        sent.conversationId
      )
    );
    usage(sent.conversationId, 1, 300, 'toolUse');
    usage(sent.conversationId, 3, 600, 'toolUse');
    await flush();
    expect(runtime.aborted).toEqual([]);
  });

  describe('OpenAI-compatible stream without usage until message_end', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const meta = (id: string, used: number) =>
      host.observe(ev({ type: 'session-meta', occupancy: { used } }, id));
    const stream = (
      id: string,
      index: number,
      text: string,
      reported: Partial<typeof zero> = {},
      final = false
    ) =>
      host.observe(
        ev(
          {
            type: 'message-upsert',
            index,
            message: {
              role: 'assistant',
              stopReason: 'stop',
              timing: final ? { stepStartMs: 1, completedMs: 2 } : { stepStartMs: 1 },
              usage: { ...zero, ...reported },
              content: [{ type: 'text', text }],
            },
          },
          id
        )
      );
    async function cappedTurn(cap?: number) {
      if (cap === undefined) reserving(10_000);
      else
        host = new BotSessionHost({
          bots,
          chats,
          authority: registry,
          runtime,
          emit: (event) => events.push(event),
        });
      const alice = bot('Alice');
      if (cap !== undefined) bots.update(alice.id, { maxTokensPerTurn: cap }, []);
      const chat = direct(alice.id);
      const results: BotTurnFinished[] = [];
      host.onTurnFinished((event) => results.push(event));
      const sent = await host.deliver(chat.id, alice.id, 'write a long essay');
      if (!sent.ok) throw new Error(sent.error);
      host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
      return { id: sent.conversationId, results };
    }

    it('stops mid-stream once context + streamed Chinese text passes the cap', async () => {
      const { id, results } = await cappedTurn(3_000);
      meta(id, 2_000);
      stream(id, 1, '字'.repeat(1_200));
      await flush();
      expect(runtime.aborted).toEqual([]);
      stream(id, 1, '字'.repeat(1_800));
      await flush();
      await flush();
      expect(runtime.aborted).toEqual([id]);
      expect(results).toEqual([
        expect.objectContaining({ ok: false, error: 'turn-token-limit', estimated: true }),
      ]);
    });

    it('trusts reported usage over the estimate and only flags estimated stops', async () => {
      const { id, results } = await cappedTurn(3_000);
      meta(id, 2_900);
      stream(id, 1, '字'.repeat(1_200), { input: 1_000 });
      await flush();
      expect(runtime.aborted).toEqual([]);
      stream(id, 1, '字'.repeat(1_200), { input: 1_000, output: 300 }, true);
      meta(id, 2_400);
      await flush();
      expect(runtime.aborted).toEqual([]);
      stream(id, 3, 'ok', { input: 2_500, output: 10 }, true);
      await flush();
      await flush();
      expect(runtime.aborted).toEqual([id]);
      expect(results[0]).toMatchObject({ error: 'turn-token-limit' });
      expect(results[0]).not.toHaveProperty('estimated');
    });

    it('does not stop a normal short turn', async () => {
      const { id, results } = await cappedTurn(3_000);
      meta(id, 2_000);
      stream(id, 1, '你好，我是 Alice。');
      stream(id, 1, '你好，我是 Alice。', { input: 2_050, output: 12 }, true);
      host.observe(ev({ type: 'turn-completed', turnId: 't' }, id));
      await flush();
      expect(runtime.aborted).toEqual([]);
      expect(results).toEqual([expect.objectContaining({ ok: true })]);
    });

    it('checks the daily budget while streaming with the same estimate', async () => {
      const { id, results } = await cappedTurn();
      meta(id, 2_000);
      stream(id, 1, 'a'.repeat(4_000));
      await flush();
      expect(runtime.aborted).toEqual([]);
      stream(id, 1, 'a'.repeat(40_000));
      await flush();
      await flush();
      expect(runtime.aborted).toEqual([id]);
      expect(results).toEqual([expect.objectContaining({ ok: false, error: 'budget-exceeded' })]);
    });
  });
});

describe('BotSessionHost silence watchdog', () => {
  let clock: number;
  const make = () => {
    clock = 1_000;
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      silenceMs: 90_000,
      now: () => clock,
    });
  };
  const silenceEvents = () => events.filter((event) => event.kind === 'silence');

  it('defaults to 5 minutes so long quiet commands are not flagged early', async () => {
    clock = 1_000;
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      now: () => clock,
    });
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'sleep');
    if (!sent.ok) throw new Error(sent.error);
    host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
    clock += 299_000;
    host.checkSilence();
    expect(host.silences()).toEqual([]);
    clock += 2_000;
    host.checkSilence();
    expect(host.silences()).toHaveLength(1);
  });

  it('flags a running turn after 90s without output and clears it when output resumes', async () => {
    make();
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'sleep');
    if (!sent.ok) throw new Error(sent.error);
    host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
    clock += 89_000;
    host.checkSilence();
    expect(host.silences()).toEqual([]);
    clock += 2_000;
    host.checkSilence();
    host.checkSilence();
    expect(host.silences()).toEqual([
      { conversationId: sent.conversationId, chatId: chat.id, botId: alice.id, since: 1_000 },
    ]);
    expect(silenceEvents()).toEqual([
      { kind: 'silence', chatId: chat.id, conversationId: sent.conversationId },
    ]);
    // 子代理进度也算输出
    host.observe({
      type: 'tool-output',
      seq: 2,
      toolCallId: 'x',
      output: '.',
      identity: {
        sessionId: `${sent.conversationId}::c1`,
        generation: 'g',
        parent: { sessionId: sent.conversationId, generation: 'g' },
        instanceId: 'c1',
        instanceName: 'c1',
        typeKey: 'general',
      },
    } as unknown as AgentWorkerEvent);
    expect(host.silences()).toEqual([]);
    expect(silenceEvents()).toHaveLength(2);
    clock += 90_000;
    host.checkSilence();
    expect(host.silences()).toHaveLength(1);
    host.observe(ev({ type: 'turn-completed', turnId: 't' }, sent.conversationId));
    expect(host.silences()).toEqual([]);
    expect(silenceEvents()).toHaveLength(4);
  });

  it('does not flag a turn that is waiting for approval and restarts the clock when answered', async () => {
    make();
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'go');
    if (!sent.ok) throw new Error(sent.error);
    host.observe(
      ev({ type: 'approval-request', request: { requestId: 'r1' } }, sent.conversationId)
    );
    clock += 200_000;
    host.checkSilence();
    expect(host.silences()).toEqual([]);
    host.observe(ev({ type: 'approval-resolved', requestId: 'r1' }, sent.conversationId));
    clock += 60_000;
    host.checkSilence();
    expect(host.silences()).toEqual([]);
    clock += 31_000;
    host.checkSilence();
    expect(host.silences()).toHaveLength(1);
  });

  it('ignores idle sessions and forgets silence when the session stops', async () => {
    make();
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'go');
    if (!sent.ok) throw new Error(sent.error);
    clock += 100_000;
    host.checkSilence();
    expect(host.silences()).toHaveLength(1);
    await host.stopTurn(chat.id, alice.id);
    expect(host.silences()).toEqual([]);
    clock += 100_000;
    host.checkSilence();
    expect(host.silences()).toEqual([]);
  });
});

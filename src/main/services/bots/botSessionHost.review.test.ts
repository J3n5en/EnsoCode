import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotSessionHost, type BotSessionHostDeps, type BotTurnFinished } from './botSessionHost';
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
  type FakeRuntime,
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

describe('BotSessionHost 审查：worker 退出后的准备任务异常收口', () => {
  it.each(['spawn', 'prompt', 'retry'] as const)(
    '%s 抛错后不遗留无人负责的运行槽',
    async (stage) => {
      const alice = bot('Alice');
      const chat = direct(alice.id);
      const first = await host.deliver(chat.id, alice.id, 'first');
      if (!first.ok) throw new Error(first.error);
      const id = first.conversationId;
      host.observe(ev({ type: 'status', status: 'running' }, id));
      host.observe(ev({ type: 'turn-completed', turnId: 'first' }, id));
      await flush();
      host.dispose();
      host = new BotSessionHost({
        bots,
        chats,
        authority: registry,
        runtime,
        emit: (event) => events.push(event),
        probe: async () => {
          host.observe({ type: 'worker-exited' });
          return { ok: true };
        },
      });
      if (stage === 'spawn')
        runtime.spawn = async () => {
          throw new Error('spawn exception');
        };
      if (stage === 'prompt')
        runtime.prompt = () => {
          throw new Error('prompt exception');
        };
      if (stage === 'retry')
        Object.assign(runtime, {
          retry: () => {
            throw new Error('retry exception');
          },
        });
      try {
        const sending =
          stage === 'retry' ? host.retryConversation(id) : host.deliver(chat.id, alice.id, 'again');
        // 接受接口返回失败或 reject；无论如何不能把并发位永久留给已退出的准备任务。
        await sending.catch(() => undefined);
        expect(host.runningCount()).toBe(0);
        expect(host.isBusy(id)).toBe(false);
      } finally {
        host.dispose();
      }
    }
  );
});

describe('BotSessionHost 准备阶段各出口统一收口', () => {
  it('探测同步抛错：投递按失败返回、不占运行槽，之后的投递照常发出', async () => {
    let throwing = true;
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      probe: (() => {
        if (throwing) throw new Error('probe exception');
        return Promise.resolve({ ok: true as const });
      }) as BotSessionHostDeps['probe'],
    });
    const alice = bot('Alice');
    const chat = direct(alice.id);
    expect(await host.deliver(chat.id, alice.id, 'first')).toEqual({
      ok: false,
      error: 'probe exception',
    });
    expect(host.runningCount()).toBe(0);
    throwing = false;
    expect(await host.deliver(chat.id, alice.id, 'again')).toMatchObject({ ok: true });
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['again']);
    expect(host.runningCount()).toBe(1);
  });

  it('排队投递出队后 prompt 抛错：按失败结算一次、让出运行槽，并放出后面的排队投递', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    await host.deliver(chat.id, alice.id, 'second', { queueIfBusy: true, deliveryId: 'q2' });
    await host.deliver(chat.id, alice.id, 'third', { queueIfBusy: true, deliveryId: 'q3' });
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const prompt = runtime.prompt.bind(runtime);
    let thrown = false;
    runtime.prompt = (...args: Parameters<FakeRuntime['prompt']>) => {
      if (!thrown) {
        thrown = true;
        throw new Error('prompt exception');
      }
      return prompt(...args);
    };
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    for (let i = 0; i < 6; i++) await flush();
    expect(finished.map(({ ok, error, deliveryId }) => ({ ok, error, deliveryId }))).toEqual([
      { ok: true, error: undefined, deliveryId: undefined },
      { ok: false, error: 'prompt exception', deliveryId: 'q2' },
    ]);
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first', 'third']);
    expect(host.runningCount()).toBe(1);
    host.observe(ev({ type: 'turn-completed', turnId: 't3' }, id));
    expect(finished).toHaveLength(3);
    expect(finished[2]).toMatchObject({ ok: true, turnId: 't3', deliveryId: 'q3' });
    expect(host.runningCount()).toBe(0);
  });

  it('排队投递出队后预算准备同步抛错：与 reject 一样按检查失败放行，不遗留占位', async () => {
    let throwing = false;
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      budget: {
        prepare: (() => {
          if (throwing) throw new Error('budget exception');
          return Promise.resolve();
        }) as NonNullable<BotSessionHostDeps['budget']>['prepare'],
        verdict: () => null,
      },
    });
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    await host.deliver(chat.id, alice.id, 'second', { queueIfBusy: true });
    throwing = true;
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    for (let i = 0; i < 6; i++) await flush();
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first', 'second']);
    expect(host.runningCount()).toBe(1);
    host.observe(ev({ type: 'turn-completed', turnId: 't2' }, first.conversationId));
    expect(host.runningCount()).toBe(0);
  });

  it('回合已发出后的步骤抛错：投递按已发出返回，槽归实例、由回合事件结算一次', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    host.onDeliverySent(() => {
      throw new Error('listener exception');
    });
    const sent = await host.deliver(chat.id, alice.id, 'hi', { deliveryId: 'h1' });
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error(sent.error);
    expect(runtime.prompts.map((item) => item.text)).toEqual(['hi']);
    expect(host.runningCount()).toBe(1);
    expect(finished).toEqual([]);
    host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, sent.conversationId));
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ok: true, turnId: 't1', deliveryId: 'h1' });
    expect(host.runningCount()).toBe(0);
  });
});

describe('BotSessionHost 审查：出队 catch 必须收口', () => {
  it('出队预算通知同步抛错只失败一次并继续派发后一条', async () => {
    let shouldThrow = false;
    host.dispose();
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => {
        if (event.kind === 'budget') {
          shouldThrow = false;
          throw new Error('budget notification failed');
        }
        events.push(event);
      },
      budget: {
        prepare: async () => {},
        verdict: () => (shouldThrow ? 'tokens' : null),
      },
    });
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    await host.deliver(chat.id, alice.id, 'second', { deliveryId: 'q2', queueIfBusy: true });
    await host.deliver(chat.id, alice.id, 'third', { deliveryId: 'q3', queueIfBusy: true });
    shouldThrow = true;
    host.observe(ev({ type: 'turn-completed', turnId: 'first' }, first.conversationId));
    for (let i = 0; i < 8; i++) await flush();
    expect(finished.filter((event) => event.deliveryId === 'q2')).toEqual([
      expect.objectContaining({ ok: false, error: 'budget notification failed' }),
    ]);
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first', 'third']);
    expect(host.runningCount()).toBe(1);
    host.observe(ev({ type: 'turn-completed', turnId: 'third' }, first.conversationId));
    expect(host.runningCount()).toBe(0);
    host.dispose();
  });
});

describe('BotSessionHost 审查：准备 await 与停止交叉', () => {
  it.each([
    ['probe', 'stop', false],
    ['probe', 'stop', true],
    ['probe', 'retire', false],
    ['probe', 'retire', true],
    ['spawn', 'stop', false],
    ['spawn', 'stop', true],
    ['spawn', 'retire', false],
    ['spawn', 'retire', true],
    ['model', 'stop', false],
    ['model', 'stop', true],
    ['model', 'retire', false],
    ['model', 'retire', true],
  ] as const)('%s 等待中 %s，抛错=%s：只结算一次且清槽', async (stage, action, throws) => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    host.observe(ev({ type: 'turn-completed', turnId: 'first' }, id));
    await flush();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered = false;
    const wait = async () => {
      entered = true;
      await gate;
      if (throws) throw new Error('preparation exception');
      return { ok: true as const };
    };
    if (stage === 'probe') {
      host.dispose();
      host = new BotSessionHost({
        bots,
        chats,
        authority: registry,
        runtime,
        emit: (event) => events.push(event),
        probe: wait,
      });
    } else if (stage === 'spawn') {
      host.observe({ type: 'worker-exited' });
      const spawn = runtime.spawn.bind(runtime);
      runtime.spawn = async (spec) => {
        await wait();
        return spawn(spec);
      };
    } else {
      bots.update(alice.id, { engine: { providerId: 'next', modelId: 'next' } }, []);
      runtime.updateEngine = wait;
    }
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const sending = host.deliver(chat.id, alice.id, 'second', { deliveryId: 'second' });
    await flush();
    expect(entered).toBe(true);
    const stopping = action === 'stop' ? host.stopTurn(chat.id, alice.id) : undefined;
    if (action === 'retire') host.retireSession(id);
    open();
    expect(await sending).toMatchObject({ ok: false });
    await stopping;
    for (let i = 0; i < 4; i++) await flush();
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first']);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ok: false, stopped: true, deliveryId: 'second' });
    expect(host.runningCount()).toBe(0);
    expect(host.isBusy(id)).toBe(false);
    host.dispose();
  });
});

describe('BotSessionHost 审查：发送成功后的记账不能被附属步骤中断', () => {
  it('模型回退通知失败后仍发出 sent，避免群游标漏推进和重复投递', async () => {
    host.dispose();
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => {
        if (event.kind === 'model-notice') throw new Error('notice failed');
        events.push(event);
      },
      probe: async () => ({
        ok: true,
        fallback: {
          model: { providerId: 'fallback', modelId: 'model' },
          label: 'fallback',
          reason: 'unavailable',
        },
      }),
    });
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent: string[] = [];
    host.onDeliverySent((event) => sent.push(event.deliveryId));
    const result = await host.deliver(chat.id, alice.id, 'task', { deliveryId: 'review47' });
    expect(result).toMatchObject({ ok: true });
    expect(runtime.prompts).toHaveLength(1);
    await host.deliver(chat.id, alice.id, 'task', { deliveryId: 'review47' });
    expect(runtime.steers).toHaveLength(0);
    expect(sent).toEqual(['review47']);
  });

  it('一个 sent 监听器抛错不能跳过后续游标监听器', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent: string[] = [];
    host.onDeliverySent(() => {
      throw new Error('first listener failed');
    });
    host.onDeliverySent((event) => sent.push(event.deliveryId));
    expect(await host.deliver(chat.id, alice.id, 'task', { deliveryId: 'review47' })).toMatchObject(
      {
        ok: true,
      }
    );
    expect(sent).toEqual(['review47']);
  });
});

describe('BotSessionHost 发出后的必做记账先于附属步骤', () => {
  it('回退提示失败时笔记已读版本照常登记：下一次投递不重复附带 <notes-updated>', async () => {
    let fallback = false;
    let snap = { version: 'v1', section: '<member-notes>\nv1\n</member-notes>', update: 'u1' };
    host.dispose();
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => {
        if (event.kind === 'model-notice') throw new Error('notice failed');
        events.push(event);
      },
      notes: { snapshot: () => snap },
      probe: async () =>
        fallback
          ? {
              ok: true,
              fallback: {
                model: { providerId: 'fallback', modelId: 'model' },
                label: 'fallback',
                reason: 'unavailable',
              },
            }
          : { ok: true },
    });
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    snap = { ...snap, version: 'v2', update: '<notes-updated>v2</notes-updated>' };
    fallback = true;
    expect(await host.deliver(chat.id, alice.id, 'second')).toMatchObject({ ok: true });
    host.observe(ev({ type: 'turn-completed', turnId: 't2' }, first.conversationId));
    await flush();
    await host.deliver(chat.id, alice.id, 'third');
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual([
      'hi',
      '<notes-updated>v2</notes-updated>\n\nsecond',
      'third',
    ]);
  });
});

describe('BotSessionHost parent-ended 只结算已发到该实例上的回合', () => {
  it('审查48：失败 spawn 的第二个拒绝晚于新轮派发，不得结算新实例', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    // Main 已连续发送 spawn + prompt；worker 的 spawn 失败先回一个拒绝。
    expect(
      await host.deliver(chat.id, alice.id, 'second', { deliveryId: 'second', queueIfBusy: true })
    ).toMatchObject({ ok: true, queued: true });
    host.observe(
      ev(
        {
          type: 'parent-rejected',
          seq: 0,
          reason: 'spawn preparation failed',
          instanceId: runtime.instanceOf(id),
        },
        id
      )
    );
    expect(finished).toHaveLength(1);
    await flush();
    expect(runtime.spawns).toHaveLength(2);
    expect(host.runningCount()).toBe(1);
    // 同 worker FIFO 不阻止 Main 在两条事件之间发新命令；旧 prompt 因无实例也回拒绝。
    host.observe(
      ev(
        {
          type: 'parent-rejected',
          seq: 0,
          reason: 'Unknown session',
          instanceId: runtime.instanceOf(id, 0),
        },
        id
      )
    );
    expect(finished).toHaveLength(1);
    expect(host.runningCount()).toBe(1);
  });

  it('worker 闲置回收（evicted）落在投递准备期间：不结算尚未发出的回合，恢复会话后照常发出并占着运行槽', async () => {
    let gate: Promise<void> | undefined;
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      probe: async () => {
        await gate;
        return { ok: true };
      },
    });
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    await flush();
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    let open!: () => void;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const sending = host.deliver(chat.id, alice.id, 'again', { deliveryId: 'a1' });
    await flush();
    expect(host.runningCount()).toBe(1);
    host.observe(
      ev({ type: 'parent-ended', reason: 'evicted', instanceId: runtime.instanceOf(id) }, id)
    );
    open();
    expect(await sending).toMatchObject({ ok: true, conversationId: id });
    expect(finished).toEqual([]);
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi', 'again']);
    expect(host.runningCount()).toBe(1);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-completed', turnId: 't2' }, id));
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ok: true, turnId: 't2', deliveryId: 'a1' });
    expect(host.runningCount()).toBe(0);
  });

  it('护栏：已发出的回合所在实例结束（parent-ended）：照旧按失败结算一次并让出运行槽', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const first = await host.deliver(chat.id, alice.id, 'hi', { deliveryId: 'h1' });
    if (!first.ok) throw new Error(first.error);
    host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
    host.observe(
      ev(
        {
          type: 'parent-ended',
          reason: 'evicted',
          instanceId: runtime.instanceOf(first.conversationId),
        },
        first.conversationId
      )
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ok: false, error: 'evicted', deliveryId: 'h1' });
    expect(host.runningCount()).toBe(0);
  });

  it('#49：吸收旧 prompt 的拒绝回声后，新实例自己的 spawn 失败仍照常结算一次', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    await host.deliver(chat.id, alice.id, 'second', { deliveryId: 'second', queueIfBusy: true });
    host.observe(
      ev(
        {
          type: 'parent-rejected',
          seq: 0,
          reason: 'spawn preparation failed',
          instanceId: runtime.instanceOf(id),
        },
        id
      )
    );
    await flush();
    expect(runtime.spawns).toHaveLength(2);
    // 第一轮那条 prompt 的回声：属于已结束的旧实例
    host.observe(
      ev(
        {
          type: 'parent-rejected',
          seq: 0,
          reason: 'Unknown session',
          instanceId: runtime.instanceOf(id, 0),
        },
        id
      )
    );
    expect(finished).toHaveLength(1);
    // 新实例的 spawn 也失败：这条才属于第二轮
    host.observe(
      ev(
        {
          type: 'parent-rejected',
          seq: 0,
          reason: 'spawn failed again',
          instanceId: runtime.instanceOf(id),
        },
        id
      )
    );
    expect(finished).toHaveLength(2);
    expect(finished[1]).toMatchObject({
      ok: false,
      deliveryId: 'second',
      error: 'spawn failed again',
    });
    expect(host.runningCount()).toBe(0);
    // 第二轮 prompt 的回声不再结算任何东西
    host.observe(
      ev(
        {
          type: 'parent-rejected',
          seq: 0,
          reason: 'Unknown session',
          instanceId: runtime.instanceOf(id, 1),
        },
        id
      )
    );
    expect(finished).toHaveLength(2);
  });

  it('#49：中止新实例而 release 未确认时，旧实例的拒绝回声不算释放完成，等真正的 parent-ended', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    await host.deliver(chat.id, alice.id, 'second', { queueIfBusy: true });
    host.observe(
      ev(
        {
          type: 'parent-rejected',
          seq: 0,
          reason: 'spawn preparation failed',
          instanceId: runtime.instanceOf(id),
        },
        id
      )
    );
    await flush();
    expect(runtime.spawns).toHaveLength(2);
    runtime.release = async (target: string) => {
      runtime.released.push(target);
      throw new Error('release timed out');
    };
    await expect(host.abortConversation(id)).rejects.toThrow('release timed out');
    expect(await host.deliver(chat.id, alice.id, 'third', { queueIfBusy: true })).toMatchObject({
      ok: true,
      queued: true,
    });
    host.observe(
      ev(
        {
          type: 'parent-rejected',
          seq: 0,
          reason: 'Unknown session',
          instanceId: runtime.instanceOf(id, 0),
        },
        id
      )
    );
    await flush();
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['first', 'second']);
    host.observe(
      ev({ type: 'parent-ended', reason: 'released', instanceId: runtime.instanceOf(id) }, id)
    );
    await flush();
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['first', 'second', 'third']);
  });

  it('#49：闲置回收时已在途的 prompt 回拒绝，晚于新实例派发也不得结算新实例的轮次', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    await flush();
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    // 'again' 发往旧实例；worker 先回收了该实例，这条 prompt 之后会因会话不在而回拒绝
    expect(await host.deliver(chat.id, alice.id, 'again', { deliveryId: 'a1' })).toMatchObject({
      ok: true,
    });
    expect(
      await host.deliver(chat.id, alice.id, 'third', { deliveryId: 'a2', queueIfBusy: true })
    ).toMatchObject({ ok: true, queued: true });
    host.observe(
      ev({ type: 'parent-ended', reason: 'evicted', instanceId: runtime.instanceOf(id) }, id)
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ok: false, deliveryId: 'a1', error: 'evicted' });
    await flush();
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi', 'again', 'third']);
    host.observe(
      ev(
        {
          type: 'parent-rejected',
          seq: 0,
          reason: 'unknown or stale session generation',
          instanceId: runtime.instanceOf(id, 0),
        },
        id
      )
    );
    expect(finished).toHaveLength(1);
    expect(host.runningCount()).toBe(1);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-completed', turnId: 't3' }, id));
    expect(finished).toHaveLength(2);
    expect(finished[1]).toMatchObject({ ok: true, deliveryId: 'a2', turnId: 't3' });
  });
});

describe('阶段13：结束事件按实例号确定归属（不靠计数推断）', () => {
  const ended = (id: string, instanceId: string | undefined, reason = 'evicted') =>
    ev({ type: 'parent-ended', reason, instanceId }, id);
  const rejected = (id: string, instanceId: string | undefined, reason: string) =>
    ev({ type: 'parent-rejected', seq: 0, reason, instanceId }, id);

  it('每次 spawn 都带新的实例号', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    host.observe(ended(id, runtime.instanceOf(id)));
    await host.deliver(chat.id, alice.id, 'again');
    const ids = runtime.spawns.map((spec) => spec.instanceId);
    expect(ids).toHaveLength(2);
    for (const instanceId of ids) expect(instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(2);
  });

  it('插话被 worker 吸收（handled，无逐条回执）后实例被回收：新实例自己的 spawn 失败照常结算', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const first = await host.deliver(chat.id, alice.id, 'hi', { deliveryId: 'h1' });
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    await host.deliver(chat.id, alice.id, 'more', { deliveryId: 'm1' });
    expect(runtime.steers).toHaveLength(1);
    host.observe(ended(id, runtime.instanceOf(id)));
    const settled = finished.length;
    expect(await host.deliver(chat.id, alice.id, 'next', { deliveryId: 'n1' })).toMatchObject({
      ok: true,
    });
    expect(runtime.spawns).toHaveLength(2);
    host.observe(rejected(id, runtime.instanceOf(id), 'spawn failed'));
    expect(finished.slice(settled)).toMatchObject([
      { ok: false, deliveryId: 'n1', error: 'spawn failed' },
    ]);
    expect(host.runningCount()).toBe(0);
  });

  it('发往旧实例的 prompt 被 worker 暂存后取消（不回任何事件）：实例结束后新实例的 spawn 失败照常结算', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    await flush();
    await host.deliver(chat.id, alice.id, 'again', { deliveryId: 'a1' });
    host.observe(ended(id, runtime.instanceOf(id), 'released'));
    expect(finished.at(-1)).toMatchObject({ ok: false, deliveryId: 'a1', error: 'released' });
    await host.deliver(chat.id, alice.id, 'next', { deliveryId: 'n1' });
    expect(runtime.spawns).toHaveLength(2);
    host.observe(rejected(id, runtime.instanceOf(id), 'spawn failed'));
    expect(finished.at(-1)).toMatchObject({ ok: false, deliveryId: 'n1', error: 'spawn failed' });
    expect(host.runningCount()).toBe(0);
  });

  it('evicted 前 abort 旁路的 idle 不是在途 prompt 的回执：旧 prompt 的拒绝晚于新实例派发也不结算新轮', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    await flush();
    const old = runtime.instanceOf(id);
    await host.deliver(chat.id, alice.id, 'again', { deliveryId: 'a1' });
    host.observe(ev({ type: 'status', status: 'idle' }, id));
    await host.abortConversation(id);
    expect(await host.deliver(chat.id, alice.id, 'third', { deliveryId: 'a3' })).toMatchObject({
      ok: true,
    });
    expect(runtime.spawns).toHaveLength(2);
    host.observe(rejected(id, old, 'Unknown session'));
    expect(finished.filter((event) => event.deliveryId === 'a3')).toEqual([]);
    expect(host.runningCount()).toBe(1);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-completed', turnId: 't3' }, id));
    expect(finished.at(-1)).toMatchObject({ ok: true, deliveryId: 'a3', turnId: 't3' });
  });

  it('不依赖到达顺序：闲置回收时在途 prompt 的拒绝晚于新实例的 running 才到，仍归旧实例', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    await flush();
    const old = runtime.instanceOf(id);
    await host.deliver(chat.id, alice.id, 'again', { deliveryId: 'a1' });
    await host.deliver(chat.id, alice.id, 'third', { deliveryId: 'a2', queueIfBusy: true });
    host.observe(ended(id, old));
    await flush();
    expect(runtime.spawns).toHaveLength(2);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(rejected(id, old, 'unknown or stale session generation'));
    expect(finished.filter((event) => event.deliveryId === 'a2')).toEqual([]);
    expect(host.runningCount()).toBe(1);
    host.observe(ev({ type: 'turn-completed', turnId: 't3' }, id));
    expect(finished.at(-1)).toMatchObject({ ok: true, deliveryId: 'a2', turnId: 't3' });
  });

  it('不依赖到达顺序：spawn 失败加旧 prompt 双拒绝，新实例 spawn 失败先于旧 prompt 拒绝到达也各归各的', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    await host.deliver(chat.id, alice.id, 'second', { deliveryId: 'second', queueIfBusy: true });
    const old = runtime.instanceOf(id);
    host.observe(rejected(id, old, 'spawn preparation failed'));
    await flush();
    expect(runtime.spawns).toHaveLength(2);
    host.observe(rejected(id, runtime.instanceOf(id), 'spawn failed again'));
    expect(finished).toMatchObject([
      { ok: false, deliveryId: 'first', error: 'spawn preparation failed' },
      { ok: false, deliveryId: 'second', error: 'spawn failed again' },
    ]);
    host.observe(rejected(id, old, 'Unknown session'));
    expect(finished).toHaveLength(2);
    expect(host.runningCount()).toBe(0);
  });

  it('不带实例号或号对不上的结束事件不结束当前实例，也不确认停止中的 release', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const first = await host.deliver(chat.id, alice.id, 'hi', { deliveryId: 'h1' });
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ended(id, undefined));
    host.observe(rejected(id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Unknown session'));
    expect(finished).toEqual([]);
    expect(host.runningCount()).toBe(1);
    runtime.release = async (target: string) => {
      runtime.released.push(target);
      throw new Error('release timed out');
    };
    await expect(host.abortConversation(id)).rejects.toThrow('release timed out');
    await host.deliver(chat.id, alice.id, 'next', { queueIfBusy: true });
    host.observe(ended(id, undefined, 'released'));
    await flush();
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi']);
    host.observe(ended(id, runtime.instanceOf(id), 'released'));
    await flush();
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi', 'next']);
  });
});

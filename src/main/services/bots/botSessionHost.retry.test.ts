import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotProfile } from '../../../shared/types/bot';
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
  FakeRuntime,
  flush,
  registry,
  resetBotHarness,
  root,
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

describe('BotSessionHost 私聊回退与重试', () => {
  class ControlRuntime extends FakeRuntime {
    rewinds: Array<{ id: string; entryId: string; restoreFiles: boolean }> = [];
    retries: string[] = [];
    rewind(id: string, entryId: string, restoreFiles: boolean) {
      this.rewinds.push({ id, entryId, restoreFiles });
      return { ok: true };
    }
    retry(id: string) {
      this.retries.push(id);
      return { ok: true };
    }
  }
  let control: ControlRuntime;
  const make = (budget?: BotSessionHostDeps['budget'], extra: Partial<BotSessionHostDeps> = {}) => {
    control = new ControlRuntime();
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime: control,
      emit: () => {},
      budget,
      ...extra,
    });
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** 同一成员、同一聊天下的两个委派子会话（同成员串行） */
  const memberChildren = () => {
    const boss = bot('Boss');
    const member = bot('Member');
    const chat = direct(boss.id);
    const parent = host.ensureSession(chat.id, boss.id);
    if (!parent.ok) throw new Error(parent.error);
    const projectId = registry.conversation(parent.conversationId)!.projectId;
    return (delegationId: string) => {
      const created = registry.createBotConversation(projectId, {
        botId: member.id,
        chatId: null,
        delegationId,
      })!;
      const origin = { parentConversationId: parent.conversationId, chatId: chat.id };
      expect(host.registerDelegation(created.conversationId, member, origin)).toBe(true);
      return created.conversationId;
    };
  };

  it('#29 worker 退出后续跑晚于结算宽限才开始：沿用本轮占位与 turnKey，不判 nothing-to-retry；同成员新委派在续跑结束后出队', async () => {
    make(undefined, { settleGraceMs: 5 });
    const child = memberChildren();
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));

    // 第一份委派在跑，worker 进程退出
    const first = child('d1');
    expect(
      await host.deliverConversation(first, 'task one', { deliveryId: 'd1', queueIfBusy: true })
    ).toMatchObject({ ok: true });
    host.observe(ev({ type: 'status', status: 'running' }, first));
    host.observe({ type: 'worker-exited' });
    expect(finished.map((event) => event.error)).toEqual(['worker-exited']);

    // 卡片上点重试：冷会话恢复后发 retry；新 worker 准备（MCP 工具加载等）超过结算宽限才 agent_start
    expect(await host.retryConversation(first, { delegation: true })).toMatchObject({ ok: true });
    expect(control.retries).toEqual([first]);
    const key = host.turnKey(first);
    expect(key).toBeTruthy();
    await sleep(30);
    expect(finished.map((event) => event.error)).toEqual(['worker-exited']);
    expect(host.turnKey(first)).toBe(key);
    host.observe(ev({ type: 'status', status: 'running' }, first));
    expect(host.turnKey(first)).toBe(key);

    // 之后发给同一成员、同一聊天的新委派：续跑在跑时排队，续跑结束后出队
    const second = child('d2');
    expect(
      await host.deliverConversation(second, 'task two', { deliveryId: 'd2', queueIfBusy: true })
    ).toMatchObject({ ok: true, queued: true });
    await sleep(30);
    expect(host.queueState()).toMatchObject([{ conversationId: second }]);
    host.observe(ev({ type: 'turn-completed', turnId: 't-retry' }, first));
    await flush();
    expect(finished.at(-1)).toMatchObject({ conversationId: first, ok: true, turnKey: key });
    expect(control.prompts.map((item) => item.text)).toEqual(['task one', 'task two']);
    expect(host.queueState()).toEqual([]);
  });

  it.each([
    ['nothing-to-retry', 'nothing-to-retry'],
    ['busy', 'session-busy'],
  ] as const)(
    'worker 回执 retry-skipped(%s)：本轮结算为 %s、释放占位并放出同成员排队',
    async (reason, error) => {
      make();
      const child = memberChildren();
      const finished: BotTurnFinished[] = [];
      host.onTurnFinished((event) => finished.push(event));
      const first = child('d1');
      expect(await host.retryConversation(first, { delegation: true })).toMatchObject({
        ok: true,
      });
      const key = host.turnKey(first);
      const second = child('d2');
      expect(
        await host.deliverConversation(second, 'task two', { deliveryId: 'd2', queueIfBusy: true })
      ).toMatchObject({ ok: true, queued: true });
      host.observe(ev({ type: 'retry-skipped', reason }, first));
      expect(finished.at(-1)).toMatchObject({
        conversationId: first,
        ok: false,
        error,
        turnKey: key,
      });
      expect(finished.at(-1)).not.toHaveProperty('stopped');
      expect(host.isBusy(first)).toBe(false);
      await flush();
      expect(control.prompts.map((item) => item.text)).toEqual(['task two']);
      expect(host.queueState()).toEqual([]);
    }
  );

  it.each(['worker-exited', 'parent-ended', 'parent-rejected', 'abort'] as const)(
    '#29 复审：retry 未见 running 时 %s 释放成员并让下一委派出队',
    async (type) => {
      make();
      const child = memberChildren();
      const first = child('review-first');
      const second = child('review-second');
      expect(await host.retryConversation(first, { delegation: true })).toMatchObject({ ok: true });
      expect(
        await host.deliverConversation(second, 'review-next', { queueIfBusy: true })
      ).toMatchObject({ ok: true, queued: true });
      if (type === 'abort') await host.abortConversation(first);
      else if (type === 'worker-exited') host.observe({ type });
      else
        host.observe(
          ev({ type, reason: 'released', instanceId: control.instanceOf(first) }, first)
        );
      await flush();
      expect(control.prompts.map((item) => item.text)).toEqual(['review-next']);
      expect(host.queueState()).toEqual([]);
    }
  );

  it('#29 复审：worker 无回执且 release 超时仍阻挡同成员，直到真实 worker-exited', async () => {
    make(undefined, { settleGraceMs: 5 });
    const child = memberChildren();
    const first = child('review-first');
    const second = child('review-second');
    expect(await host.retryConversation(first, { delegation: true })).toMatchObject({ ok: true });
    expect(
      await host.deliverConversation(second, 'review-next', { queueIfBusy: true })
    ).toMatchObject({ ok: true, queued: true });
    control.release = async () => {
      throw new Error('release timed out');
    };
    await expect(host.abortConversation(first)).rejects.toThrow('release timed out');
    await sleep(30);
    expect(control.prompts).toEqual([]);
    expect(host.queueState()).toMatchObject([{ conversationId: second }]);
    host.observe({ type: 'worker-exited' });
    await flush();
    expect(control.prompts.map((item) => item.text)).toEqual(['review-next']);
    expect(host.queueState()).toEqual([]);
  });

  it('续跑已开始后到达的 retry-skipped 不结算本轮', async () => {
    make();
    const child = memberChildren();
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const first = child('d1');
    expect(await host.retryConversation(first, { delegation: true })).toMatchObject({ ok: true });
    const key = host.turnKey(first);
    host.observe(ev({ type: 'status', status: 'running' }, first));
    host.observe(ev({ type: 'retry-skipped', reason: 'busy' }, first));
    expect(finished).toEqual([]);
    expect(host.turnKey(first)).toBe(key);
    host.observe(ev({ type: 'turn-completed', turnId: 't' }, first));
    expect(finished.at(-1)).toMatchObject({ conversationId: first, ok: true, turnKey: key });
  });

  it('普通投递的轮次不认 retry-skipped', async () => {
    make();
    const child = memberChildren();
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const first = child('d1');
    expect(
      await host.deliverConversation(first, 'task one', { deliveryId: 'd1', queueIfBusy: true })
    ).toMatchObject({ ok: true });
    host.observe(ev({ type: 'retry-skipped', reason: 'nothing-to-retry' }, first));
    expect(finished).toEqual([]);
    expect(host.isBusy(first)).toBe(true);
  });

  it('只收到 idle、按 interrupted 兜底结算后，晚到的 running 只在真实运行期间占住成员，结束即放出排队', async () => {
    make(undefined, { settleGraceMs: 5 });
    const child = memberChildren();
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const first = child('d1');
    expect(
      await host.deliverConversation(first, 'task one', { deliveryId: 'd1', queueIfBusy: true })
    ).toMatchObject({ ok: true });
    host.observe(ev({ type: 'status', status: 'running' }, first));
    host.observe(ev({ type: 'status', status: 'idle' }, first));
    await sleep(30);
    expect(finished.at(-1)).toMatchObject({
      conversationId: first,
      error: 'interrupted',
      stopped: true,
    });
    // worker 自发的新一轮（如后台任务提醒）：宿主没有占位
    host.observe(ev({ type: 'status', status: 'running' }, first));
    expect(host.turnKey(first)).toBeUndefined();
    const second = child('d2');
    expect(
      await host.deliverConversation(second, 'task two', { deliveryId: 'd2', queueIfBusy: true })
    ).toMatchObject({ ok: true, queued: true });
    host.observe(ev({ type: 'status', status: 'idle' }, first));
    await flush();
    expect(control.prompts.map((item) => item.text)).toEqual(['task one', 'task two']);
    expect(host.queueState()).toEqual([]);
  });

  it('rechecks capacity when the limit drops while a retry is preparing', async () => {
    let preparing = Promise.resolve();
    make({ prepare: () => preparing, verdict: () => null });
    host.setMaxRunningTurns(2);
    const alice = bot('Alice');
    await host.deliver(direct(alice.id).id, alice.id, 'running');
    const session = host.ensureSession(direct(alice.id).id, alice.id);
    if (!session.ok) throw new Error(session.error);
    let resume!: () => void;
    preparing = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const retry = host.retryConversation(session.conversationId);
    await flush();
    expect(host.runningCount()).toBe(1);
    host.setMaxRunningTurns(1);
    resume();
    expect(await retry).toMatchObject({ ok: true, queued: true });
    expect(control.retries).toEqual([]);
    expect(host.runningCount()).toBe(1);
    expect(host.isBusy(session.conversationId)).toBe(true);
  });

  it('冷会话先恢复（只 spawn 不 prompt）再回退；运行中拒绝', async () => {
    make();
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const session = host.ensureSession(chat.id, alice.id);
    if (!session.ok) throw new Error(session.error);
    expect(await host.rewindConversation(session.conversationId, 'e1', true)).toEqual({ ok: true });
    expect(control.spawns).toHaveLength(1);
    expect(control.prompts).toEqual([]);
    expect(control.rewinds).toEqual([
      { id: session.conversationId, entryId: 'e1', restoreFiles: true },
    ]);

    await host.deliver(chat.id, alice.id, 'go');
    expect(await host.rewindConversation(session.conversationId, 'e1', false)).toEqual({
      ok: false,
      error: 'session-busy',
    });
    expect(await host.retryConversation(session.conversationId)).toEqual({
      ok: false,
      error: 'session-busy',
    });
    expect(control.spawns).toHaveLength(1);
  });

  it('turn-failed 的 retryExhausted 透出为 BotTurnFinished.transient', async () => {
    make();
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const sent = await host.deliver(chat.id, alice.id, 'first');
    if (!sent.ok) throw new Error(sent.error);
    const id = sent.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(
      ev({ type: 'turn-failed', turnId: 't1', error: 'socket hang up', retryExhausted: true }, id)
    );
    expect(finished.at(-1)).toMatchObject({ ok: false, error: 'socket hang up', transient: true });
    expect(await host.deliver(chat.id, alice.id, 'second')).toMatchObject({ ok: true });
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-failed', turnId: 't2', error: 'boom' }, id));
    expect(finished.at(-1)).toMatchObject({ ok: false, error: 'boom' });
    expect(finished.at(-1)).not.toHaveProperty('transient');
  });

  it('重试占用回合：新 turnKey、正常结算并上报完成', async () => {
    make();
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const sent = await host.deliver(chat.id, alice.id, 'first');
    if (!sent.ok) throw new Error(sent.error);
    const id = sent.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-failed', turnId: 't1', error: 'boom' }, id));
    const firstKey = finished[0].turnKey;

    expect(await host.retryConversation(id)).toEqual({ ok: true, conversationId: id });
    expect(control.retries).toEqual([id]);
    expect(host.isBusy(id)).toBe(true);
    const retryKey = host.turnKey(id);
    expect(retryKey).toBeTruthy();
    expect(retryKey).not.toBe(firstKey);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(
      ev(
        {
          type: 'message-upsert',
          index: 3,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stopReason: 'stop',
          },
        },
        id
      )
    );
    host.observe(ev({ type: 'turn-completed', turnId: 't2' }, id));
    expect(finished.at(-1)).toMatchObject({ ok: true, text: 'done', turnKey: retryKey });
    expect(host.isBusy(id)).toBe(false);
  });

  it('worker 拒绝重试时立即释放回合', async () => {
    make();
    control.retry = () => ({ ok: false, error: 'nope' }) as never;
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const session = host.ensureSession(chat.id, alice.id);
    if (!session.ok) throw new Error(session.error);
    expect(await host.retryConversation(session.conversationId)).toEqual({
      ok: false,
      error: 'nope',
    });
    expect(host.isBusy(session.conversationId)).toBe(false);
  });

  it('委派子会话只在显式 delegation 时续跑：冷会话先恢复再 retry，结算带 delegationId', async () => {
    make();
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
    const id = child.conversationId;
    expect(await host.retryConversation(id, { delegation: true })).toEqual({
      ok: false,
      error: 'not-bot-session',
    });
    expect(host.registerDelegation(id, bob)).toBe(true);
    expect(await host.retryConversation(id)).toEqual({ ok: false, error: 'not-bot-session' });
    expect(await host.retryConversation(parent.conversationId, { delegation: true })).toEqual({
      ok: false,
      error: 'not-bot-session',
    });
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    expect(await host.retryConversation(id, { delegation: true })).toEqual({
      ok: true,
      conversationId: id,
    });
    expect(control.spawns.map((spec) => spec.conversationId)).toEqual([id]);
    expect(control.prompts).toEqual([]);
    expect(control.retries).toEqual([id]);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-completed', turnId: 't' }, id));
    expect(finished.at(-1)).toMatchObject({ conversationId: id, ok: true, delegationId: 'd1' });
  });
});

describe('BotSessionHost 讨论模式切换后重建群成员会话说明', () => {
  let discussOn = false;
  const DISCUSS = 'openly in the group';
  beforeEach(() => {
    discussOn = false;
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      discussEnabled: () => discussOn,
    });
  });
  const groupOf = (...members: BotProfile[]) => {
    const code = join(root, 'code');
    mkdirSync(code, { recursive: true });
    const project = registry.createProject({ requestId: 'p', path: code });
    if (!project.accepted) throw new Error('project');
    return chats.create({
      kind: 'group',
      title: 'g',
      members: members.map((member) => member.id),
      bossBotId: members[0].id,
      workspace: { kind: 'project', projectId: project.value.projectId },
    })!;
  };
  const sessionFile = (id: string) => join(root, `${id}.jsonl`);
  const ready = (id: string) =>
    registry.markReady(id, sessionFile(id), { providerId: 'p', modelId: 'm' });
  const complete = (id: string, turnId: string) => {
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(ev({ type: 'turn-completed', turnId }, id));
  };
  const started = async (chatId: string, botId: string, text: string) => {
    const result = await host.deliver(chatId, botId, text);
    if (!result.ok) throw new Error(result.error);
    return result.conversationId;
  };

  it('空闲群成员会话：只释放 worker、不结束会话，下次投递带 resumeFile 重启并换上新说明', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const group = groupOf(alice, bob);
    const id = await started(group.id, alice.id, 'hi');
    expect(runtime.spawns[0]).not.toHaveProperty('discussMode');
    expect(runtime.spawns[0].instructionText).not.toContain(DISCUSS);
    ready(id);
    complete(id, 't1');
    await flush();
    discussOn = true;
    await host.refreshGroupInstructions();
    expect(runtime.released).toEqual([id]);
    expect(registry.conversation(id)?.lifecycle).not.toBe('ended');
    expect(chats.get(group.id)!.sessions[alice.id].conversationId).toBe(id);
    expect(await host.deliver(group.id, alice.id, 'again')).toMatchObject({
      ok: true,
      conversationId: id,
    });
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns[1]).toMatchObject({
      conversationId: id,
      resumeFile: sessionFile(id),
      groupTasks: true,
      discussMode: true,
    });
    expect(runtime.spawns[1].instructionText).toContain(DISCUSS);
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi', 'again']);
    // 再关掉：同样重建，换回不含讨论说明的版本
    complete(id, 't2');
    await flush();
    discussOn = false;
    await host.refreshGroupInstructions();
    expect(runtime.released).toEqual([id, id]);
    await host.deliver(group.id, alice.id, 'third');
    expect(runtime.spawns).toHaveLength(3);
    expect(runtime.spawns[2]).not.toHaveProperty('discussMode');
    expect(runtime.spawns[2].instructionText).not.toContain(DISCUSS);
    expect(runtime.spawns[2].resumeFile).toBe(sessionFile(id));
  });

  it('开关与会话启动时一致、或还没起 worker 的冷会话：不重建', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const group = groupOf(alice, bob);
    discussOn = true;
    const id = await started(group.id, alice.id, 'hi');
    expect(runtime.spawns[0]).toMatchObject({ discussMode: true });
    ready(id);
    complete(id, 't1');
    await flush();
    await host.refreshGroupInstructions();
    expect(runtime.released).toEqual([]);
    await host.deliver(group.id, alice.id, 'again');
    expect(runtime.spawns).toHaveLength(1);
    const cold = host.ensureSession(group.id, bob.id);
    if (!cold.ok) throw new Error(cold.error);
    ready(cold.conversationId);
    complete(id, 't2');
    await flush();
    discussOn = false;
    await host.refreshGroupInstructions();
    // 只有起着 worker 的那个会话要换说明；冷会话下次 spawn 自然用新说明
    expect(runtime.released).toEqual([id]);
  });

  it('正在跑回合的会话等回合结束再重建；回合中的插话仍进当前回合', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const group = groupOf(alice, bob);
    const id = await started(group.id, alice.id, 'hi');
    ready(id);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    discussOn = true;
    await host.refreshGroupInstructions();
    expect(runtime.released).toEqual([]);
    await host.deliver(group.id, alice.id, 'more', { deliveryId: 'more-1' });
    expect(runtime.steers.map((steer) => steer.id)).toEqual([id]);
    host.observe(ev({ type: 'delivery-settled', deliveryId: 'more-1' }, id));
    expect(runtime.spawns).toHaveLength(1);
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    for (let i = 0; i < 5; i++) await flush();
    expect(runtime.released).toEqual([id]);
    expect(registry.conversation(id)?.lifecycle).not.toBe('ended');
    await host.deliver(group.id, alice.id, 'next');
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns[1]).toMatchObject({ conversationId: id, discussMode: true });
  });

  it('回合结束时已有排队投递：开新回合前先按新说明重建', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const group = groupOf(alice, bob);
    const id = await started(group.id, alice.id, 'hi');
    ready(id);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    discussOn = true;
    await host.refreshGroupInstructions();
    expect(await host.deliver(group.id, alice.id, 'queued', { queueIfBusy: true })).toMatchObject({
      ok: true,
      queued: true,
    });
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    for (let i = 0; i < 5; i++) await flush();
    expect(runtime.released).toEqual([id]);
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns[1]).toMatchObject({ conversationId: id, discussMode: true });
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi', 'queued']);
  });

  it('没有 sessionFile 的群成员会话不重建，免得丢上下文', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const group = groupOf(alice, bob);
    const id = await started(group.id, alice.id, 'hi');
    complete(id, 't1');
    await flush();
    discussOn = true;
    await host.refreshGroupInstructions();
    expect(runtime.released).toEqual([]);
    await host.deliver(group.id, alice.id, 'again');
    expect(runtime.spawns).toHaveLength(1);
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi', 'again']);
  });

  it('审查回归：排队投递重建时旧 worker 的 parent-ended 不得结算尚未发出的新回合', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const group = groupOf(alice, bob);
    const id = await started(group.id, alice.id, 'hi');
    ready(id);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    discussOn = true;
    await host.refreshGroupInstructions();
    await host.deliver(group.id, alice.id, 'queued', { queueIfBusy: true });
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    // 真实 releaseParentSession 要等 parent-ended 才完成；原 FakeRuntime 没有回放此事件。
    runtime.release = async (conversationId) => {
      runtime.released.push(conversationId);
      host.observe(
        ev(
          {
            type: 'parent-ended',
            reason: 'released',
            instanceId: runtime.instanceOf(conversationId),
          },
          conversationId
        )
      );
    };
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    for (let i = 0; i < 8; i++) await flush();
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi', 'queued']);
    expect.soft(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ok: true, turnId: 't1' });
    expect.soft(host.runningCount()).toBe(1);
  });

  it('排队投递重建时 worker 退出：新回合不按 worker-exited 结算，换新 worker 后照常发出且只结算一次', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const group = groupOf(alice, bob);
    const id = await started(group.id, alice.id, 'hi');
    ready(id);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    discussOn = true;
    await host.refreshGroupInstructions();
    await host.deliver(group.id, alice.id, 'queued', { queueIfBusy: true, deliveryId: 'q1' });
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    // 真实 agentHost：worker 退出不唤醒 release 等待者，等到超时才抛错
    runtime.release = async (conversationId) => {
      runtime.released.push(conversationId);
      host.observe({ type: 'worker-exited' });
      throw new Error('release timed out');
    };
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    for (let i = 0; i < 8; i++) await flush();
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ ok: true, turnId: 't1' });
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns[1]).toMatchObject({ conversationId: id, discussMode: true });
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi', 'queued']);
    expect(host.runningCount()).toBe(1);
    complete(id, 't2');
    expect(finished).toHaveLength(2);
    expect(finished[1]).toMatchObject({ ok: true, turnId: 't2', deliveryId: 'q1' });
    expect(host.runningCount()).toBe(0);
  });

  it('重建的 release 失败（worker 未退出）时这条投递只失败一次；之后的直接投递自己重建，旧实例的 parent-ended 不结算它', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const group = groupOf(alice, bob);
    const id = await started(group.id, alice.id, 'hi');
    ready(id);
    host.observe(ev({ type: 'status', status: 'running' }, id));
    discussOn = true;
    await host.refreshGroupInstructions();
    await host.deliver(group.id, alice.id, 'queued', { queueIfBusy: true, deliveryId: 'q1' });
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const release = runtime.release.bind(runtime);
    runtime.release = async (conversationId) => {
      runtime.released.push(conversationId);
      throw new Error('release timed out');
    };
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    for (let i = 0; i < 8; i++) await flush();
    expect(finished).toHaveLength(2);
    expect(finished[1]).toMatchObject({ ok: false, error: 'release timed out', deliveryId: 'q1' });
    expect(host.runningCount()).toBe(0);
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi']);
    runtime.release = release;
    await host.deliver(group.id, alice.id, 'again');
    expect(runtime.released).toEqual([id, id]);
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns[1]).toMatchObject({ conversationId: id, discussMode: true });
    expect(runtime.prompts.map((prompt) => prompt.text)).toEqual(['hi', 'again']);
    expect(finished).toHaveLength(2);
    expect(host.runningCount()).toBe(1);
  });

  it.each(['stop', 'retire'] as const)(
    '重建 release 等待中 %s：不再 prompt 且仅结算一次',
    async (action) => {
      const alice = bot('Alice');
      const group = groupOf(alice, bot('Bob'));
      const id = await started(group.id, alice.id, 'first');
      ready(id);
      complete(id, 'first');
      await flush();
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const release = runtime.release.bind(runtime);
      let entered = false;
      runtime.release = async (conversationId) => {
        entered = true;
        await gate;
        return release(conversationId);
      };
      const finished: BotTurnFinished[] = [];
      host.onTurnFinished((event) => finished.push(event));
      discussOn = true;
      const sending = host.deliver(group.id, alice.id, 'second', { deliveryId: 'second' });
      await flush();
      expect(entered).toBe(true);
      const stopping = action === 'stop' ? host.stopTurn(group.id, alice.id) : undefined;
      if (action === 'retire') host.retireSession(id);
      open();
      expect(await sending).toMatchObject({ ok: false });
      await stopping;
      for (let i = 0; i < 4; i++) await flush();
      expect(runtime.prompts.map((item) => item.text)).toEqual(['first']);
      expect(finished).toHaveLength(1);
      expect(host.runningCount()).toBe(0);
      host.dispose();
    }
  );

  it('私聊与委派子会话不受影响', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const chat = direct(alice.id);
    const privateId = await started(chat.id, alice.id, 'hi');
    ready(privateId);
    complete(privateId, 't1');
    const child = registry.createBotConversation(registry.conversation(privateId)!.projectId, {
      botId: bob.id,
      chatId: null,
      delegationId: 'd1',
    })!;
    expect(host.registerDelegation(child.conversationId, bob)).toBe(true);
    const sent = await host.deliverConversation(child.conversationId, 'task');
    if (!sent.ok) throw new Error(sent.error);
    ready(child.conversationId);
    complete(child.conversationId, 't2');
    await flush();
    discussOn = true;
    await host.refreshGroupInstructions();
    expect(runtime.released).toEqual([]);
    await host.deliver(chat.id, alice.id, 'again');
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns.every((spec) => !spec.discussMode)).toBe(true);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import { BotSessionHost } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { DelegationService } from './delegationService';
import { DelegationStore } from './delegationStore';
import type { MemberTaskClassifier } from './memberTaskClassifier';

let root: string;
beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'delegate-service-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
function fixture(
  autoStart = true,
  over = new Set<string>(),
  classifyMemberTask?: MemberTaskClassifier
) {
  const bots = new BotStore(join(root, 'bots'));
  const a = bots.create({ name: 'Alice' }, []),
    b = bots.create({ name: 'Bob' }, []);
  if (!a.ok || !b.ok) throw new Error('bots');
  const chats = new BotChatStore(join(root, 'chats'));
  const chat = chats.create({
    kind: 'direct',
    title: '',
    members: [a.bot.id],
    bossBotId: null,
    workspace: { kind: 'member-home' },
  })!;
  const authority = new SourceAuthorityRegistry({ registryFile: join(root, 'authority.json') });
  const prompts: Array<{ id: string; text: string; deliveryId?: string }> = [];
  const retries: string[] = [];
  const badSpawn = new Set<string>();
  const abort = vi.fn();
  const running = (id: string) =>
    queueMicrotask(() => {
      host.observe({
        type: 'status',
        status: 'running',
        identity: { sessionId: id, generation: 'g' },
        seq: 1,
      });
      // 与 ipc/bots.ts 的 worker 事件分发一致
      service.observeRunning(id);
    });
  const host = new BotSessionHost({
    bots,
    chats,
    authority,
    emit: () => {},
    classifyMemberTask,
    budget: { prepare: async () => {}, verdict: (botId) => (over.has(botId) ? 'tokens' : null) },
    runtime: {
      spawn: async (spec) =>
        badSpawn.has(spec.conversationId) ? { ok: false, error: 'bad-session' } : { ok: true },
      prompt: (id, text, _images, deliveryId) => {
        prompts.push({ id, text, deliveryId });
        if (autoStart) running(id);
        return { ok: true };
      },
      retry: (id) => {
        retries.push(id);
        if (autoStart) running(id);
        return { ok: true };
      },
      steer: () => ({ ok: true }),
      release: async () => {},
      abort,
      removeSessionFiles: () => {},
    },
  });
  const parent = host.ensureSession(chat.id, a.bot.id);
  if (!parent.ok) throw new Error(parent.error);
  const store = new DelegationStore(join(root, 'delegations.jsonl'));
  const service = new DelegationService({
    bots,
    chats,
    authority,
    host,
    store,
    emit: () => {},
    minuteMs: 1,
  });
  const finish = (id: string) =>
    host.observe({
      type: 'turn-completed',
      identity: { sessionId: id, generation: 'g' },
      seq: 1,
      turnId: 'turn',
    });
  /** 子会话已落盘（worker 报 ready 后才有 sessionFile） */
  const persist = (conversationId: string) => {
    const file = join(root, `${conversationId}.jsonl`);
    writeFileSync(file, '{}\n');
    authority.markReady(conversationId, file, { providerId: 'p', modelId: 'm' });
  };
  return {
    service,
    host,
    store,
    parent: parent.conversationId,
    prompts,
    retries,
    badSpawn,
    persist,
    finish,
    abort,
    bob: b.bot.id,
    deps: { bots, chats, authority, host, store, emit: () => {}, minuteMs: 1 },
  };
}
it('runs queued delegations at capacity one after the parent yields, then delivers their batch', async () => {
  const f = fixture();
  f.host.setMaxRunningTurns(1);
  await f.host.deliverConversation(f.parent, 'delegate and wait');
  const sent = ['one', 'two'].map((task) => f.service.delegate(f.parent, { to: 'Bob', task }));
  const records = sent.map((result) => {
    if (!result.ok) throw new Error(result.error);
    return f.store.get(result.delegationId)!;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.prompts).toHaveLength(1);
  expect(f.host.queueState().map((item) => item.reason)).toEqual(['capacity', 'member-fifo']);
  f.finish(f.parent);
  await vi.advanceTimersByTimeAsync(0);
  for (const record of records) {
    expect(f.prompts.at(-1)?.id).toBe(record.childConversationId);
    expect(f.host.runningCount()).toBe(1);
    f.finish(record.childConversationId);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(f.prompts.at(-1)?.id).toBe(f.parent);
  expect(f.prompts.at(-1)?.text).toContain('<delegation-results ');
  expect(f.prompts).toHaveLength(4);
  expect(f.host.queueState()).toEqual([]);
  expect(f.abort).not.toHaveBeenCalled();
  f.service.dispose();
});

it('truncates context, finishes once, and waits for the busy parent', async () => {
  const f = fixture();
  await f.host.deliverConversation(f.parent, 'busy');
  const sent = f.service.delegate(f.parent, {
    to: 'Bob',
    task: 'do work',
    context: 'a'.repeat(9000),
  });
  expect(sent.ok).toBe(true);
  if (!sent.ok) return;
  expect(sent.warning).toContain('8000');
  await vi.advanceTimersByTimeAsync(0);
  const record = f.store.get(sent.delegationId)!;
  expect(record.context).toHaveLength(8000);
  f.finish(record.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(record.id)?.deliveredAt).toBeUndefined();
  f.finish(f.parent);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(record.id)?.deliveredAt).toBeDefined();
  f.finish(record.childConversationId);
  f.finish(f.parent);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.prompts.filter((p) => p.text.includes('<delegation-result'))).toHaveLength(1);
  f.service.dispose();
});
it("runs delegations with the target's own capabilities and keeps the stricter approval after restore", async () => {
  const f = fixture();
  const alice = f.deps.bots.list().find((bot) => bot.name === 'Alice')!;
  const bob = f.deps.bots.list().find((bot) => bot.name === 'Bob')!;
  f.deps.bots.update(
    alice.id,
    {
      tools: 'readonly',
      approvalMode: 'supervised',
      skillIds: ['shared'],
      mcpServerIds: ['common'],
    },
    []
  );
  f.deps.bots.update(bob.id, { skillIds: ['shared', 'bob'], mcpServerIds: ['common', 'bob'] }, []);
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!first.ok) throw new Error(first.error);
  const record = f.store.get(first.delegationId)!;
  expect(record.effectivePermissions).toEqual({
    tools: 'all',
    approvalMode: 'supervised',
    skillIds: ['shared', 'bob'],
    mcpServerIds: ['common', 'bob'],
  });
  await vi.advanceTimersByTimeAsync(0);
  const carol = f.deps.bots.create(
    { name: 'Carol', tools: 'all', approvalMode: 'full', skillIds: ['carol'], mcpServerIds: [] },
    []
  );
  if (!carol.ok) throw new Error('carol');
  const nested = f.service.delegate(record.childConversationId, { to: 'Carol', task: 'nested' });
  if (!nested.ok) throw new Error(nested.error);
  const child = f.store.get(nested.delegationId)!;
  expect(child.effectivePermissions).toEqual({
    tools: 'all',
    approvalMode: 'supervised',
    skillIds: ['carol'],
    mcpServerIds: [],
  });
  await vi.advanceTimersByTimeAsync(0);
  f.finish(record.childConversationId);
  f.finish(child.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.host.effectiveBot(record.childConversationId)).toMatchObject(
    record.effectivePermissions!
  );
  f.service.dispose();
});
it('times out and aborts; cancellation is final', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  expect(f.store.get(sent.delegationId)?.timeoutMinutes).toBe(240);
  await vi.advanceTimersByTimeAsync(239);
  expect(f.store.get(sent.delegationId)?.state).toBe('running');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.store.get(sent.delegationId)).toMatchObject({ state: 'failed', failure: 'timeout' });
  expect(f.abort).toHaveBeenCalled();
  f.service.dispose();
});
it("caps the delegation timeout by the target's limit and lets the caller ask for less", async () => {
  const f = fixture();
  f.deps.bots.update(f.bob, { delegationTimeoutMinutes: 30 }, []);
  const capped = f.service.delegate(f.parent, { to: 'Bob', task: 'a', deadlineMinutes: 90 });
  if (!capped.ok) throw new Error(capped.error);
  expect(capped.warning).toContain('30');
  const short = f.service.delegate(f.parent, { to: 'Bob', task: 'b', deadlineMinutes: 10 });
  if (!short.ok) throw new Error(short.error);
  expect(short).not.toHaveProperty('warning');
  const plain = f.service.delegate(f.parent, { to: 'Bob', task: 'c' });
  if (!plain.ok) throw new Error(plain.error);
  expect(f.store.get(capped.delegationId)?.timeoutMinutes).toBe(30);
  expect(f.store.get(short.delegationId)?.timeoutMinutes).toBe(10);
  expect(f.store.get(plain.delegationId)?.timeoutMinutes).toBe(30);
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(f.service.delegate(f.parent, { to: 'Bob', task: 'x', deadlineMinutes: bad })).toEqual({
      ok: false,
      error: 'deadlineMinutes must be a positive number.',
    });
  // 同成员串行：每个都在开工后才按自己的期限计时
  const state = (id: string) => f.store.get(id)?.state;
  await vi.advanceTimersByTimeAsync(29);
  expect([capped, short, plain].map((r) => state(r.delegationId))).toEqual([
    'running',
    'queued',
    'queued',
  ]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.store.get(capped.delegationId)?.failure).toBe('timeout');
  expect(state(short.delegationId)).toBe('running');
  await vi.advanceTimersByTimeAsync(9);
  expect(state(short.delegationId)).toBe('running');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.store.get(short.delegationId)?.failure).toBe('timeout');
  expect(state(plain.delegationId)).toBe('running');
  await vi.advanceTimersByTimeAsync(29);
  expect(state(plain.delegationId)).toBe('running');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.store.get(plain.delegationId)?.failure).toBe('timeout');
  // 重试沿用原时限，并按目标当前上限再收紧
  f.deps.bots.update(f.bob, { delegationTimeoutMinutes: 5 }, []);
  const retried = await f.service.retry(short.delegationId);
  if (!retried.ok) throw new Error(retried.error);
  expect(f.store.get(retried.delegationId)?.timeoutMinutes).toBe(5);
  f.service.dispose();
});
it('starts the deadline only when a delegation queued behind the same member actually starts', async () => {
  const f = fixture();
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'first' });
  const second = f.service.delegate(f.parent, { to: 'Bob', task: 'second', deadlineMinutes: 90 });
  if (!first.ok || !second.ok) throw new Error('delegate');
  await vi.advanceTimersByTimeAsync(0);
  const one = f.store.get(first.delegationId)!;
  expect(one.state).toBe('running');
  expect(f.store.get(second.delegationId)?.state).toBe('queued');
  expect(f.host.queueState().map((item) => item.reason)).toEqual(['member-serial']);
  // Bob 的第一个委派跑了 120 分钟，第二个一直在同成员队列里没开工
  await vi.advanceTimersByTimeAsync(120);
  expect(f.store.get(second.delegationId)?.state).toBe('queued');
  f.finish(one.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(second.delegationId)?.state).toBe('running');
  await vi.advanceTimersByTimeAsync(89);
  expect(f.store.get(second.delegationId)?.state).toBe('running');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.store.get(second.delegationId)).toMatchObject({ state: 'failed', failure: 'timeout' });
  f.service.dispose();
});
it('disabling cancels running delegation timers and rejects subsequent delegate calls', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  f.service.disable();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.store.get(sent.delegationId)?.state).toBe('canceled');
  expect(f.abort).toHaveBeenCalled();
  expect(f.service.delegate(f.parent, { to: 'Bob', task: 'more' })).toEqual({
    ok: false,
    error: 'disabled',
  });
});
it.each(['chat', 'initiator', 'target'] as const)(
  'deleting %s cancels associated delegations and aborts their child sessions',
  async (kind) => {
    const f = fixture();
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const record = f.store.get(sent.delegationId)!;
    if (kind === 'chat') f.host.discardChat(record.chatId!);
    else f.host.discardBot(kind === 'initiator' ? record.parentBotId : record.targetBotId);
    expect(f.store.get(record.id)?.state).toBe('canceled');
    expect(f.abort).toHaveBeenCalledWith(record.childConversationId);
    f.service.dispose();
  }
);
it('marks unfinished work interrupted on restart and auto-retries it later instead of reporting it', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  f.service.dispose();
  const restarted = new DelegationService(f.deps);
  expect(f.store.get(sent.delegationId)).toMatchObject({
    state: 'failed',
    failure: 'interrupted',
    autoRetryAt: expect.any(Number),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.prompts.filter((p) => p.text.includes('<delegation-result'))).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.store.list().find((r) => r.retryOf === sent.delegationId)).toMatchObject({
    retryBy: 'auto',
  });
  expect(f.prompts.filter((p) => p.text.includes('<delegation-result'))).toHaveLength(0);
  restarted.dispose();
});

it('rejects a fourth concurrent delegation, retries with a new id, and prevents cross-parent cancellation', async () => {
  const f = fixture();
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!first.ok) throw new Error(first.error);
  expect(f.service.delegate(f.parent, { to: 'Bob', task: 'two' }).ok).toBe(true);
  expect(f.service.delegate(f.parent, { to: 'Bob', task: 'three' }).ok).toBe(true);
  expect(f.service.delegate(f.parent, { to: 'Bob', task: 'four' }).ok).toBe(false);
  expect(f.service.check('other-parent', { id: first.delegationId, cancel: true })).toMatchObject({
    ok: false,
  });
  expect(f.store.get(first.delegationId)?.state).toBe('queued');
  f.service.cancel(first.delegationId);
  expect(f.store.get(first.delegationId)?.state).toBe('canceled');
  const retried = await f.service.retry(first.delegationId, 'restart');
  expect(retried.ok && retried.delegationId).not.toBe(first.delegationId);
  await vi.advanceTimersByTimeAsync(0);
  f.service.dispose();
});

it('does not mark a result delivered while global slots are exhausted', async () => {
  const f = fixture();
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!first.ok) throw new Error(first.error);
  await vi.advanceTimersByTimeAsync(0);
  const record = f.store.get(first.delegationId)!;
  const count = vi.spyOn(f.host, 'runningCount').mockReturnValue(4);
  f.finish(record.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(record.id)?.deliveredAt).toBeUndefined();
  count.mockRestore();
  await f.service.deliverPending();
  expect(f.store.get(record.id)?.deliveredAt).toBeDefined();
  f.service.dispose();
});
it('uses delegationId and only marks delivered after the parent turn actually starts', async () => {
  const f = fixture(false);
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  f.finish(f.store.get(sent.delegationId)!.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  const results = () => f.prompts.filter((prompt) => prompt.text.includes('<delegation-result'));
  expect(results()).toMatchObject([{ deliveryId: sent.delegationId }]);
  expect(f.store.get(sent.delegationId)?.deliveredAt).toBeUndefined();
  await f.service.deliverPending();
  expect(results()).toHaveLength(1);
  f.host.observe({
    type: 'status',
    status: 'running',
    identity: { sessionId: f.parent, generation: 'g' },
    seq: 2,
  });
  expect(f.store.get(sent.delegationId)?.deliveredAt).toBeDefined();
  f.service.dispose();
});
const results = (f: ReturnType<typeof fixture>) =>
  f.prompts.filter((prompt) => prompt.text.includes('<delegation-result'));
it('重启后回传给委派父会话仍按原聊天归属，不受其他聊天的同成员活轮阻塞', async () => {
  const f = fixture(false);
  const carol = f.deps.bots.create({ name: 'Carol' }, []);
  if (!carol.ok) throw new Error('Carol');
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'outer' });
  if (!first.ok) throw new Error(first.error);
  await vi.advanceTimersByTimeAsync(0);
  const parent = f.store.get(first.delegationId)!.childConversationId;
  const nested = f.service.delegate(parent, { to: 'Carol', task: 'inner' });
  if (!nested.ok) throw new Error(nested.error);
  await vi.advanceTimersByTimeAsync(0);
  // 内层在重启前已最终失败（不可自动重试），重启后只需把它回传给外层子会话
  f.store.save({
    ...f.store.get(nested.delegationId)!,
    state: 'failed',
    failure: 'error',
    error: 'boom',
    finishedAt: Date.now(),
  });
  f.service.dispose();
  f.host.dispose();

  const classify = vi.fn<MemberTaskClassifier>(async () => 'serial');
  const prompt = vi.fn(() => ({ ok: true }));
  const host = new BotSessionHost({
    ...f.deps,
    classifyMemberTask: classify,
    runtime: {
      spawn: async () => ({ ok: true }),
      prompt,
      steer: () => ({ ok: true }),
      release: async () => {},
      removeSessionFiles: () => {},
    },
  });
  const other = f.deps.chats.create({
    kind: 'direct',
    members: [f.bob],
    bossBotId: null,
    title: '',
    workspace: { kind: 'member-home' },
  })!;
  await host.deliver(other.id, f.bob, 'busy in another chat');
  const service = new DelegationService({ ...f.deps, host });
  await service.deliverPending();
  await vi.advanceTimersByTimeAsync(0);
  expect(prompt.mock.calls).toContainEqual([
    parent,
    expect.stringContaining('<delegation-result'),
    undefined,
    expect.any(String),
  ]);
  expect(classify).not.toHaveBeenCalled();
  expect(host.queueState()).toEqual([]);
  service.dispose();
  host.dispose();
});
async function sameTurn(f: ReturnType<typeof fixture>, tasks: string[]) {
  await f.host.deliverConversation(f.parent, 'busy');
  const records = tasks.map((task) => {
    const sent = f.service.delegate(f.parent, { to: 'Bob', task });
    if (!sent.ok) throw new Error(sent.error);
    return f.store.get(sent.delegationId)!;
  });
  await vi.advanceTimersByTimeAsync(0);
  f.finish(f.parent);
  await vi.advanceTimersByTimeAsync(0);
  return records;
}
it('merges same-turn delegations into one delivery once all reach a final state', async () => {
  const f = fixture();
  const [a, b, c] = await sameTurn(f, ['one', 'two', 'three']);
  expect(a.batchId).toBeTruthy();
  expect([b.batchId, c.batchId]).toEqual([a.batchId, a.batchId]);
  f.finish(a.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(a.id)?.state).toBe('completed');
  expect(results(f)).toHaveLength(0);
  f.service.cancel(c.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toHaveLength(0);
  f.finish(b.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toMatchObject([{ id: f.parent, deliveryId: a.batchId }]);
  const text = results(f)[0].text;
  expect(text.startsWith(`<delegation-results id="${a.batchId}">`)).toBe(true);
  for (const record of [a, b, c]) expect(text).toContain(`<delegation-result id="${record.id}"`);
  expect(text).toContain('status="canceled"');
  expect([a, b, c].every((record) => f.store.get(record.id)?.deliveredAt !== undefined)).toBe(true);
  await f.service.deliverPending();
  expect(results(f)).toHaveLength(1);
  f.service.dispose();
});
it('recovers a batch after restart: finished-but-undelivered batches are delivered once', async () => {
  const f = fixture();
  const [a, b] = await sameTurn(f, ['one', 'two']);
  f.finish(a.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toHaveLength(0);
  f.service.dispose();
  // 真实重启时 worker 一并退出，宿主里旧子会话的活轮随之结束
  f.host.observe({ type: 'worker-exited' });
  const restarted = new DelegationService(f.deps);
  expect(f.store.get(b.id)).toMatchObject({ state: 'failed', failure: 'interrupted' });
  await vi.advanceTimersByTimeAsync(0);
  // 中断的那条先自动重试，等它有结果再整批回传一次
  expect(results(f)).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5000);
  const retried = f.store.list().find((record) => record.retryOf === b.id)!;
  expect(retried).toMatchObject({ retryBy: 'auto', batchId: a.batchId });
  f.finish(retried.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toMatchObject([{ deliveryId: a.batchId }]);
  expect(results(f)[0].text).toContain(`<delegation-result id="${retried.id}"`);
  expect(results(f)[0].text).not.toContain(`<delegation-result id="${b.id}"`);
  expect(f.store.get(a.id)?.deliveredAt).toBeDefined();
  expect(f.store.get(b.id)?.deliveredAt).toBeDefined();
  restarted.dispose();
  const again = new DelegationService(f.deps);
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toHaveLength(1);
  again.dispose();
});
it('keeps a retried delegation out of the original batch', async () => {
  const f = fixture();
  await f.host.deliverConversation(f.parent, 'busy');
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!first.ok) throw new Error(first.error);
  f.service.cancel(first.delegationId);
  const retried = await f.service.retry(first.delegationId, 'restart');
  if (!retried.ok) throw new Error(retried.error);
  const batchId = f.store.get(first.delegationId)?.batchId;
  expect(batchId).toBeTruthy();
  expect(f.store.get(retried.delegationId)?.batchId).not.toBe(batchId);
  await vi.advanceTimersByTimeAsync(0);
  f.service.dispose();
});
it('publishes the result as the member message plus a summary-free card in groups, without duplicates', async () => {
  const f = fixture();
  const members = f.deps.bots.list().map((bot) => bot.id);
  const alice = f.deps.bots.list().find((bot) => bot.name === 'Alice')!;
  const chat = f.deps.chats.create({
    kind: 'group',
    title: 'team',
    members,
    bossBotId: alice.id,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!;
  const parent = f.host.ensureSession(chat.id, alice.id);
  if (!parent.ok) throw new Error(parent.error);
  const sent = f.service.delegate(parent.conversationId, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  const record = f.store.get(sent.delegationId)!;
  f.host.observe({
    type: 'turn-completed',
    identity: { sessionId: record.childConversationId, generation: 'g' },
    seq: 2,
    turnId: 'turn',
    digest: { assistantText: 'result summary' },
  } as Parameters<BotSessionHost['observe']>[0]);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.deps.chats.readEntries(chat.id)).toEqual([
    expect.objectContaining({
      kind: 'bot',
      botId: f.bob,
      text: 'result summary',
      delegationId: record.id,
      conversationId: record.childConversationId,
    }),
    expect.not.objectContaining({ summary: expect.anything() }),
  ]);
  expect(f.deps.chats.readEntries(chat.id)[1]).toMatchObject({ kind: 'delegation' });
  f.service.dispose();
  const completed = f.store.get(record.id)!;
  f.store.save({ ...completed, deliveredAt: undefined });
  vi.spyOn(f.host, 'isBusy').mockReturnValue(false);
  const deliverGroupResult = vi.fn(async () => ({ ok: true as const }));
  const restarted = new DelegationService({ ...f.deps, deliverGroupResult });
  await vi.advanceTimersByTimeAsync(0);
  expect(deliverGroupResult).not.toHaveBeenCalled();
  expect(f.store.get(record.id)?.deliveredAt).toBeDefined();
  expect(f.deps.chats.readEntries(chat.id)).toHaveLength(2);
  restarted.dispose();
});
it('group new conversation: cancels non-keep delegations; kept results only land on the timeline', async () => {
  const f = fixture(true, undefined, async () => 'parallel');
  f.service.dispose();
  const deliverGroupResult = vi.fn(async () => ({ ok: true as const }));
  const service = new DelegationService({ ...f.deps, deliverGroupResult });
  const members = f.deps.bots.list().map((bot) => bot.id);
  const alice = f.deps.bots.list().find((bot) => bot.name === 'Alice')!;
  const chat = f.deps.chats.create({
    kind: 'group',
    title: 'team',
    members,
    bossBotId: alice.id,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!;
  const parent = f.host.ensureSession(chat.id, alice.id);
  if (!parent.ok) throw new Error(parent.error);
  const kept = service.delegate(parent.conversationId, { to: 'Bob', task: 'kept', keep: true });
  const drop = service.delegate(parent.conversationId, { to: 'Bob', task: 'drop' });
  const other = service.delegate(f.parent, { to: 'Bob', task: 'other chat' });
  if (!kept.ok || !drop.ok || !other.ok) throw new Error('delegate');
  await vi.advanceTimersByTimeAsync(0);
  const otherChild = f.store.get(other.delegationId)!.childConversationId;
  expect(f.prompts.some((prompt) => prompt.id === otherChild)).toBe(true);
  // 异步准入后由 IPC 转发 running，更新此前排队的委派状态。
  service.observeRunning(otherChild);

  service.startOver(chat.id);
  f.host.resetSessions(chat.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(drop.delegationId)).toMatchObject({ state: 'canceled' });
  expect(f.store.get(drop.delegationId)?.deliveredAt).toBeDefined();
  expect(f.store.get(kept.delegationId)?.state).toBe('running');
  expect(f.store.get(other.delegationId)?.state).toBe('running');

  f.finish(f.store.get(kept.delegationId)!.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(kept.delegationId)).toMatchObject({ state: 'completed' });
  expect(f.store.get(kept.delegationId)?.deliveredAt).toBeDefined();
  expect(deliverGroupResult).not.toHaveBeenCalled();
  expect(
    f.deps.chats
      .readEntries(chat.id)
      .filter((entry) => entry.kind === 'delegation')
      .map((entry) => entry.kind === 'delegation' && [entry.delegationId, entry.state])
  ).toEqual([
    [drop.delegationId, 'canceled'],
    [kept.delegationId, 'completed'],
  ]);
  service.dispose();
});
it('links a board task: gate rejects before any record, sync sees every save, retry keeps the link only while the task is free', async () => {
  const f = fixture();
  f.service.dispose();
  const TASK = '55555555-5555-4555-8555-555555555555';
  let free = true;
  const tasks = {
    gate: vi.fn((_chatId: string | null, ref: string) =>
      (ref === '#1' || ref === TASK) && free
        ? ({ ok: true, taskId: TASK, seq: 1 } as const)
        : ({ ok: false, error: 'Task #1 is already done.' } as const)
    ),
    sync: vi.fn(),
    open: vi.fn(),
    discard: vi.fn(),
  };
  const service = new DelegationService({ ...f.deps, tasks });
  expect(service.delegate(f.parent, { to: 'Bob', task: 'x', taskId: '#2' })).toEqual({
    ok: false,
    error: 'Task #1 is already done.',
  });
  expect(f.store.list()).toEqual([]);
  // 私聊不自动建卡
  const plain = service.delegate(f.parent, { to: 'Bob', task: 'y' });
  if (!plain.ok) throw new Error(plain.error);
  expect(plain).not.toHaveProperty('taskId');
  expect(tasks.open).not.toHaveBeenCalled();
  service.cancel(plain.delegationId);
  const sent = service.delegate(f.parent, { to: 'Bob', task: 'x', taskId: '#1' });
  if (!sent.ok) throw new Error(sent.error);
  expect(sent.taskId).toBe('#1');
  expect(f.store.get(sent.delegationId)).toMatchObject({ taskId: TASK, trigger: 'delegate' });
  expect(tasks.sync).toHaveBeenCalledWith(
    expect.objectContaining({ id: sent.delegationId, taskId: TASK })
  );
  service.cancel(sent.delegationId);
  expect(tasks.sync).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: sent.delegationId, state: 'canceled' })
  );
  free = true;
  const retried = await service.retry(sent.delegationId, 'restart');
  if (!retried.ok) throw new Error(retried.error);
  expect(retried.taskId).toBe('#1');
  expect(f.store.get(retried.delegationId)).toMatchObject({ taskId: TASK, trigger: 'retry' });
  service.cancel(retried.delegationId);
  free = false;
  const again = await service.retry(retried.delegationId, 'restart');
  if (!again.ok) throw new Error(again.error);
  expect(f.store.get(again.delegationId)).not.toHaveProperty('taskId');
  service.dispose();
});
describe('acceptance check', () => {
  const output = (toolCallId: string, text: string, isError = false) => ({
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    isError,
    timestamp: Date.now(),
    content: [{ type: 'text' as const, text }],
  });
  function checked(messages: () => ReturnType<typeof output>[]) {
    const f = fixture();
    f.service.dispose();
    const read = vi.fn(async (_conversationId: string) => messages());
    const service = new DelegationService({ ...f.deps, sessionMessages: read });
    return { ...f, service, read };
  }
  const check = { kind: 'output-contains' as const, text: 'XYZ_PASS' };

  it('passes when a final tool output contains the text and tells the member the condition', async () => {
    const f = checked(() => [output('a', 'XYZ_PASS\n')]);
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'run it', check });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const record = f.store.get(sent.delegationId)!;
    expect(f.prompts.find((p) => p.deliveryId === record.id)?.text).toContain('XYZ_PASS');
    f.finish(record.childConversationId);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.read).toHaveBeenCalledWith(record.childConversationId);
    expect(f.store.get(record.id)).toMatchObject({
      state: 'completed',
      check: { ...check, passed: true },
    });
    expect(results(f)[0].text).toContain('status="completed"');
    f.service.dispose();
  });

  it('fails with a clear reason when the final result for that call is an error, and retry keeps the check', async () => {
    const f = checked(() => [output('a', 'XYZ_PASS'), output('a', 'XYZ_PASS', true)]);
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'run it', check });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    f.finish(f.store.get(sent.delegationId)!.childConversationId);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(sent.delegationId)).toMatchObject({
      state: 'failed',
      failure: 'check',
      check: { ...check, passed: false },
      error: '验收未通过：未在工具输出中看到「XYZ_PASS」',
    });
    expect(results(f)[0].text).toContain('status="failed"');
    expect(results(f)[0].text).toContain('验收未通过：未在工具输出中看到「XYZ_PASS」');
    const retried = await f.service.retry(sent.delegationId);
    if (!retried.ok) throw new Error(retried.error);
    expect(f.store.get(retried.delegationId)?.check).toEqual(check);
    f.service.dispose();
  });

  it('ignores outputs from before the delegation started and fails when the log is unreadable', async () => {
    const old = { ...output('a', 'XYZ_PASS'), timestamp: 0 };
    const f = checked(() => [old]);
    vi.setSystemTime(10_000);
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'run it', check });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    f.finish(f.store.get(sent.delegationId)!.childConversationId);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(sent.delegationId)).toMatchObject({ state: 'failed', failure: 'check' });
    f.read.mockRejectedValueOnce(new Error('missing'));
    const again = f.service.delegate(f.parent, { to: 'Bob', task: 'again', check });
    if (!again.ok) throw new Error(again.error);
    await vi.advanceTimersByTimeAsync(0);
    f.finish(f.store.get(again.delegationId)!.childConversationId);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(again.delegationId)).toMatchObject({ state: 'failed', failure: 'check' });
    f.service.dispose();
  });

  it('inherits the linked board task check and skips verification after a failed turn', async () => {
    const f = fixture();
    f.service.dispose();
    const TASK = '55555555-5555-4555-8555-555555555555';
    const read = vi.fn(async () => [output('a', 'XYZ_PASS')]);
    const service = new DelegationService({
      ...f.deps,
      sessionMessages: read,
      tasks: {
        gate: () => ({ ok: true, taskId: TASK, seq: 1, check }),
        sync: vi.fn(),
        open: vi.fn(),
        discard: vi.fn(),
      },
    });
    const sent = service.delegate(f.parent, { to: 'Bob', task: 'x', taskId: '#1' });
    if (!sent.ok) throw new Error(sent.error);
    const record = f.store.get(sent.delegationId)!;
    expect(record.check).toEqual(check);
    await vi.advanceTimersByTimeAsync(0);
    f.host.observe({
      type: 'turn-failed',
      identity: { sessionId: record.childConversationId, generation: 'g' },
      seq: 1,
      turnId: 'turn',
      error: 'boom',
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(record.id)).toMatchObject({ state: 'failed', failure: 'error' });
    expect(read).not.toHaveBeenCalled();
    service.dispose();
  });

  it('retrying a failed check tells the member why in the original session instead of starting over', async () => {
    let messages = [output('a', 'nope')];
    const f = checked(() => messages);
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'run it', check });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    f.finish(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(sent.delegationId)).toMatchObject({ state: 'failed', failure: 'check' });
    const retried = await f.service.retry(sent.delegationId);
    if (!retried.ok) throw new Error(retried.error);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(retried.delegationId)).toMatchObject({
      childConversationId: child,
      retryOf: sent.delegationId,
      check,
      state: 'running',
    });
    const notes = f.prompts.filter((p) => p.deliveryId === retried.delegationId);
    expect(notes).toMatchObject([{ id: child }]);
    expect(notes[0].text).toContain('<delegation-check-failed');
    expect(notes[0].text).toContain('XYZ_PASS');
    expect(f.retries).toEqual([]);
    expect(f.prompts.filter((p) => p.text.includes('<delegation-task'))).toHaveLength(1);
    messages = [output('a', 'nope'), output('b', 'XYZ_PASS')];
    f.finish(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(retried.delegationId)).toMatchObject({
      state: 'completed',
      check: { ...check, passed: true },
    });
    f.service.dispose();
  });

  it('a resumed run counts check outputs produced before the interruption', async () => {
    let messages: ReturnType<typeof output>[] = [];
    const f = checked(() => messages);
    const sent = f.service.delegate(f.parent, {
      to: 'Bob',
      task: 'run it',
      check,
      deadlineMinutes: 10,
    });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(5);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    messages = [output('a', 'XYZ_PASS')];
    await vi.advanceTimersByTimeAsync(5);
    expect(f.store.get(sent.delegationId)).toMatchObject({ state: 'failed', failure: 'timeout' });
    const retried = await f.service.retry(sent.delegationId);
    if (!retried.ok) throw new Error(retried.error);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.retries).toEqual([child]);
    f.finish(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(retried.delegationId)).toMatchObject({ state: 'completed' });
    f.service.dispose();
  });
});

describe('retry resumes from the breakpoint', () => {
  const tasks = (f: ReturnType<typeof fixture>) =>
    f.prompts.filter((p) => p.text.includes('<delegation-task'));

  it('continues a timed-out delegation in its original child session with a fresh timer and the board task re-linked', async () => {
    const f = fixture();
    f.service.dispose();
    const TASK = '55555555-5555-4555-8555-555555555555';
    const board = {
      gate: vi.fn(() => ({ ok: true, taskId: TASK, seq: 1 }) as const),
      sync: vi.fn(),
      open: vi.fn(),
      discard: vi.fn(),
    };
    const service = new DelegationService({ ...f.deps, tasks: board });
    const sent = service.delegate(f.parent, {
      to: 'Bob',
      task: 'long work',
      taskId: '#1',
      deadlineMinutes: 10,
    });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.store.get(sent.delegationId)).toMatchObject({ state: 'failed', failure: 'timeout' });
    const retried = await service.retry(sent.delegationId);
    if (!retried.ok) throw new Error(retried.error);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(retried.delegationId)).toMatchObject({
      retryOf: sent.delegationId,
      childConversationId: child,
      taskId: TASK,
      timeoutMinutes: 10,
      state: 'running',
    });
    expect(f.retries).toEqual([child]);
    expect(tasks(f)).toHaveLength(1);
    expect(board.sync).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: retried.delegationId, taskId: TASK, state: 'running' })
    );
    await vi.advanceTimersByTimeAsync(9);
    expect(f.store.get(retried.delegationId)?.state).toBe('running');
    f.finish(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(retried.delegationId)?.state).toBe('completed');
    expect(f.store.get(sent.delegationId)?.state).toBe('failed');
    service.dispose();
  });

  it('continues a delegation interrupted by a restart', async () => {
    const f = fixture();
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    f.service.dispose();
    f.host.observe({ type: 'worker-exited' });
    const restarted = new DelegationService(f.deps);
    expect(f.store.get(sent.delegationId)).toMatchObject({ failure: 'interrupted' });
    const retried = await restarted.retry(sent.delegationId);
    if (!retried.ok) throw new Error(retried.error);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(retried.delegationId)).toMatchObject({
      childConversationId: child,
      state: 'running',
    });
    expect(f.retries).toEqual([child]);
    expect(tasks(f)).toHaveLength(1);
    restarted.dispose();
  });

  it('starts over in a new child session when the original never ran, lost its file, or fails to restore', async () => {
    const f = fixture();
    const fresh = async (prepare: (child: string) => void) => {
      const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
      if (!sent.ok) throw new Error(sent.error);
      await vi.advanceTimersByTimeAsync(0);
      const child = f.store.get(sent.delegationId)!.childConversationId;
      prepare(child);
      f.service.cancel(sent.delegationId);
      await vi.advanceTimersByTimeAsync(0);
      const retried = await f.service.retry(sent.delegationId, 'resume');
      if (!retried.ok) throw new Error(retried.error);
      await vi.advanceTimersByTimeAsync(0);
      const next = f.store.get(retried.delegationId)!;
      expect(next.childConversationId).not.toBe(child);
      expect(next.state).toBe('running');
      expect(tasks(f).at(-1)).toMatchObject({
        id: next.childConversationId,
        deliveryId: next.id,
      });
      f.service.cancel(next.id);
    };
    await fresh(() => {});
    await fresh((child) => {
      f.persist(child);
      rmSync(f.deps.authority.conversation(child)!.sessionFile!);
    });
    await fresh((child) => {
      f.persist(child);
      f.badSpawn.add(child);
    });
    expect(f.retries).toEqual([]);
    f.service.dispose();
  });

  it('a manually canceled delegation needs an explicit choice between continue and start over', async () => {
    const f = fixture();
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    f.service.cancel(sent.delegationId);
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.service.retry(sent.delegationId)).toMatchObject({ ok: false });
    expect(f.store.list().some((item) => item.retryOf === sent.delegationId)).toBe(false);
    const resumed = await f.service.retry(sent.delegationId, 'resume');
    if (!resumed.ok) throw new Error(resumed.error);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(resumed.delegationId)?.childConversationId).toBe(child);
    expect(f.retries).toEqual([child]);
    f.service.cancel(resumed.delegationId);
    await vi.advanceTimersByTimeAsync(0);
    const restarted = await f.service.retry(resumed.delegationId, 'restart');
    if (!restarted.ok) throw new Error(restarted.error);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(restarted.delegationId)?.childConversationId).not.toBe(child);
    expect(tasks(f)).toHaveLength(2);
    expect(f.retries).toEqual([child]);
    f.service.dispose();
  });
});

it('rejects delegating back up the chain to a member who delegated to you', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'write file' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  const child = f.store.get(sent.delegationId)!.childConversationId;
  const back = f.service.delegate(child, { to: 'Alice', task: 'report done' });
  expect(back).toEqual({ ok: false, error: expect.stringContaining('delegated this work to you') });
  expect(f.store.list()).toHaveLength(1);
  f.service.dispose();
});

it('fails the delegation with the budget reason when the target is over its daily cap', async () => {
  const over = new Set<string>();
  const f = fixture(true, over);
  over.add(f.bob);
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'do work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(sent.delegationId)).toMatchObject({
    state: 'failed',
    failure: 'error',
    error: 'budget-exceeded',
  });
  expect(f.prompts.filter((p) => p.text.includes('<delegation-task'))).toHaveLength(0);
  f.service.dispose();
});

it('retries only failed / canceled / interrupted records, links retryOf, and refuses superseded ones', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  expect(await f.service.retry(sent.delegationId)).toMatchObject({ ok: false });
  f.finish(f.store.get(sent.delegationId)!.childConversationId);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.get(sent.delegationId)?.state).toBe('completed');
  expect(await f.service.retry(sent.delegationId)).toMatchObject({ ok: false });
  expect(await f.service.retry('missing')).toMatchObject({ ok: false });

  const failed = f.service.delegate(f.parent, { to: 'Bob', task: 'two' });
  if (!failed.ok) throw new Error(failed.error);
  f.service.cancel(failed.delegationId);
  expect(await f.service.retry(failed.delegationId)).toMatchObject({ ok: false });
  const retried = await f.service.retry(failed.delegationId, 'restart');
  if (!retried.ok) throw new Error(retried.error);
  expect(f.store.get(retried.delegationId)).toMatchObject({ retryOf: failed.delegationId });
  expect(f.store.get(retried.delegationId)).not.toHaveProperty('batchId');
  expect(await f.service.retry(failed.delegationId, 'restart')).toEqual({
    ok: false,
    error: 'This delegation has already been retried.',
  });
  f.service.cancel(retried.delegationId);
  const chained = await f.service.retry(retried.delegationId, 'restart');
  if (!chained.ok) throw new Error(chained.error);
  expect(f.store.get(chained.delegationId)?.retryOf).toBe(retried.delegationId);
  f.service.dispose();

  const restarted = new DelegationService(f.deps);
  expect(f.store.get(chained.delegationId)).toMatchObject({
    state: 'failed',
    failure: 'interrupted',
  });
  const resumed = await restarted.retry(chained.delegationId);
  expect(resumed.ok && f.store.get(resumed.delegationId)?.retryOf).toBe(chained.delegationId);
  restarted.dispose();
});

it('retry is bound by the per-parent concurrency cap', async () => {
  const f = fixture();
  const first = f.service.delegate(f.parent, { to: 'Bob', task: 'one' });
  if (!first.ok) throw new Error(first.error);
  f.service.cancel(first.delegationId);
  for (const task of ['two', 'three', 'four'])
    expect(f.service.delegate(f.parent, { to: 'Bob', task }).ok).toBe(true);
  expect(await f.service.retry(first.delegationId, 'restart')).toMatchObject({ ok: false });
  expect(f.store.list().some((item) => item.retryOf === first.delegationId)).toBe(false);
  f.service.dispose();
});

describe('stopping the parent turn', () => {
  const results = (f: ReturnType<typeof fixture>) =>
    f.prompts.filter((p) => p.id === f.parent && p.text.includes('<delegation-result'));
  async function started(f: ReturnType<typeof fixture>) {
    await f.host.deliverConversation(f.parent, 'go');
    await vi.advanceTimersByTimeAsync(0);
    const kept = f.service.delegate(f.parent, { to: 'Bob', task: 'kept', keep: true });
    // 两个子委派同在父工作区写：kept 先占写锁在跑，drop 排队
    const drop = f.service.delegate(f.parent, { to: 'Bob', task: 'drop' });
    if (!drop.ok || !kept.ok) throw new Error('delegate');
    await vi.advanceTimersByTimeAsync(0);
    return { drop: drop.delegationId, kept: kept.delegationId };
  }

  it.each([
    [
      'stopTurn',
      (f: ReturnType<typeof fixture>, chatId: string, botId: string) =>
        f.host.stopTurn(chatId, botId),
    ],
    ['abortConversation', (f: ReturnType<typeof fixture>) => f.host.abortConversation(f.parent)],
  ] as const)('%s cancels the turn’s delegations except keep', async (_name, stop) => {
    const f = fixture();
    const ids = await started(f);
    const drop = f.store.get(ids.drop)!;
    expect(drop.batchId).toBeDefined();
    expect(f.store.get(ids.kept)).toMatchObject({ keep: true, batchId: drop.batchId });
    await stop(f, drop.chatId!, drop.parentBotId);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(ids.drop)?.state).toBe('canceled');
    expect(f.abort).toHaveBeenCalledWith(drop.childConversationId);
    expect(f.store.get(ids.kept)?.state).toBe('running');
    expect(results(f)).toHaveLength(0);
    // keep 的结果回来后整批（含被取消的）照常合并回传
    f.finish(f.store.get(ids.kept)!.childConversationId);
    await vi.advanceTimersByTimeAsync(0);
    expect(results(f)).toHaveLength(1);
    expect(results(f)[0].text).toContain(ids.drop);
    f.service.dispose();
  });

  it('a user abort reported by the worker (stopReason aborted) cascades too', async () => {
    const f = fixture();
    const ids = await started(f);
    f.host.observe({
      type: 'message-upsert',
      identity: { sessionId: f.parent, generation: 'g' },
      seq: 2,
      index: 1,
      message: { role: 'assistant', content: [], stopReason: 'aborted' },
    });
    f.finish(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(ids.drop)?.state).toBe('canceled');
    expect(f.store.get(ids.kept)?.state).toBe('running');
    f.service.dispose();
  });

  it('a stopped turn whose batch has nothing left running is closed without waking the parent', async () => {
    const f = fixture();
    await f.host.deliverConversation(f.parent, 'go');
    await vi.advanceTimersByTimeAsync(0);
    const done = f.service.delegate(f.parent, { to: 'Bob', task: 'quick' });
    const drop = f.service.delegate(f.parent, { to: 'Bob', task: 'slow' });
    if (!done.ok || !drop.ok) throw new Error('delegate');
    await vi.advanceTimersByTimeAsync(0);
    f.finish(f.store.get(done.delegationId)!.childConversationId);
    await vi.advanceTimersByTimeAsync(0);
    await f.host.abortConversation(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(drop.delegationId)?.state).toBe('canceled');
    expect(f.store.get(done.delegationId)?.deliveredAt).toBeDefined();
    expect(f.store.get(drop.delegationId)?.deliveredAt).toBeDefined();
    expect(results(f)).toHaveLength(0);
    f.service.dispose();
  });

  it('normal completion, errors and other turns leave delegations running', async () => {
    const f = fixture(true, undefined, async () => 'parallel');
    const ids = await started(f);
    const dropChild = f.store.get(ids.drop)!.childConversationId;
    expect(f.prompts.some((prompt) => prompt.id === dropChild)).toBe(true);
    f.service.observeRunning(dropChild);
    f.host.observe({
      type: 'message-upsert',
      identity: { sessionId: f.parent, generation: 'g' },
      seq: 2,
      index: 1,
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' },
    });
    f.finish(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect([f.store.get(ids.kept)?.state, f.store.get(ids.drop)?.state]).toEqual([
      'running',
      'running',
    ]);
    // 下一轮被停止只影响下一轮自己发起的委派
    await f.host.deliverConversation(f.parent, 'again');
    await vi.advanceTimersByTimeAsync(0);
    await f.host.abortConversation(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect([f.store.get(ids.kept)?.state, f.store.get(ids.drop)?.state]).toEqual([
      'running',
      'running',
    ]);
    f.service.dispose();
  });

  it('cascades down: a canceled child stops its own delegations', async () => {
    const f = fixture();
    const carol = f.deps.bots.create({ name: 'Carol' }, []);
    if (!carol.ok) throw new Error('carol');
    await f.host.deliverConversation(f.parent, 'go');
    await vi.advanceTimersByTimeAsync(0);
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'lead' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    const nested = f.service.delegate(child, { to: 'Carol', task: 'sub' });
    if (!nested.ok) throw new Error(nested.error);
    await vi.advanceTimersByTimeAsync(0);
    await f.host.abortConversation(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(sent.delegationId)?.state).toBe('canceled');
    expect(f.store.get(nested.delegationId)?.state).toBe('canceled');
    f.service.dispose();
  });

  it('returns cascaded board tasks to todo while kept ones stay assigned', async () => {
    const f = fixture();
    f.service.dispose();
    const tasks = { gate: vi.fn(), sync: vi.fn(), open: vi.fn(), discard: vi.fn() };
    const service = new DelegationService({ ...f.deps, tasks });
    await f.host.deliverConversation(f.parent, 'go');
    await vi.advanceTimersByTimeAsync(0);
    const drop = service.delegate(f.parent, { to: 'Bob', task: 'drop' });
    const kept = service.delegate(f.parent, { to: 'Bob', task: 'kept', keep: true });
    if (!drop.ok || !kept.ok) throw new Error('delegate');
    await vi.advanceTimersByTimeAsync(0);
    tasks.sync.mockClear();
    await f.host.abortConversation(f.parent);
    expect(tasks.sync).toHaveBeenCalledWith(
      expect.objectContaining({ id: drop.delegationId, state: 'canceled' })
    );
    expect(tasks.sync).not.toHaveBeenCalledWith(expect.objectContaining({ id: kept.delegationId }));
    service.dispose();
  });
});

describe('委派失败：自动重试', () => {
  const toParent = (f: ReturnType<typeof fixture>) =>
    f.prompts.filter((p) => p.id === f.parent && p.text.includes('<delegation-result'));
  const failChild = (f: ReturnType<typeof fixture>, child: string, transient: boolean) =>
    f.host.observe({
      type: 'turn-failed',
      identity: { sessionId: child, generation: 'g' },
      seq: 1,
      turnId: 'turn',
      error: transient ? 'socket hang up' : 'model refused',
      ...(transient ? { retryExhausted: true } : {}),
    } as never);
  const make = (f: ReturnType<typeof fixture>) =>
    new DelegationService({ ...f.deps, autoRetryDelayMs: (_kind, attempt) => attempt * 1000 });

  it('等待期间人工重试校验失败后，原自动重试不能永久悬空', async () => {
    const f = fixture();
    f.service.dispose();
    const service = make(f);
    try {
      const sent = service.delegate(f.parent, { to: 'Bob', task: 'work' });
      if (!sent.ok) throw new Error(sent.error);
      await vi.advanceTimersByTimeAsync(0);
      const child = f.store.get(sent.delegationId)!.childConversationId;
      f.persist(child);
      failChild(f, child, true);
      await vi.advanceTimersByTimeAsync(0);
      const registration = vi.spyOn(f.host, 'registerDelegation').mockReturnValueOnce(false);
      expect(service.retry(sent.delegationId).ok).toBe(false);
      registration.mockRestore();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.retries).toEqual([child]);
    } finally {
      service.dispose();
    }
  });

  it('自动重试保留 keep，父回合停止后接替记录仍继续执行', async () => {
    const f = fixture();
    f.service.dispose();
    const service = make(f);
    try {
      await f.host.deliverConversation(f.parent, 'go');
      await vi.advanceTimersByTimeAsync(0);
      const sent = service.delegate(f.parent, { to: 'Bob', task: 'work', keep: true });
      if (!sent.ok) throw new Error(sent.error);
      await vi.advanceTimersByTimeAsync(0);
      const child = f.store.get(sent.delegationId)!.childConversationId;
      f.persist(child);
      failChild(f, child, true);
      await vi.advanceTimersByTimeAsync(1000);
      const retry = f.store.list().find((r) => r.retryOf === sent.delegationId)!;
      await f.host.abortConversation(f.parent);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.store.get(retry.id)?.state).toBe('running');
    } finally {
      service.dispose();
    }
  });

  it('回合内重试用尽的瞬态错误：按退避在原子会话上续跑，等待期间不唤醒委派人，成功后只回传一次', async () => {
    const f = fixture();
    f.service.dispose();
    const service = make(f);
    const sent = service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    failChild(f, child, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(sent.delegationId)).toMatchObject({
      state: 'failed',
      failure: 'error',
      transient: true,
      autoRetryAt: expect.any(Number),
    });
    expect(toParent(f)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.retries).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.retries).toEqual([child]);
    const retry = f.store.list().find((r) => r.retryOf === sent.delegationId)!;
    expect(retry).toMatchObject({ retryBy: 'auto', childConversationId: child, state: 'running' });
    f.finish(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(toParent(f)).toHaveLength(1);
    expect(toParent(f)[0].text).toContain(`<delegation-result id="${retry.id}"`);
    expect(toParent(f)[0].text).toContain('status="completed"');
    expect(toParent(f)[0].text).not.toContain(`<delegation-result id="${sent.delegationId}"`);
    expect(f.store.list().every((r) => r.deliveredAt !== undefined)).toBe(true);
    service.dispose();
  });

  it('自动重试有次数上限；用尽后带失败类型和处理方式交回委派人', async () => {
    const f = fixture();
    f.service.dispose();
    const service = make(f);
    const sent = service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    for (let attempt = 1; attempt <= 3; attempt++) {
      failChild(f, child, true);
      await vi.advanceTimersByTimeAsync(attempt * 1000);
    }
    expect(f.retries).toEqual([child, child]);
    const chain = f.store.list();
    expect(chain).toHaveLength(3);
    expect(chain.filter((r) => r.retryBy === 'auto')).toHaveLength(2);
    expect(chain.at(-1)).not.toHaveProperty('autoRetryAt');
    expect(toParent(f)).toHaveLength(1);
    const text = toParent(f)[0].text;
    expect(text).toContain('failure="error"');
    expect(text).toContain('automatic retries exhausted');
    expect(text).toContain('retry_delegation');
    expect(text).toContain('3 of 3 retries left');
    expect(text).toContain('Untrusted error summary');
    service.dispose();
  });

  it('超时、非瞬态错误、取消不自动重试，直接交给委派人', async () => {
    const f = fixture();
    f.service.dispose();
    const service = make(f);
    const late = service.delegate(f.parent, { to: 'Bob', task: 'slow', deadlineMinutes: 10 });
    if (!late.ok) throw new Error(late.error);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.store.get(late.delegationId)).toMatchObject({ state: 'failed', failure: 'timeout' });
    expect(f.store.get(late.delegationId)).not.toHaveProperty('autoRetryAt');
    f.finish(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    const broken = service.delegate(f.parent, { to: 'Bob', task: 'broken' });
    if (!broken.ok) throw new Error(broken.error);
    await vi.advanceTimersByTimeAsync(0);
    failChild(f, f.store.get(broken.delegationId)!.childConversationId, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(broken.delegationId)).not.toHaveProperty('autoRetryAt');
    const dropped = service.delegate(f.parent, { to: 'Bob', task: 'dropped' });
    if (!dropped.ok) throw new Error(dropped.error);
    service.cancel(dropped.delegationId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.retries).toEqual([]);
    expect(f.store.list().some((r) => r.retryBy === 'auto')).toBe(false);
    expect(toParent(f).length).toBeGreaterThan(0);
    service.dispose();
  });

  it('重启：运行中的委派标 interrupted 后自动续跑；等待期间再重启按持久化时刻重排，不唤醒委派人', async () => {
    const f = fixture();
    f.service.dispose();
    let service = make(f);
    const sent = service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    service.dispose();
    f.host.observe({ type: 'worker-exited' });
    service = make(f);
    expect(f.store.get(sent.delegationId)).toMatchObject({
      state: 'failed',
      failure: 'interrupted',
      autoRetryAt: expect.any(Number),
    });
    await vi.advanceTimersByTimeAsync(500);
    service.dispose();
    service = make(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.retries).toEqual([]);
    expect(toParent(f)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.retries).toEqual([child]);
    expect(f.store.list().find((r) => r.retryOf === sent.delegationId)).toMatchObject({
      retryBy: 'auto',
    });
    service.dispose();
  });

  it('重启后失败通知不丢：未投递的最终失败由新实例补投一次', async () => {
    const f = fixture();
    f.service.dispose();
    let service = make(f);
    await f.host.deliverConversation(f.parent, 'busy');
    await vi.advanceTimersByTimeAsync(0);
    const sent = service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    failChild(f, f.store.get(sent.delegationId)!.childConversationId, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(sent.delegationId)?.deliveredAt).toBeUndefined();
    service.dispose();
    f.finish(f.parent);
    await vi.advanceTimersByTimeAsync(0);
    expect(toParent(f)).toHaveLength(0);
    service = make(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(toParent(f)).toHaveLength(1);
    expect(toParent(f)[0].text).toContain('final failure');
    expect(f.store.get(sent.delegationId)?.deliveredAt).toBeDefined();
    service.dispose();
    service = make(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(toParent(f)).toHaveLength(1);
    service.dispose();
  });

  it('等待自动重试时人工点重试：接替进原批次，不先把失败交回委派人，自动重试不再执行', async () => {
    const f = fixture();
    f.service.dispose();
    const service = make(f);
    const sent = service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    failChild(f, child, true);
    await vi.advanceTimersByTimeAsync(0);
    const human = service.retry(sent.delegationId);
    if (!human.ok) throw new Error(human.error);
    await vi.advanceTimersByTimeAsync(0);
    expect(toParent(f)).toHaveLength(0);
    expect(f.store.get(human.delegationId)).toMatchObject({ retryBy: 'human' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.retries).toEqual([child]);
    f.finish(child);
    await vi.advanceTimersByTimeAsync(0);
    expect(toParent(f)).toHaveLength(1);
    expect(toParent(f)[0].text).toContain(`<delegation-result id="${human.delegationId}"`);
    expect(toParent(f)[0].text).not.toContain(`<delegation-result id="${sent.delegationId}"`);
    service.dispose();
  });

  it('等待自动重试时父回合被停止：放弃自动重试，不再唤醒父会话', async () => {
    const f = fixture();
    f.service.dispose();
    const service = make(f);
    await f.host.deliverConversation(f.parent, 'go');
    await vi.advanceTimersByTimeAsync(0);
    const sent = service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    failChild(f, f.store.get(sent.delegationId)!.childConversationId, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(sent.delegationId)?.autoRetryAt).toBeDefined();
    await f.host.abortConversation(f.parent);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.retries).toEqual([]);
    expect(f.store.get(sent.delegationId)).not.toHaveProperty('autoRetryAt');
    expect(f.store.get(sent.delegationId)?.deliveredAt).toBeDefined();
    expect(toParent(f)).toHaveLength(0);
    service.dispose();
  });
});

describe('retry_delegation：委派人自己重试', () => {
  const failChild = (f: ReturnType<typeof fixture>, child: string) =>
    f.host.observe({
      type: 'turn-failed',
      identity: { sessionId: child, generation: 'g' },
      seq: 1,
      turnId: 'turn',
      error: 'model refused',
    } as never);

  it('在原子会话上续跑：带说明时补一条消息，不带说明时从断点重跑', async () => {
    const f = fixture();
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    failChild(f, child);
    await vi.advanceTimersByTimeAsync(0);
    const first = f.service.retryAsDelegator(f.parent, sent.delegationId, '换个思路：先读 README');
    if (!first.ok) throw new Error(first.error);
    expect(first.retriesLeft).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(first.delegationId)).toMatchObject({
      retryOf: sent.delegationId,
      retryBy: 'delegator',
      retryNote: '换个思路：先读 README',
      childConversationId: child,
    });
    const note = f.prompts.filter((p) => p.deliveryId === first.delegationId);
    expect(note).toMatchObject([{ id: child }]);
    expect(note[0].text).toContain('<delegation-retry');
    expect(note[0].text).toContain('换个思路：先读 README');
    expect(f.retries).toEqual([]);
    failChild(f, child);
    await vi.advanceTimersByTimeAsync(0);
    const second = f.service.retryAsDelegator(f.parent, first.delegationId);
    if (!second.ok) throw new Error(second.error);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.retries).toEqual([child]);
    expect(f.prompts.filter((p) => p.text.includes('<delegation-task'))).toHaveLength(1);
    f.service.dispose();
  });

  it('子会话无法恢复时才从头重发任务，并带上说明', async () => {
    const f = fixture();
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    failChild(f, child);
    await vi.advanceTimersByTimeAsync(0);
    const retried = f.service.retryAsDelegator(f.parent, sent.delegationId, '注意编码');
    if (!retried.ok) throw new Error(retried.error);
    await vi.advanceTimersByTimeAsync(0);
    const record = f.store.get(retried.delegationId)!;
    expect(record.childConversationId).not.toBe(child);
    const task = f.prompts.filter((p) => p.id === record.childConversationId);
    expect(task[0].text).toContain('<delegation-task');
    expect(task[0].text).toContain('<retry-note>注意编码</retry-note>');
    f.service.dispose();
  });

  it('同一条链委派人最多重试 3 次，超出拒绝并说明；只能重试自己的委派；界面重试不受限', async () => {
    const f = fixture();
    const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
    if (!sent.ok) throw new Error(sent.error);
    await vi.advanceTimersByTimeAsync(0);
    const child = f.store.get(sent.delegationId)!.childConversationId;
    f.persist(child);
    failChild(f, child);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.service.retryAsDelegator('someone-else', sent.delegationId)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not found'),
    });
    let id = sent.delegationId;
    for (let i = 0; i < 3; i++) {
      const retried = f.service.retryAsDelegator(f.parent, id);
      if (!retried.ok) throw new Error(retried.error);
      expect(retried.retriesLeft).toBe(2 - i);
      id = retried.delegationId;
      await vi.advanceTimersByTimeAsync(0);
      failChild(f, child);
      await vi.advanceTimersByTimeAsync(0);
    }
    const refused = f.service.retryAsDelegator(f.parent, id);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('3 times') });
    expect(f.store.list().filter((r) => r.retryBy === 'delegator')).toHaveLength(3);
    const human = await f.service.retry(id);
    expect(human.ok).toBe(true);
    if (human.ok) expect(f.store.get(human.delegationId)?.retryBy).toBe('human');
    f.service.dispose();
  });
});

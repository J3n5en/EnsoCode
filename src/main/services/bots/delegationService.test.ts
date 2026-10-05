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

let root: string;
beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'delegate-service-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
function fixture(autoStart = true, over = new Set<string>()) {
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
    queueMicrotask(() =>
      host.observe({
        type: 'status',
        status: 'running',
        identity: { sessionId: id, generation: 'g' },
        seq: 1,
      })
    );
  const host = new BotSessionHost({
    bots,
    chats,
    authority,
    emit: () => {},
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
  await vi.advanceTimersByTimeAsync(10);
  expect(f.store.get(short.delegationId)?.failure).toBe('timeout');
  expect(f.store.get(capped.delegationId)?.state).toBe('running');
  await vi.advanceTimersByTimeAsync(20);
  expect(f.store.get(capped.delegationId)?.failure).toBe('timeout');
  expect(f.store.get(plain.delegationId)?.failure).toBe('timeout');
  // 重试沿用原时限，并按目标当前上限再收紧
  f.deps.bots.update(f.bob, { delegationTimeoutMinutes: 5 }, []);
  const retried = await f.service.retry(short.delegationId);
  if (!retried.ok) throw new Error(retried.error);
  expect(f.store.get(retried.delegationId)?.timeoutMinutes).toBe(5);
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
it('marks unfinished work interrupted on restart without replaying it', async () => {
  const f = fixture();
  const sent = f.service.delegate(f.parent, { to: 'Bob', task: 'work' });
  if (!sent.ok) throw new Error(sent.error);
  await vi.advanceTimersByTimeAsync(0);
  f.service.dispose();
  const restarted = new DelegationService(f.deps);
  expect(f.store.get(sent.delegationId)).toMatchObject({ state: 'failed', failure: 'interrupted' });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.prompts.filter((p) => p.text.includes('<delegation-result'))).toHaveLength(1);
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
  const restarted = new DelegationService(f.deps);
  expect(f.store.get(b.id)).toMatchObject({ state: 'failed', failure: 'interrupted' });
  await vi.advanceTimersByTimeAsync(0);
  expect(results(f)).toMatchObject([{ deliveryId: a.batchId }]);
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
it('publishes only a delegation summary in groups without duplicating a bot message', async () => {
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
    expect.objectContaining({ kind: 'delegation', summary: 'result summary' }),
  ]);
  f.service.dispose();
  const completed = f.store.get(record.id)!;
  f.store.save({ ...completed, deliveredAt: undefined });
  vi.spyOn(f.host, 'isBusy').mockReturnValue(false);
  const deliverGroupResult = vi.fn(async () => ({ ok: true as const }));
  const restarted = new DelegationService({ ...f.deps, deliverGroupResult });
  await vi.advanceTimersByTimeAsync(0);
  expect(deliverGroupResult).not.toHaveBeenCalled();
  expect(f.store.get(record.id)?.deliveredAt).toBeDefined();
  expect(f.deps.chats.readEntries(chat.id)).toHaveLength(1);
  restarted.dispose();
});
it('group new conversation: cancels non-keep delegations; kept results only land on the timeline', async () => {
  const f = fixture();
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
        ? ({ ok: true, taskId: TASK } as const)
        : ({ ok: false, error: 'Task #1 is already done.' } as const)
    ),
    sync: vi.fn(),
  };
  const service = new DelegationService({ ...f.deps, tasks });
  expect(service.delegate(f.parent, { to: 'Bob', task: 'x', taskId: '#2' })).toEqual({
    ok: false,
    error: 'Task #1 is already done.',
  });
  expect(f.store.list()).toEqual([]);
  const sent = service.delegate(f.parent, { to: 'Bob', task: 'x', taskId: '#1' });
  if (!sent.ok) throw new Error(sent.error);
  expect(f.store.get(sent.delegationId)?.taskId).toBe(TASK);
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
  expect(f.store.get(retried.delegationId)?.taskId).toBe(TASK);
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
      tasks: { gate: () => ({ ok: true, taskId: TASK, check }), sync: vi.fn() },
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
    const board = { gate: vi.fn(() => ({ ok: true, taskId: TASK }) as const), sync: vi.fn() };
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
    const f = fixture();
    const ids = await started(f);
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
    const tasks = { gate: vi.fn(), sync: vi.fn() };
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

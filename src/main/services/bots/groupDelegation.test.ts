import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import { BotSessionHost } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { turnDelegationTargets } from './delegationBatch';
import { DelegationService } from './delegationService';
import { DelegationStore } from './delegationStore';
import { GroupChatService } from './groupChat';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'group-delegation-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function fixture(names = ['林经理', '阿后']) {
  const bots = new BotStore(join(root, 'bots'));
  // 全员只读：本文件只验证委派接力与回传，工作区写锁见 botSessionHost.lock.test
  const ids = names.map((name) => {
    const created = bots.create({ name, tools: 'readonly' }, []);
    if (!created.ok) throw new Error('bots');
    return created.bot.id;
  });
  const chats = new BotChatStore(join(root, 'bot-chats'));
  const chat = chats.create({
    kind: 'group',
    title: '发布小组',
    members: ids,
    bossBotId: ids[0],
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!;
  const authority = new SourceAuthorityRegistry({ registryFile: join(root, 'authority.json') });
  const prompts: Array<{ id: string; text: string; deliveryId?: string }> = [];
  const host = new BotSessionHost({
    bots,
    chats,
    authority,
    emit: () => {},
    runtime: {
      spawn: async () => ({ ok: true }),
      prompt: (id, text, _images, deliveryId) => {
        prompts.push({ id, text, deliveryId });
        return { ok: true };
      },
      steer: (id, text, _images, deliveryId) => {
        prompts.push({ id, text, deliveryId });
        return { ok: true };
      },
      release: async () => {},
      abort: () => {},
      removeSessionFiles: () => {},
    },
  });
  const store = new DelegationStore(join(root, 'bot-chats', 'delegations.jsonl'));
  const groups = new GroupChatService({
    bots,
    chats,
    host,
    emit: () => {},
    delegatedTargets: (conversationId, turnKey) =>
      turnDelegationTargets(store.list(), conversationId, turnKey),
  });
  const makeDelegations = () =>
    new DelegationService({
      bots,
      chats,
      authority,
      host,
      store,
      emit: () => {},
      deliverGroupResult: async (record, text, deliveryId) =>
        record.chatId &&
        chats.get(record.chatId)?.sessions[record.parentBotId]?.conversationId ===
          record.parentConversationId
          ? groups.runAs(record.chatId, record.parentBotId, text, undefined, {
              onlyIfIdle: true,
              deliveryId,
            })
          : { ok: false, error: 'parent-session-changed' },
    });
  const delegations = makeDelegations();
  let index = 0;
  const observe = (sessionId: string, event: Record<string, unknown>) =>
    host.observe({
      seq: 1,
      identity: { sessionId, generation: 'g' },
      ...event,
    } as AgentWorkerEvent);
  const start = (id: string) => {
    observe(id, { type: 'status', status: 'running' });
    delegations.observeRunning(id);
  };
  const reply = (id: string, text: string) => {
    observe(id, {
      type: 'message-upsert',
      index: ++index,
      message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' },
    });
    observe(id, { type: 'status', status: 'idle' });
    observe(id, { type: 'turn-completed', turnId: `turn-${index}` });
  };
  const conversation = (botId: string) => chats.get(chat.id)!.sessions[botId].conversationId;
  const to = (id: string) => prompts.filter((prompt) => prompt.id === id);
  const child = (id: string) =>
    delegations.list().find((record) => record.id === id)!.childConversationId;
  const entries = () => chats.readEntries(chat.id, { limit: Number.MAX_SAFE_INTEGER });
  return {
    lin: ids[0],
    hou: ids[1],
    ids,
    chat,
    chats,
    entries,
    prompts,
    host,
    groups,
    delegations,
    makeDelegations,
    observe,
    start,
    reply,
    conversation,
    to,
    child,
  };
}

it('does not relay to a member delegated in the same turn and delivers single results across rounds', async () => {
  const { host, groups, delegations, start, reply, to, child, conversation, ...f } = fixture();

  // 人类消息（带 renderer 生成的 deliveryId）→ 群主林经理
  await groups.send(f.chat.id, '请让阿后把 hello.txt 改成 hello world', { deliveryId: 'human-1' });
  await settle();
  const lin = conversation(f.lin);
  expect(to(lin)).toHaveLength(1);
  start(lin);
  // 林经理轮次中委派阿后，正文同时 @阿后：不再触发群接力
  const d1 = delegations.delegate(lin, { to: '阿后', task: '改文件' });
  if (!d1.ok) throw new Error(d1.error);
  await settle();
  const child1 = child(d1.delegationId);
  expect(to(child1)).toHaveLength(1);
  start(child1);
  reply(lin, '我已经让 @阿后 改了');
  await settle();
  expect(groups.state(f.chat.id)).toMatchObject({ current: null, queue: [] });
  expect(f.prompts.filter((prompt) => prompt.id !== lin && prompt.id !== child1)).toEqual([]);
  // 第二条人类消息排队阿后、林经理
  await groups.send(f.chat.id, '@阿后 @林经理 再确认一下', { deliveryId: 'human-2' });
  await settle();
  const hou = conversation(f.hou);
  expect(to(hou)).toHaveLength(1);
  start(hou);
  // 阿后轮次中委派林经理确认
  const d2 = delegations.delegate(hou, { to: '林经理', task: '确认' });
  if (!d2.ok) throw new Error(d2.error);
  await settle();
  const child2 = child(d2.delegationId);
  start(child2);
  reply(hou, '改好了，等林经理确认');
  await settle();
  expect(to(lin)).toHaveLength(2);
  start(lin);
  // 委派 2 在林经理回复进行中完成（父会话阿后空闲，但群这一轮未结束）
  reply(child2, '确认过了');
  await settle();
  reply(lin, '好的，我看一下');
  await settle();
  expect(to(hou).at(-1)?.text).toContain(`<delegation-result id="${d2.delegationId}"`);
  start(hou);
  await settle();
  expect(delegations.list().find((r) => r.id === d2.delegationId)?.deliveredAt).toBeDefined();
  // 委派 1 在阿后处理结果时完成（父会话林经理空闲）
  reply(child1, 'done');
  await settle();
  reply(hou, '收到确认');
  await settle();
  expect(to(lin).at(-1)?.text).toContain(`<delegation-result id="${d1.delegationId}"`);
  start(lin);
  reply(lin, '全部完成');
  await settle();
  expect(delegations.list().every((record) => record.deliveredAt !== undefined)).toBe(true);
  expect(f.entries().filter((entry) => entry.kind === 'system')).toEqual([]);
  expect(groups.state(f.chat.id)).toMatchObject({ current: null });
  expect(host.queueState()).toEqual([]);
  expect(host.runningCount()).toBe(0);
  delegations.dispose();
  groups.dispose();
});

function bossDelegatesBoth(f: ReturnType<typeof fixture>) {
  return async () => {
    await f.groups.send(f.chat.id, '做一个落地页', { deliveryId: 'human-1' });
    await settle();
    const boss = f.conversation(f.ids[0]);
    f.start(boss);
    const sent = ['小设', '阿全'].map((to) => {
      const result = f.delegations.delegate(boss, { to, task: `${to} 的活` });
      if (!result.ok) throw new Error(result.error);
      return result.delegationId;
    });
    await settle();
    const children = sent.map((id) => f.child(id));
    for (const id of children) f.start(id);
    f.reply(boss, '已安排 @小设 出设计，@阿全 写代码');
    await settle();
    return { boss, sent, children };
  };
}

it('real timeline: same-turn delegates are not relayed and the boss gets one merged result', async () => {
  const f = fixture(['吴经理', '小设', '阿全']);
  const { boss, sent, children } = await bossDelegatesBoth(f)();
  expect(f.groups.state(f.chat.id)).toMatchObject({ current: null, queue: [] });
  expect(f.prompts.filter((p) => p.id !== boss && !children.includes(p.id))).toEqual([]);

  f.reply(children[0], '设计稿完成');
  await settle();
  expect(f.to(boss)).toHaveLength(1);
  expect(f.entries().flatMap((e) => (e.kind === 'system' ? [e.text] : []))).toEqual([
    '小设 已完成，等待 阿全',
  ]);

  f.reply(children[1], '代码完成');
  await settle();
  expect(f.to(boss)).toHaveLength(2);
  const merged = f.to(boss)[1];
  const batchId = f.delegations.list()[0].batchId;
  expect(merged.deliveryId).toBe(batchId);
  expect(merged.text.startsWith(`<delegation-results id="${batchId}">`)).toBe(true);
  for (const id of sent) expect(merged.text).toContain(`<delegation-result id="${id}"`);
  f.start(boss);
  await settle();
  f.reply(boss, '两项都完成了');
  await settle();
  expect(f.to(boss)).toHaveLength(2);
  expect(f.delegations.list().every((record) => record.deliveredAt !== undefined)).toBe(true);
  expect(f.entries().filter((e) => e.kind === 'delegation')).toHaveLength(2);
  expect(f.entries().filter((e) => e.kind === 'system')).toHaveLength(1);
  expect(f.groups.state(f.chat.id)).toMatchObject({ current: null });
  expect(f.host.queueState()).toEqual([]);
  expect(f.host.runningCount()).toBe(0);
  f.delegations.dispose();
  f.groups.dispose();
});

it('still relays to members mentioned but not delegated in that turn', async () => {
  const f = fixture(['吴经理', '小设', '阿全']);
  await f.groups.send(f.chat.id, '做一个落地页', { deliveryId: 'human-1' });
  await settle();
  const boss = f.conversation(f.ids[0]);
  f.start(boss);
  const sent = f.delegations.delegate(boss, { to: '小设', task: '设计' });
  if (!sent.ok) throw new Error(sent.error);
  await settle();
  f.reply(boss, '@小设 出设计，@阿全 你来评审');
  await settle();
  expect(f.groups.state(f.chat.id)).toMatchObject({ current: f.ids[2], queue: [] });
  expect(f.to(f.conversation(f.ids[2]))).toHaveLength(1);
  expect(f.chats.get(f.chat.id)?.sessions[f.ids[1]]).toBeUndefined();
  f.delegations.dispose();
  f.groups.dispose();
});

it('delivers a finished-but-undelivered batch once after restart', async () => {
  const f = fixture(['吴经理', '小设', '阿全']);
  const { boss, sent, children } = await bossDelegatesBoth(f)();
  f.reply(children[0], '设计稿完成');
  await settle();
  expect(f.to(boss)).toHaveLength(1);
  f.delegations.dispose();
  const restarted = f.makeDelegations();
  await settle();
  expect(restarted.list().find((r) => r.id === sent[1])).toMatchObject({
    state: 'failed',
    failure: 'interrupted',
  });
  expect(f.to(boss)).toHaveLength(2);
  expect(f.to(boss)[1].text).toContain('<delegation-results ');
  f.start(boss);
  await settle();
  expect(restarted.list().every((record) => record.deliveredAt !== undefined)).toBe(true);
  restarted.dispose();
  const again = f.makeDelegations();
  await settle();
  expect(f.to(boss)).toHaveLength(2);
  again.dispose();
  f.groups.dispose();
});

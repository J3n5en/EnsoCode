import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentWorkerEvent, ProjectedMessage } from '../../../shared/types/agent';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import { BotSessionHost, type BotSpawnSpec } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { createComposerRefs } from './composerRefs';
import { turnDelegationTargets } from './delegationBatch';
import { DelegationService } from './delegationService';
import { DelegationStore } from './delegationStore';
import { GroupChatService } from './groupChat';
import { GroupTaskStore } from './groupTaskStore';
import { GroupTaskService } from './groupTasks';
import type { MemberTaskClassifier } from './memberTaskClassifier';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'group-delegation-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function fixture(
  names = ['林经理', '阿后'],
  classifyMemberTask?: MemberTaskClassifier,
  withTasks = false,
  sessionMessages?: (conversationId: string) => Promise<readonly ProjectedMessage[]>,
  minuteMs?: number,
  progressDelayMs?: number
) {
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
  const spawned: BotSpawnSpec[] = [];
  const released: string[] = [];
  const host = new BotSessionHost({
    bots,
    chats,
    authority,
    emit: () => {},
    classifyMemberTask,
    runtime: {
      spawn: async (spec) => {
        spawned.push(spec);
        return { ok: true };
      },
      prompt: (id, text, _images, deliveryId) => {
        prompts.push({ id, text, deliveryId });
        return { ok: true };
      },
      steer: (id, text, _images, deliveryId) => {
        prompts.push({ id, text, deliveryId });
        return { ok: true };
      },
      retry: (id) => {
        prompts.push({ id, text: '<retry>' });
        return { ok: true };
      },
      release: async (id) => {
        released.push(id);
      },
      abort: () => {},
      removeSessionFiles: () => {},
    },
  });
  const store = new DelegationStore(join(root, 'bot-chats', 'delegations.jsonl'));
  let current: DelegationService | undefined;
  const tasks = withTasks
    ? new GroupTaskService({
        store: new GroupTaskStore(join(root, 'bot-chats')),
        chats,
        bots,
        emit: () => {},
        delegations: () => store.list(),
        ...(progressDelayMs !== undefined ? { progressDelayMs } : {}),
        rework: (input) => current?.rework(input) ?? { ok: false as const, error: 'disabled' },
        reply: (input) => current?.reply(input) ?? { ok: false as const, error: 'disabled' },
        interject: async (input) =>
          current ? current.interject(input) : { ok: false as const, error: 'disabled' },
        send: (chatId, text, refs) =>
          groups.send(
            chatId,
            text,
            { deliveryId: `human-${Math.random()}`, source: 'human' },
            refs
          ),
      })
    : undefined;
  const composer = createComposerRefs({
    bots,
    chats,
    skills: () => [],
    sessionMessages: async () => [],
    workspacePath: () => undefined,
    taskBrief: (chatId, taskId) => tasks?.previousRuns(chatId, taskId) ?? '',
  });
  const groups: GroupChatService = new GroupChatService({
    bots,
    chats,
    host,
    emit: () => {},
    refsAppendix: (chat, botId, entries) => composer.groupAppendix(chat, botId, entries),
    delegatedTargets: (conversationId, turnKey) =>
      turnDelegationTargets(store.list(), conversationId, turnKey),
  });
  const makeDelegations = () => {
    current = new DelegationService({
      bots,
      chats,
      authority,
      host,
      store,
      emit: () => {},
      autoRetryDelayMs: () => 0,
      ...(minuteMs ? { minuteMs } : {}),
      ...(tasks ? { tasks } : {}),
      ...(sessionMessages ? { sessionMessages } : {}),
      deliverGroupResult: async (record, text, deliveryId, batch) =>
        record.chatId &&
        chats.get(record.chatId)?.sessions[record.parentBotId]?.conversationId ===
          record.parentConversationId
          ? groups.runAs(
              record.chatId,
              record.parentBotId,
              text,
              undefined,
              { onlyIfIdle: true, deliveryId },
              { hideDelegationIds: batch.map((item) => item.id) }
            )
          : { ok: false, error: 'parent-session-changed' },
    });
    return current;
  };
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
  /** 子会话已落盘（worker 报 ready 后才有 sessionFile） */
  const persist = (conversationId: string) => {
    const file = join(root, `${conversationId}.jsonl`);
    writeFileSync(file, '{}\n');
    authority.markReady(conversationId, file, { providerId: 'p', modelId: 'm' });
    return file;
  };
  // 不带 error：只发一次失败回合（看板用例）；带 error：先置 failed 状态再发失败回合（结果入群用例）
  const fail = (id: string, error?: string) => {
    if (error === undefined)
      return observe(id, { type: 'turn-failed', turnId: 'fail', error: 'boom' });
    observe(id, { type: 'status', status: 'failed' });
    observe(id, { type: 'turn-failed', turnId: `turn-${++index}`, error });
  };
  return {
    authority,
    bots,
    spawned,
    released,
    persist,
    fail,
    lin: ids[0],
    hou: ids[1],
    ids,
    chat,
    chats,
    store,
    entries,
    prompts,
    host,
    groups,
    composer,
    delegations,
    tasks,
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
  const { host, groups, delegations, start, reply, to, child, conversation, ...f } = fixture(
    undefined,
    async () => 'parallel'
  );

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
    '小设 已完成，这批还在等 阿全',
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

it('after restart the interrupted one is auto-retried first, then the batch is delivered once', async () => {
  const f = fixture(['吴经理', '小设', '阿全']);
  const { boss, sent, children } = await bossDelegatesBoth(f)();
  f.reply(children[0], '设计稿完成');
  await settle();
  expect(f.to(boss)).toHaveLength(1);
  f.delegations.dispose();
  f.observe(children[1], { type: 'worker-exited' });
  const restarted = f.makeDelegations();
  await settle();
  const interrupted = restarted.list().find((r) => r.id === sent[1]);
  expect(interrupted).toMatchObject({
    state: 'failed',
    failure: 'interrupted',
  });
  // 等待 / 进行自动重试期间不唤醒群主
  const retry = restarted.list().find((r) => r.retryOf === sent[1])!;
  expect(retry).toMatchObject({ retryBy: 'auto', batchId: interrupted?.batchId });
  expect(f.to(boss)).toHaveLength(1);
  f.start(retry.childConversationId);
  f.reply(retry.childConversationId, '代码完成');
  await settle();
  expect(f.to(boss)).toHaveLength(2);
  expect(f.to(boss)[1].text).toContain('<delegation-results ');
  expect(f.to(boss)[1].text).toContain(`<delegation-result id="${retry.id}"`);
  expect(f.to(boss)[1].text).not.toContain(`<delegation-result id="${sent[1]}"`);
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

async function bossTurn(f: ReturnType<typeof fixture>) {
  await f.groups.send(f.chat.id, '安排一下', { deliveryId: 'human-1' });
  await settle();
  const boss = f.conversation(f.ids[0]);
  f.start(boss);
  return boss;
}

it('群主不带 taskId 委派：自动建卡挂上执行，交付后进待验收，返回 taskId', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const boss = await bossTurn(f);
  const sent = f.delegations.delegate(boss, { to: '阿后', task: '修复登录页按钮\n颜色改成蓝色' });
  if (!sent.ok) throw new Error(sent.error);
  expect(sent.taskId).toBe('#1');
  const child = f.child(sent.delegationId);
  expect(f.tasks?.list(f.chat.id)).toMatchObject([
    {
      seq: 1,
      title: '修复登录页按钮',
      detail: '修复登录页按钮\n颜色改成蓝色',
      createdBy: f.lin,
      status: 'doing',
      assigneeBotId: f.hou,
      delegationId: sent.delegationId,
      sessions: { [f.hou]: child },
      runs: [{ id: sent.delegationId, botId: f.hou, trigger: 'delegate' }],
    },
  ]);
  await settle();
  f.start(child);
  const startedAt = f.delegations.list()[0].startedAt;
  expect(startedAt).toEqual(expect.any(Number));
  expect(f.tasks?.list(f.chat.id)[0].runs).toMatchObject([{ state: 'running', startedAt }]);
  f.reply(child, '改好了');
  await settle();
  expect(f.tasks?.list(f.chat.id)[0]).toMatchObject({
    status: 'review',
    result: '改好了',
    runs: [{ state: 'completed', startedAt, finishedAt: expect.any(Number) }],
  });
  f.delegations.dispose();
  f.groups.dispose();
});

it('公开进度：开工 / 交付以执行人名义写进群，带 @ 也不触发路由、不进轮次；挂任务的结果卡带 taskId', async () => {
  const f = fixture(['林经理', '阿后', '小三'], undefined, true, undefined, undefined, 0);
  const boss = await bossTurn(f);
  const sent = f.delegations.delegate(boss, { to: '阿后', task: '让 @小三 也看看登录页' });
  if (!sent.ok) throw new Error(sent.error);
  await settle();
  const child = f.child(sent.delegationId);
  f.start(child);
  await settle();
  f.reply(boss, '已安排');
  await settle();
  f.reply(child, '改好了 @小三 你看下');
  await settle();
  const progress = f.entries().flatMap((e) => (e.kind === 'progress' ? [e] : []));
  expect(progress.map((e) => [e.botId, e.phase, e.text])).toEqual([
    [f.ids[1], 'started', '开工 #1『让 @小三 也看看登录页』'],
    [f.ids[1], 'delivered', '交付 #1：改好了 @小三 你看下'],
  ]);
  expect(f.chats.get(f.chat.id)?.sessions[f.ids[2]]).toBeUndefined();
  expect(JSON.stringify(f.groups.state(f.chat.id))).not.toContain(f.ids[2]);
  f.start(boss);
  await settle();
  f.reply(boss, '收到');
  await settle();
  expect(f.entries().find((e) => e.kind === 'delegation')).toMatchObject({
    delegationId: sent.delegationId,
    taskId: f.tasks?.list(f.chat.id)[0].id,
  });
  expect(f.chats.get(f.chat.id)?.sessions[f.ids[2]]).toBeUndefined();
  f.delegations.dispose();
  f.groups.dispose();
});

it('批量派活每人一张卡，标题取首行 60 字', async () => {
  const f = fixture(['吴经理', '小设', '阿全'], undefined, true);
  const boss = await bossTurn(f);
  const sent = ['小设', '阿全'].map((to) =>
    f.delegations.delegate(boss, { to, task: `${to}${'活'.repeat(70)}` })
  );
  expect(sent.map((result) => result.ok && result.taskId)).toEqual(['#1', '#2']);
  expect(
    f.tasks
      ?.list(f.chat.id)
      .map((task) => [task.title.length, task.assigneeBotId, task.delegationId])
  ).toEqual([
    [60, f.ids[1], sent[0].ok && sent[0].delegationId],
    [60, f.ids[2], sent[1].ok && sent[1].delegationId],
  ]);
  f.delegations.dispose();
  f.groups.dispose();
});

it('委派被拒不留卡：策略 / taskId 校验在建卡前拒绝，建卡后被拒删卡', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const boss = await bossTurn(f);
  expect(f.delegations.delegate(boss, { to: '林经理', task: 'x' })).toMatchObject({ ok: false });
  expect(f.delegations.delegate(boss, { to: '阿后', task: 'x', taskId: '#9' })).toMatchObject({
    ok: false,
  });
  vi.spyOn(f.host, 'registerDelegation').mockReturnValueOnce(false);
  expect(f.delegations.delegate(boss, { to: '阿后', task: 'x' })).toEqual({
    ok: false,
    error: 'Delegation workspace unavailable.',
  });
  expect(f.tasks?.list(f.chat.id)).toEqual([]);
  expect(f.delegations.list()).toEqual([]);
  expect(f.entries().filter((entry) => entry.kind === 'system')).toEqual([]);
  f.delegations.dispose();
  f.groups.dispose();
});

it('深度 2 嵌套委派不建卡，只记进上层任务的 runs；重试不另建卡', async () => {
  const f = fixture(['林经理', '阿后', '小三'], undefined, true);
  const boss = await bossTurn(f);
  const outer = f.delegations.delegate(boss, { to: '阿后', task: '查问题' });
  if (!outer.ok) throw new Error(outer.error);
  await settle();
  const child = f.child(outer.delegationId);
  f.start(child);
  const inner = f.delegations.delegate(child, { to: '小三', task: '查日志' });
  if (!inner.ok) throw new Error(inner.error);
  expect(inner).not.toHaveProperty('taskId');
  expect(
    f.delegations.list().find((record) => record.id === inner.delegationId)
  ).not.toHaveProperty('taskId');
  await settle();
  const grandchild = f.child(inner.delegationId);
  f.start(grandchild);
  f.reply(grandchild, '日志看完了');
  await settle();
  const [task, ...rest] = f.tasks?.list(f.chat.id) ?? [];
  expect(rest).toEqual([]);
  expect(task).toMatchObject({
    status: 'doing',
    delegationId: outer.delegationId,
    sessions: { [f.ids[1]]: child },
    runs: [
      { id: outer.delegationId, botId: f.ids[1] },
      { id: inner.delegationId, botId: f.ids[2], state: 'completed', nested: true },
    ],
  });
  // 任务已被人取消：重试不再挂卡，也不新建卡
  f.delegations.cancel(outer.delegationId);
  f.tasks?.cancel(f.chat.id, 'human', '#1');
  const retried = f.delegations.retry(outer.delegationId, 'restart');
  if (!retried.ok) throw new Error(retried.error);
  expect(retried).not.toHaveProperty('taskId');
  expect(f.delegations.list().find((record) => record.id === retried.delegationId)).toMatchObject({
    trigger: 'retry',
  });
  expect(f.tasks?.list(f.chat.id)).toHaveLength(1);
  f.delegations.dispose();
  f.groups.dispose();
});

/** 群主一轮里派活给 to，执行人交付；子会话已落盘 */
async function handOver(
  f: ReturnType<typeof fixture>,
  options: {
    to?: string;
    task?: string;
    chatId?: string;
    check?: { kind: 'output-contains'; text: string };
  } = {}
) {
  const chatId = options.chatId ?? f.chat.id;
  await f.groups.send(chatId, '安排一下', { deliveryId: `human-${Math.random()}` });
  await settle();
  const boss = f.chats.get(chatId)!.sessions[f.lin].conversationId;
  f.start(boss);
  const sent = f.delegations.delegate(boss, {
    to: options.to ?? '阿后',
    task: options.task ?? '修复登录页按钮',
    ...(options.check ? { check: options.check } : {}),
  });
  if (!sent.ok) throw new Error(sent.error);
  await settle();
  const child = f.child(sent.delegationId);
  f.persist(child);
  f.start(child);
  f.reply(boss, '已安排');
  await settle();
  return { boss, sent, child };
}

const latest = (f: ReturnType<typeof fixture>) => f.delegations.list().at(-1)!;
const task1 = (f: ReturnType<typeof fixture>, chatId = f.chat.id) => f.tasks!.list(chatId)[0];

it('退回返工：同一成员同一会话新开执行，只发增量 <delegation-task run= trigger=>，不挂 retryOf，交付后回到待验收', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { child } = await handOver(f);
  f.reply(child, '改好了');
  await settle();
  expect(task1(f)).toMatchObject({ status: 'review', result: '改好了' });
  expect(
    f.tasks!.tool(f.chat.id, f.lin, {
      action: 'reject',
      id: '#1',
      reason: '缺少单测',
      rework: true,
    })
  ).toMatchObject({ ok: true, task: { status: 'doing', returnReason: '缺少单测' } });
  const rework = latest(f);
  expect(rework).toMatchObject({
    trigger: 'rework',
    childConversationId: child,
    parentBotId: f.lin,
    targetBotId: f.hou,
    taskId: task1(f).id,
  });
  expect(rework).not.toHaveProperty('retryOf');
  await settle();
  const sent = f.to(child).at(-1)!;
  expect(sent.deliveryId).toBe(rework.id);
  expect(
    sent.text.startsWith(
      `<delegation-task id="${rework.id}" from="林经理" task="#1" run="2" trigger="rework">`
    )
  ).toBe(true);
  expect(sent.text).toContain('缺少单测');
  expect(sent.text).not.toContain('修复登录页按钮');
  expect(sent.text).not.toContain('<previous-runs>');
  f.start(child);
  f.reply(child, '补了单测');
  await settle();
  expect(task1(f)).toMatchObject({
    status: 'review',
    result: '补了单测',
    delegationId: rework.id,
    sessions: { [f.hou]: child },
    runs: [
      { trigger: 'delegate', state: 'completed' },
      { id: rework.id, trigger: 'rework', state: 'completed' },
    ],
  });
  f.delegations.dispose();
  f.groups.dispose();
});

it('隔离键：两个群同编号任务、同一成员不同任务各用各的子会话；返工只回到本任务的会话', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const other = f.chats.create({
    kind: 'group',
    title: '发布小组',
    members: f.ids,
    bossBotId: f.lin,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!;
  const a = await handOver(f, { task: '同名任务' });
  f.reply(a.child, 'A 好了');
  await settle();
  const b = await handOver(f, { task: '同名任务', chatId: other.id });
  f.reply(b.child, 'B 好了');
  await settle();
  const c = await handOver(f, { task: '另一个任务' });
  f.reply(c.child, 'C 好了');
  await settle();
  expect(a.sent.taskId).toBe('#1');
  expect(b.sent.taskId).toBe('#1');
  expect(c.sent.taskId).toBe('#2');
  expect(new Set([a.child, b.child, c.child]).size).toBe(3);
  f.tasks!.reject(other.id, 'human', '#1', '群二返工', true);
  expect(latest(f)).toMatchObject({ childConversationId: b.child, chatId: other.id });
  await settle();
  f.start(b.child);
  f.reply(b.child, 'B 再好了');
  await settle();
  f.tasks!.reject(f.chat.id, 'human', '#1', '群一返工', true);
  expect(latest(f)).toMatchObject({ childConversationId: a.child, chatId: f.chat.id });
  f.delegations.dispose();
  f.groups.dispose();
});

it('群里点「新对话」后返工：仍接原任务会话，结果回到群主的新会话', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, child } = await handOver(f);
  f.reply(child, '改好了');
  await settle();
  f.start(boss);
  f.reply(boss, '收到');
  await settle();
  f.delegations.startOver(f.chat.id);
  f.host.resetSessions(f.chat.id);
  expect(f.tasks!.reject(f.chat.id, 'human', '#1', '颜色不对', true)).toMatchObject({ ok: true });
  const rework = latest(f);
  const fresh = f.conversation(f.lin);
  expect(fresh).not.toBe(boss);
  expect(rework).toMatchObject({ childConversationId: child, parentConversationId: fresh });
  await settle();
  expect(f.to(child).at(-1)?.text).toContain('trigger="rework"');
  f.start(child);
  f.reply(child, '颜色改了');
  await settle();
  expect(f.to(fresh).at(-1)?.text).toContain(`<delegation-result id="${rework.id}"`);
  f.delegations.dispose();
  f.groups.dispose();
});

it('权限或工具变了：先释放空闲实例，再按原 jsonl 重新 spawn；没变不释放', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { child } = await handOver(f);
  f.reply(child, '改好了');
  await settle();
  const file = f.authority.conversation(child)?.sessionFile;
  const spawns = () => f.spawned.filter((spec) => spec.conversationId === child);
  expect(spawns()).toHaveLength(1);
  f.tasks!.reject(f.chat.id, 'human', '#1', '再看看', true);
  await settle();
  expect(f.released).not.toContain(child);
  expect(spawns()).toHaveLength(1);
  f.start(child);
  f.reply(child, '看过了');
  await settle();
  const updated = f.bots.update(f.hou, { tools: 'all' }, []);
  expect(updated.ok).toBe(true);
  f.tasks!.reject(f.chat.id, 'human', '#1', '这回要改代码', true);
  await settle();
  expect(f.released).toContain(child);
  expect(spawns()).toHaveLength(2);
  expect(spawns()[1]).toMatchObject({ resumeFile: file, bot: { tools: 'all' } });
  expect(f.to(child).at(-1)?.text).toContain('这回要改代码');
  f.delegations.dispose();
  f.groups.dispose();
});

it('会话不能复用（jsonl 被删）：开新会话并附 <previous-runs>，任务会话改指新会话', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { child } = await handOver(f);
  f.reply(child, '按钮改成蓝色了');
  await settle();
  rmSync(f.authority.conversation(child)!.sessionFile!);
  f.tasks!.reject(f.chat.id, 'human', '#1', '还要改 hover', true);
  const rework = latest(f);
  expect(rework.childConversationId).not.toBe(child);
  expect(rework.trigger).toBe('rework');
  await settle();
  const text = f.to(rework.childConversationId).at(-1)!.text;
  expect(text.startsWith(`<delegation-task id="${rework.id}" from="林经理">`)).toBe(true);
  expect(text).toContain('还要改 hover');
  expect(text).toContain('<previous-runs>');
  expect(text).toContain('<request>修复登录页按钮</request>');
  expect(text).toContain('<result>按钮改成蓝色了</result>');
  expect(task1(f).sessions).toEqual({ [f.hou]: rework.childConversationId });
  f.delegations.dispose();
  f.groups.dispose();
});

it('执行失败：任务保留负责人；重试与群主再派同一成员都接原会话；改派他人开新会话带 <previous-runs>', async () => {
  const f = fixture(['林经理', '阿后', '小三'], undefined, true);
  const { boss, sent, child } = await handOver(f);
  f.fail(child);
  await settle();
  expect(task1(f)).toMatchObject({
    status: 'blocked',
    blockedReason: 'failed',
    assigneeBotId: f.hou,
    delegationId: sent.delegationId,
    runs: [{ state: 'failed', failure: 'error' }],
  });
  // 执行失败只能重试 / 改派 / 取消：任务卡回复不能解除
  expect(await f.tasks!.reply(f.chat.id, '#1', '再试试')).toMatchObject({ ok: false });
  // 界面重试：同一会话从断点续跑
  const retried = f.delegations.retry(sent.delegationId);
  if (!retried.ok) throw new Error(retried.error);
  expect(retried.taskId).toBe('#1');
  await settle();
  expect(latest(f)).toMatchObject({
    trigger: 'retry',
    retryOf: sent.delegationId,
    childConversationId: child,
  });
  // 同一会话续跑；委派之后群里新增了群主的「已安排」，按群背景增量补上（没有新增时才走 <retry>）
  const resumed = f.to(child).at(-1)?.text ?? '';
  expect(resumed).toContain(`<delegation-retry id="${retried.delegationId}">`);
  expect(resumed).toContain('<group-message from="林经理" seq="2">已安排</group-message>');
  expect(resumed).not.toContain('<delegation-task');
  expect(task1(f)).toMatchObject({ delegationId: retried.delegationId, assigneeBotId: f.hou });
  f.start(child);
  f.fail(child);
  await settle();
  // 群主自己再派给原执行人：同会话增量投递
  f.start(boss);
  const again = f.delegations.delegate(boss, { to: '阿后', taskId: '#1', task: '换个思路' });
  if (!again.ok) throw new Error(again.error);
  await settle();
  expect(latest(f)).toMatchObject({ trigger: 'retry', childConversationId: child });
  expect(f.to(child).at(-1)?.text).toContain('task="#1" run="3" trigger="retry">\n换个思路');
  f.start(child);
  f.fail(child);
  await settle();
  // 改派：新成员新会话 + previous-runs，任务换负责人
  const moved = f.delegations.delegate(boss, { to: '小三', taskId: '#1', task: '你来接手' });
  if (!moved.ok) throw new Error(moved.error);
  await settle();
  const fresh = f.child(moved.delegationId);
  expect(fresh).not.toBe(child);
  expect(latest(f).trigger).toBe('delegate');
  const text = f.to(fresh).at(-1)!.text;
  expect(text).toContain('<previous-runs>');
  expect(text).toContain('<request>换个思路</request>');
  expect(task1(f)).toMatchObject({
    assigneeBotId: f.ids[2],
    delegationId: moved.delegationId,
    sessions: { [f.hou]: child, [f.ids[2]]: fresh },
  });
  f.delegations.dispose();
  f.groups.dispose();
});

it('验收只认本次执行开始之后的证据：返工不能借上一次执行的通过输出', async () => {
  let messages: unknown[] = [];
  const f = fixture(['林经理', '阿后'], undefined, true, async () => messages as never);
  const check = { kind: 'output-contains' as const, text: 'XYZ_PASS' };
  const { child } = await handOver(f, { check });
  messages = [
    {
      role: 'toolResult',
      toolCallId: 'a',
      toolName: 'bash',
      timestamp: Date.now(),
      content: [{ type: 'text', text: 'XYZ_PASS' }],
    },
  ];
  f.reply(child, '跑过了');
  await settle();
  expect(task1(f)).toMatchObject({ status: 'review', check: { passed: true } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.tasks!.reject(f.chat.id, 'human', '#1', '再跑一遍', true);
  const rework = latest(f);
  expect(rework).not.toHaveProperty('retryOf');
  await settle();
  expect(f.to(child).at(-1)?.text).toContain('<acceptance-check>');
  f.start(child);
  f.reply(child, '没再跑');
  await settle();
  expect(f.delegations.list().find((record) => record.id === rework.id)).toMatchObject({
    state: 'failed',
    failure: 'check',
  });
  expect(task1(f)).toMatchObject({
    status: 'blocked',
    blockedReason: 'failed',
    assigneeBotId: f.hou,
    delegationId: rework.id,
  });
  f.delegations.dispose();
  f.groups.dispose();
});

it('执行失败后群里开了新对话：界面重试仍接原任务会话，结果回群主的新会话', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, sent, child } = await handOver(f);
  f.fail(child);
  await settle();
  f.start(boss);
  f.reply(boss, '收到失败');
  await settle();
  f.delegations.startOver(f.chat.id);
  f.host.resetSessions(f.chat.id);
  const retried = f.delegations.retry(sent.delegationId);
  if (!retried.ok) throw new Error(retried.error);
  const fresh = f.conversation(f.lin);
  expect(fresh).not.toBe(boss);
  expect(latest(f)).toMatchObject({
    childConversationId: child,
    parentConversationId: fresh,
    retryOf: sent.delegationId,
  });
  await settle();
  f.start(child);
  f.reply(child, '这次好了');
  await settle();
  expect(task1(f)).toMatchObject({ status: 'review', assigneeBotId: f.hou });
  expect(f.to(fresh).at(-1)?.text).toContain(`<delegation-result id="${retried.delegationId}"`);
  f.delegations.dispose();
  f.groups.dispose();
});

/** 群主在同一会话里开下一轮（人类再发一句） */
async function nextBossTurn(f: ReturnType<typeof fixture>, text = '再补一句') {
  await f.groups.send(f.chat.id, text, { deliveryId: `human-${Math.random()}` });
  await settle();
  const boss = f.conversation(f.lin);
  f.start(boss);
  return boss;
}
const resultsTo = (f: ReturnType<typeof fixture>, boss: string) =>
  f.to(boss).filter((prompt) => prompt.text.includes('<delegation-result'));

it('追加插入：同一发起会话给执行中的同任务同成员追加 → steer 进原执行，不建新记录，结果只回一次到最近一轮', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, sent, child } = await handOver(f);
  const firstBatch = latest(f).batchId;
  expect(await nextBossTurn(f)).toBe(boss);
  const pending = f.delegations.delegateAndConfirm(boss, {
    to: '阿后',
    taskId: '#1',
    task: '顺便把 hover 也改了',
    keep: true,
  });
  await settle();
  const steer = f.to(child).at(-1)!;
  expect(steer.deliveryId).not.toBe(sent.delegationId);
  expect(steer.text).toContain(`<delegation-task id="${sent.delegationId}"`);
  expect(steer.text).toContain('trigger="append"');
  expect(steer.text).toContain('顺便把 hover 也改了');
  f.observe(child, { type: 'delivery-settled', deliveryId: steer.deliveryId });
  expect(await pending).toEqual({
    ok: true,
    delegationId: sent.delegationId,
    taskId: '#1',
    merged: true,
    delivery: 'accepted',
  });
  expect(f.delegations.list()).toHaveLength(1);
  const record = latest(f);
  expect(record).toMatchObject({
    state: 'running',
    keep: true,
    appends: [{ text: '顺便把 hover 也改了', deliveryId: steer.deliveryId }],
  });
  expect(record.batchId).toBe(f.host.turnKey(boss));
  expect(record.batchId).not.toBe(firstBatch);
  f.reply(boss, '已追加');
  await settle();
  f.reply(child, '按钮和 hover 都改好了');
  await settle();
  expect(latest(f)).toMatchObject({ state: 'completed', appends: [{ ok: true }] });
  expect(task1(f)).toMatchObject({
    status: 'review',
    runs: [{ id: sent.delegationId, state: 'completed', appends: 1 }],
  });
  expect(resultsTo(f, boss)).toHaveLength(1);
  expect(resultsTo(f, boss)[0].text).toContain('按钮和 hover 都改好了');
  f.delegations.dispose();
  f.groups.dispose();
});

it('追加期限：到期时刻取较晚者，各自按成员上限截断；排队中只改期限、开工才起算', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  f.host.setMaxRunningTurns(1);
  const boss = await bossTurn(f);
  const sent = f.delegations.delegate(boss, { to: '阿后', task: '修复', deadlineMinutes: 30 });
  if (!sent.ok) throw new Error(sent.error);
  await settle();
  expect(latest(f)).toMatchObject({ state: 'queued', timeoutMinutes: 30 });
  expect(
    f.delegations.delegate(boss, { to: '阿后', taskId: '#1', task: '短一点', deadlineMinutes: 5 })
  ).toMatchObject({ merged: true });
  expect(latest(f)).toMatchObject({ state: 'queued', timeoutMinutes: 30 });
  expect(
    f.delegations.delegate(boss, { to: '阿后', taskId: '#1', task: '长一点', deadlineMinutes: 999 })
  ).toMatchObject({ merged: true, warning: expect.stringContaining('240') });
  expect(latest(f)).toMatchObject({ state: 'queued', timeoutMinutes: 240 });
  expect(latest(f)).not.toHaveProperty('startedAt');
  f.delegations.dispose();
  f.groups.dispose();
});

it('追加期限（执行中）：max(原 startedAt + 期限, 现在 + 新期限)', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const sent = f.delegations;
  const { boss } = await handOver(f);
  const before = latest(f);
  expect(before.timeoutMinutes).toBe(240);
  await nextBossTurn(f);
  expect(
    sent.delegate(boss, { to: '阿后', taskId: '#1', task: '小改', deadlineMinutes: 10 })
  ).toMatchObject({
    merged: true,
  });
  expect(latest(f).timeoutMinutes).toBe(240);
  expect(latest(f).startedAt).toBe(before.startedAt);
  f.delegations.dispose();
  f.groups.dispose();
});

it('排队中追加 + 同一轮连派两次：第二次并入第一次，回执 deferred；原任务开工后追加跟进，结果只回一次', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  f.tasks!.tool(f.chat.id, f.lin, { action: 'add', title: '修复登录页' });
  f.host.setMaxRunningTurns(1);
  const boss = await bossTurn(f);
  const [first, second] = await Promise.all([
    f.delegations.delegateAndConfirm(boss, { to: '阿后', taskId: '#1', task: '按钮改蓝' }),
    f.delegations.delegateAndConfirm(boss, { to: '阿后', taskId: '#1', task: '还有 hover' }),
  ]);
  if (!first.ok) throw new Error(first.error);
  expect(first).not.toHaveProperty('merged');
  expect(second).toEqual({
    ok: true,
    delegationId: first.delegationId,
    taskId: '#1',
    merged: true,
    delivery: 'deferred',
  });
  expect(f.delegations.list()).toHaveLength(1);
  expect(latest(f)).toMatchObject({ state: 'queued', appends: [{ text: '还有 hover' }] });
  const child = f.child(first.delegationId);
  expect(f.to(child)).toEqual([]);
  f.reply(boss, '已安排');
  await settle();
  expect(f.to(child).map((prompt) => prompt.deliveryId)[0]).toBe(first.delegationId);
  f.start(child);
  await settle();
  // 追加跟在原任务后：开工后 steer 进同一回合或排成下一回合，都归这次执行
  const append = latest(f).appends![0].deliveryId;
  if (f.to(child).at(-1)?.deliveryId === append)
    f.observe(child, { type: 'delivery-settled', deliveryId: append });
  f.reply(child, '按钮好了');
  await settle();
  if (latest(f).state === 'running') {
    f.start(child);
    f.reply(child, 'hover 也好了');
    await settle();
  }
  expect(latest(f)).toMatchObject({ state: 'completed', appends: [{ ok: true }] });
  expect(f.to(child).filter((prompt) => prompt.deliveryId === append)).toHaveLength(1);
  expect(resultsTo(f, boss)).toHaveLength(1);
  f.delegations.dispose();
  f.groups.dispose();
});

it('回合收尾时追加被 deferred：原回合结束不结算，追加跑完的回合才结算，结果只回一次', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, sent, child } = await handOver(f);
  await nextBossTurn(f);
  const pending = f.delegations.delegateAndConfirm(boss, {
    to: '阿后',
    taskId: '#1',
    task: '还有 hover',
  });
  await settle();
  const append = f.to(child).at(-1)!.deliveryId!;
  f.observe(child, { type: 'delivery-deferred', deliveryId: append });
  expect(await pending).toMatchObject({ merged: true, delivery: 'deferred' });
  f.reply(boss, '已追加');
  await settle();
  f.reply(child, '按钮好了');
  await settle();
  expect(latest(f)).toMatchObject({ id: sent.delegationId, state: 'running' });
  expect(task1(f).status).toBe('doing');
  expect(resultsTo(f, boss)).toHaveLength(0);
  // 追加改排成下一回合
  expect(f.to(child).at(-1)).toMatchObject({ deliveryId: append });
  f.start(child);
  f.reply(child, 'hover 也好了');
  await settle();
  expect(latest(f)).toMatchObject({
    state: 'completed',
    result: 'hover 也好了',
    appends: [{ ok: true }],
  });
  expect(f.delegations.list()).toHaveLength(1);
  expect(resultsTo(f, boss)).toHaveLength(1);
  f.delegations.dispose();
  f.groups.dispose();
});

it('重复投递：同一追加再发一次不重复执行，返回同一回执', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, child } = await handOver(f);
  await nextBossTurn(f);
  const input = { to: '阿后', taskId: '#1', task: '还有 hover' };
  const once = f.delegations.delegateAndConfirm(boss, input);
  await settle();
  const twice = f.delegations.delegateAndConfirm(boss, input);
  await settle();
  const steers = f.to(child).filter((prompt) => prompt.text.includes('还有 hover'));
  expect(steers).toHaveLength(1);
  f.observe(child, { type: 'delivery-settled', deliveryId: steers[0].deliveryId });
  expect(await once).toMatchObject({ merged: true, delivery: 'accepted' });
  expect(await twice).toMatchObject({ merged: true, delivery: 'accepted' });
  expect(latest(f).appends).toHaveLength(1);
  f.delegations.dispose();
  f.groups.dispose();
});

it('已失败的追加不挂住执行：steer 被拒记 ok=false 并写进结果，原回合结束照常结算', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, child } = await handOver(f);
  await nextBossTurn(f);
  const pending = f.delegations.delegateAndConfirm(boss, {
    to: '阿后',
    taskId: '#1',
    task: '还有 hover',
  });
  await settle();
  const append = f.to(child).at(-1)!.deliveryId!;
  f.observe(child, { type: 'delivery-rejected', deliveryId: append });
  expect(await pending).toMatchObject({ merged: true, delivery: 'failed' });
  expect(latest(f)).toMatchObject({ state: 'running', appends: [{ ok: false }] });
  // 没送达的同一追加可以重发，重发仍失败也不挂住执行
  const resend = f.delegations.delegateAndConfirm(boss, {
    to: '阿后',
    taskId: '#1',
    task: '还有 hover',
  });
  await settle();
  expect(f.to(child).filter((prompt) => prompt.deliveryId === append)).toHaveLength(2);
  expect(latest(f).appends).toEqual([expect.objectContaining({ deliveryId: append })]);
  expect(latest(f).appends![0]).not.toHaveProperty('ok');
  f.observe(child, { type: 'delivery-rejected', deliveryId: append });
  expect(await resend).toMatchObject({ merged: true, delivery: 'failed' });
  f.reply(boss, '好');
  await settle();
  f.reply(child, '按钮好了');
  await settle();
  expect(latest(f)).toMatchObject({ state: 'completed', result: '按钮好了' });
  expect(resultsTo(f, boss)).toHaveLength(1);
  expect(resultsTo(f, boss)[0].text).toContain('还有 hover');
  expect(f.host.isBusy(child)).toBe(false);
  f.delegations.dispose();
  f.groups.dispose();
});

it('忙不结算有上限：到期强制结算，没跑完的追加记 ok=false 并在结果里写明', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true, undefined, 40);
  const { boss, child } = await handOver(f);
  await nextBossTurn(f);
  f.delegations.delegate(boss, {
    to: '阿后',
    taskId: '#1',
    task: '还有 hover',
    deadlineMinutes: 1,
  });
  await settle();
  const append = f.to(child).at(-1)!.deliveryId!;
  f.observe(child, { type: 'delivery-deferred', deliveryId: append });
  f.reply(boss, '好');
  await settle();
  f.reply(child, '按钮好了');
  await settle();
  expect(latest(f).state).toBe('running');
  // 追加回合开了头却迟迟不结束
  f.start(child);
  await new Promise((resolve) => setTimeout(resolve, 40 * 240 + 50));
  await settle();
  expect(latest(f)).toMatchObject({
    state: 'completed',
    result: '按钮好了',
    appends: [{ ok: false }],
  });
  expect(resultsTo(f, boss)).toHaveLength(1);
  expect(resultsTo(f, boss)[0].text).toContain('还有 hover');
  f.delegations.dispose();
  f.groups.dispose();
}, 20_000);

it('执行结束后才到的追加：开新一次执行（来源追加），不并入已结束的执行', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, sent, child } = await handOver(f);
  f.reply(child, '改好了');
  await settle();
  await nextBossTurn(f);
  const again = await f.delegations.delegateAndConfirm(boss, {
    to: '阿后',
    taskId: '#1',
    task: '还有 hover',
  });
  if (!again.ok) throw new Error(again.error);
  expect(again).not.toHaveProperty('merged');
  expect(again.delegationId).not.toBe(sent.delegationId);
  expect(latest(f)).toMatchObject({ trigger: 'append', childConversationId: child });
  expect(f.delegations.list()[0]).not.toHaveProperty('appends');
  f.delegations.dispose();
  f.groups.dispose();
});

it('发起会话不同（群里点了新对话）：不插入，排成下一次执行，等当前执行结束再开工', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  await f.groups.send(f.chat.id, '安排一下', { deliveryId: 'human-1' });
  await settle();
  const boss = f.conversation(f.lin);
  f.start(boss);
  const sent = f.delegations.delegate(boss, { to: '阿后', task: '修复登录页按钮', keep: true });
  if (!sent.ok) throw new Error(sent.error);
  await settle();
  const child = f.child(sent.delegationId);
  f.persist(child);
  f.start(child);
  f.reply(boss, '已安排');
  await settle();
  f.delegations.startOver(f.chat.id);
  f.host.resetSessions(f.chat.id);
  const fresh = await nextBossTurn(f);
  expect(fresh).not.toBe(boss);
  const next = await f.delegations.delegateAndConfirm(fresh, {
    to: '阿后',
    taskId: '#1',
    task: '还有 hover',
  });
  if (!next.ok) throw new Error(next.error);
  expect(next).not.toHaveProperty('merged');
  expect(next.delegationId).not.toBe(sent.delegationId);
  expect(latest(f)).toMatchObject({
    state: 'queued',
    trigger: 'append',
    childConversationId: child,
    parentConversationId: fresh,
  });
  expect(f.delegations.list()[0]).not.toHaveProperty('appends');
  // 新会话再追加：并入它自己排着的那次，不再多排一次
  expect(
    await f.delegations.delegateAndConfirm(fresh, {
      to: '阿后',
      taskId: '#1',
      task: '再加个 focus',
    })
  ).toMatchObject({ merged: true, delegationId: next.delegationId, delivery: 'deferred' });
  expect(f.delegations.list()).toHaveLength(2);
  expect(f.to(child).filter((prompt) => /还有 hover|再加个 focus/.test(prompt.text))).toEqual([]);
  // 运行中的状态事件不能把排着的下一次执行提前算开工
  f.delegations.observeRunning(child);
  expect(latest(f).state).toBe('queued');
  f.reply(child, '按钮好了');
  await settle();
  expect(f.delegations.list()[0]).toMatchObject({ state: 'completed' });
  const [run, extra] = f.to(child).slice(-2);
  expect(run).toMatchObject({ deliveryId: next.delegationId });
  expect(run.text).toContain('trigger="append"');
  expect(extra.text).toContain('再加个 focus');
  f.start(child);
  expect(latest(f).state).toBe('running');
  f.delegations.dispose();
  f.groups.dispose();
});

it('换批次：batchId 转到最近一轮，keep 取并集；停掉最近一轮只取消没有 keep 的', async () => {
  const f = fixture(['林经理', '阿后', '小三'], undefined, true);
  await f.groups.send(f.chat.id, '安排一下', { deliveryId: 'human-1' });
  await settle();
  const boss = f.conversation(f.lin);
  f.start(boss);
  const a = f.delegations.delegate(boss, { to: '阿后', task: '活 A', keep: true });
  const b = f.delegations.delegate(boss, { to: '小三', task: '活 B' });
  if (!a.ok || !b.ok) throw new Error('delegate');
  await settle();
  for (const id of [a.delegationId, b.delegationId]) f.start(f.child(id));
  f.reply(boss, '已安排');
  await settle();
  await nextBossTurn(f);
  const turn = f.host.turnKey(boss);
  expect(
    f.delegations.delegate(boss, { to: '阿后', taskId: a.taskId!, task: 'A 追加' })
  ).toMatchObject({
    merged: true,
  });
  expect(
    f.delegations.delegate(boss, { to: '小三', taskId: b.taskId!, task: 'B 追加' })
  ).toMatchObject({
    merged: true,
  });
  const byId = (id: string) => f.delegations.list().find((record) => record.id === id)!;
  expect(byId(a.delegationId)).toMatchObject({ batchId: turn, keep: true });
  expect(byId(b.delegationId)).toMatchObject({ batchId: turn });
  expect(byId(b.delegationId)).not.toHaveProperty('keep');
  await f.host.stopTurn(f.chat.id, f.lin);
  await settle();
  expect(byId(a.delegationId).state).toBe('running');
  expect(byId(b.delegationId).state).toBe('canceled');
  f.delegations.dispose();
  f.groups.dispose();
});

it('重启后恢复：未跑完的追加记 ok=false，batch / keep 已落盘，结果按最近一轮只回一次', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, child } = await handOver(f);
  await nextBossTurn(f);
  f.delegations.delegate(boss, { to: '阿后', taskId: '#1', task: '还有 hover', keep: true });
  await settle();
  const append = f.to(child).at(-1)!.deliveryId!;
  f.observe(child, { type: 'delivery-deferred', deliveryId: append });
  const turn = f.host.turnKey(boss);
  f.reply(boss, '好');
  await settle();
  f.reply(child, '按钮好了');
  await settle();
  f.delegations.dispose();
  const restarted = f.makeDelegations();
  await settle();
  expect(restarted.list()).toHaveLength(1);
  expect(restarted.list()[0]).toMatchObject({
    state: 'failed',
    failure: 'interrupted',
    batchId: turn,
    keep: true,
    appends: [{ deliveryId: append, ok: false }],
  });
  expect(resultsTo(f, boss)).toHaveLength(1);
  expect(resultsTo(f, boss)[0].text).toContain('还有 hover');
  f.start(boss);
  await settle();
  restarted.dispose();
  const again = f.makeDelegations();
  await settle();
  expect(resultsTo(f, boss)).toHaveLength(1);
  again.dispose();
  f.groups.dispose();
});

it('人在看板上改派：新成员这一轮附 <previous-runs>，群里只显示指派那句，其他成员不带', async () => {
  const f = fixture(['林经理', '阿后', '小三'], undefined, true);
  const { boss, child } = await handOver(f);
  f.observe(child, {
    type: 'message-upsert',
    index: 99,
    message: { role: 'assistant', content: [{ type: 'text', text: '颜色改了一半' }] },
  });
  f.fail(child);
  await settle();
  expect(task1(f)).toMatchObject({ status: 'blocked', assigneeBotId: f.hou });
  expect(await f.tasks!.assign(f.chat.id, '#1', f.ids[2])).toMatchObject({ ok: true });
  await settle();
  const third = f.conversation(f.ids[2]);
  const text = f.to(third).at(-1)!.text;
  expect(text).toContain('请处理任务 #1');
  expect(text).toContain('<previous-runs>');
  expect(text).toContain('<request>修复登录页按钮</request>');
  const human = f
    .entries()
    .filter((entry) => entry.kind === 'human')
    .at(-1);
  expect(human).toMatchObject({ text: '@小三 请处理任务 #1：修复登录页按钮' });
  // 同一条消息投给别的成员（没被 @）不展开
  const chat = f.chats.get(f.chat.id)!;
  expect(await f.composer.groupAppendix(chat, f.lin, human ? [human] : [])).toBe('');
  expect(f.to(boss).some((prompt) => prompt.text.includes('<previous-runs>'))).toBe(false);
  f.delegations.dispose();
  f.groups.dispose();
});

/** 执行人登记卡住并自然结束本轮 */
async function blockedBy(f: ReturnType<typeof fixture>, child: string, need = '数据库密码') {
  expect(f.delegations.reportBlocked(child, { need, waitFor: 'parent' })).toMatchObject({
    ok: true,
  });
  f.reply(child, `前端做完了，缺${need}`);
  await settle();
}

it('report_blocked：本轮自然结束后记 blocked，释放名额，结果 status=blocked 回给发起方；任务卡住·缺 X', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, sent, child } = await handOver(f);
  // 挂看板任务的委派会话才挂 report_blocked，并在说明里写清只有它才算卡住
  const spec = f.spawned.find((item) => item.conversationId === child);
  expect(spec?.delegationTask).toBe(true);
  expect(spec?.instructionText).toContain('Only report_blocked marks the task as blocked');
  expect(f.spawned.find((item) => item.conversationId === boss)?.delegationTask).toBeUndefined();
  // 不是委派子会话 / 不在执行中：拒绝
  expect(f.delegations.reportBlocked(boss, { need: 'x' })).toMatchObject({ ok: false });
  expect(f.delegations.reportBlocked(child, { need: '数据库密码', waitFor: 'human' })).toEqual({
    ok: true,
    instruction: expect.stringContaining('end your turn'),
  });
  // 登记后回合还在跑：不提前结算
  expect(latest(f).state).toBe('running');
  f.reply(child, '前端做完了，缺数据库密码');
  await settle();
  expect(latest(f)).toMatchObject({
    id: sent.delegationId,
    state: 'blocked',
    blocked: { need: '数据库密码', waitFor: 'human' },
    result: '前端做完了，缺数据库密码',
  });
  expect(f.host.isBusy(child)).toBe(false);
  expect(task1(f)).toMatchObject({
    status: 'blocked',
    blockedReason: 'need',
    blockedNeed: '数据库密码',
    assigneeBotId: f.hou,
    blockedStreak: { [f.hou]: 1 },
  });
  const results = resultsTo(f, boss);
  expect(results).toHaveLength(1);
  expect(results[0].text).toContain('status="blocked"');
  expect(results[0].text).toContain('数据库密码');
  f.delegations.dispose();
  f.groups.dispose();
});

it('只在结果里提问、没调 report_blocked：照常交付进待验收', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { child } = await handOver(f);
  f.reply(child, '先按 sqlite 做了。要换成 Postgres 吗？');
  await settle();
  expect(latest(f).state).toBe('completed');
  expect(task1(f)).toMatchObject({ status: 'review' });
  expect(task1(f)).not.toHaveProperty('blockedReason');
  f.delegations.dispose();
  f.groups.dispose();
});

it('解除卡住：群主对同成员同 taskId 再 delegate → 同一会话新执行（trigger reply），交付后清零', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, child } = await handOver(f);
  await blockedBy(f, child);
  f.start(boss);
  const answered = f.delegations.delegate(boss, { to: '阿后', taskId: '#1', task: '密码是 x' });
  if (!answered.ok) throw new Error(answered.error);
  await settle();
  expect(latest(f)).toMatchObject({
    id: answered.delegationId,
    trigger: 'reply',
    childConversationId: child,
  });
  expect(latest(f)).not.toHaveProperty('retryOf');
  expect(f.to(child).at(-1)?.text).toContain('task="#1" run="2" trigger="reply">\n密码是 x');
  expect(task1(f)).toMatchObject({ status: 'doing', delegationId: answered.delegationId });
  f.start(child);
  f.reply(child, '好了');
  await settle();
  expect(task1(f)).toMatchObject({ status: 'review' });
  expect(task1(f)).not.toHaveProperty('blockedStreak');
  f.delegations.dispose();
  f.groups.dispose();
});

it('连续 3 次缺信息卡住：群主不能再代答，人在任务卡回复后同一会话接着做', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, child } = await handOver(f);
  await blockedBy(f, child, '一');
  for (const need of ['二', '三']) {
    f.start(boss);
    const answered = f.delegations.delegate(boss, { to: '阿后', taskId: '#1', task: '答' });
    if (!answered.ok) throw new Error(answered.error);
    await settle();
    f.start(child);
    await blockedBy(f, child, need);
  }
  expect(task1(f)).toMatchObject({ status: 'blocked', blockedStreak: { [f.hou]: 3 } });
  f.start(boss);
  expect(f.delegations.delegate(boss, { to: '阿后', taskId: '#1', task: '答' })).toMatchObject({
    ok: false,
    error: expect.stringContaining('only a human can answer'),
  });
  expect(await f.tasks!.reply(f.chat.id, '#1', '人来答：用 x')).toMatchObject({ ok: true });
  await settle();
  expect(latest(f)).toMatchObject({
    trigger: 'reply',
    childConversationId: child,
    parentConversationId: boss,
  });
  expect(f.to(child).at(-1)?.text).toContain('人来答：用 x');
  expect(task1(f)).toMatchObject({ status: 'doing' });
  f.delegations.dispose();
  f.groups.dispose();
});

it('人在任务卡回复解除卡住：群里开过新对话 → 结果回群主的新会话', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { boss, child } = await handOver(f);
  await blockedBy(f, child);
  f.start(boss);
  f.reply(boss, '等人来答');
  await settle();
  f.delegations.startOver(f.chat.id);
  f.host.resetSessions(f.chat.id);
  expect(await f.tasks!.reply(f.chat.id, '#1', '密码是 x')).toMatchObject({ ok: true });
  const fresh = f.conversation(f.lin);
  expect(latest(f)).toMatchObject({
    trigger: 'reply',
    childConversationId: child,
    parentConversationId: fresh,
  });
  await settle();
  f.start(child);
  f.reply(child, '好了');
  await settle();
  expect(task1(f)).toMatchObject({ status: 'review' });
  expect(f.to(fresh).at(-1)?.text).toContain(`<delegation-result id="${latest(f).id}"`);
  f.delegations.dispose();
  f.groups.dispose();
});

it('软停止：登记卡住后 5 分钟没收尾只中止当前回合；排队的追加转成下一次执行不丢；不取消子委派；停止原因区别于人工停止', async () => {
  const f = fixture(['林经理', '阿后', '小三'], undefined, true, undefined, 20);
  const finished: Array<{ conversationId: string; error?: string; stopped?: true }> = [];
  f.host.onTurnFinished((event) => finished.push(event));
  const { boss, sent, child } = await handOver(f);
  // 执行人这一轮转派了一个子委派
  const nested = f.delegations.delegate(child, { to: '小三', task: '查一下配置' });
  if (!nested.ok) throw new Error(nested.error);
  await settle();
  await nextBossTurn(f);
  expect(f.delegations.reportBlocked(child, { need: '数据库密码' })).toMatchObject({ ok: true });
  // 群主追加（steer 进当前回合，还没被 worker 收下）
  const pending = f.delegations.delegateAndConfirm(boss, {
    to: '阿后',
    taskId: '#1',
    task: '密码是 x',
  });
  await settle();
  const append = f.to(child).at(-1)!.deliveryId!;
  await new Promise((resolve) => setTimeout(resolve, 5 * 20 + 60));
  await settle();
  expect(f.delegations.list().find((record) => record.id === sent.delegationId)).toMatchObject({
    state: 'blocked',
    blocked: { need: '数据库密码' },
  });
  expect(finished.find((event) => event.conversationId === child)).toMatchObject({
    ok: false,
    error: 'blocked-stop',
  });
  expect(finished.find((event) => event.conversationId === child)).not.toHaveProperty('stopped');
  // 子委派不级联取消
  expect(f.delegations.list().find((record) => record.id === nested.delegationId)?.state).not.toBe(
    'canceled'
  );
  // 追加转成下一次执行，重新投给同一会话
  const next = latest(f);
  expect(next).toMatchObject({
    trigger: 'append',
    childConversationId: child,
    parentConversationId: boss,
    appends: [{ deliveryId: append }],
  });
  expect(next.appends?.[0]).not.toHaveProperty('ok');
  expect(f.to(child).at(-1)).toMatchObject({ deliveryId: append });
  f.start(child);
  expect(await pending).toMatchObject({ merged: true, delivery: 'accepted' });
  f.reply(child, '拿到密码，做完了');
  await settle();
  // #12：这一轮结束时它转派的子委派还没结束，执行保持进行中等下层结果（追加已在本轮跑完）
  expect(f.delegations.list().find((record) => record.id === next.id)).toMatchObject({
    state: 'running',
    waiting: { text: '拿到密码，做完了' },
    appends: [{ ok: true }],
  });
  const grandchild = f.child(nested.delegationId);
  f.start(grandchild);
  f.reply(grandchild, '配置没问题');
  await settle();
  expect(f.to(child).at(-1)?.text).toContain(`<delegation-result id="${nested.delegationId}"`);
  f.start(child);
  f.reply(child, '配置也确认了，做完了');
  await settle();
  expect(f.delegations.list().find((record) => record.id === next.id)).toMatchObject({
    state: 'completed',
    appends: [{ ok: true }],
  });
  expect(task1(f)).toMatchObject({ status: 'review' });
  f.delegations.dispose();
  f.groups.dispose();
}, 20_000);

it('软停止：执行中人在任务卡插的话还没被收下 → 转成下一次执行重新投递，不丢', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true, undefined, 20);
  const { sent, child } = await handOver(f);
  expect(f.delegations.reportBlocked(child, { need: '数据库密码' })).toMatchObject({ ok: true });
  expect(await f.tasks!.reply(f.chat.id, '#1', '密码在 1Password 里')).toMatchObject({ ok: true });
  await settle();
  const steer = f.to(child).at(-1)!;
  expect(steer.text).toContain('密码在 1Password 里');
  await new Promise((resolve) => setTimeout(resolve, 5 * 20 + 60));
  await settle();
  expect(f.delegations.list().find((record) => record.id === sent.delegationId)?.state).toBe(
    'blocked'
  );
  const next = latest(f);
  expect(next).toMatchObject({ trigger: 'append', state: 'queued', childConversationId: child });
  expect(f.to(child).at(-1)).toMatchObject({ deliveryId: steer.deliveryId });
  f.start(child);
  f.reply(child, '用上了，做完');
  await settle();
  expect(f.delegations.list().find((record) => record.id === next.id)).toMatchObject({
    state: 'completed',
    result: '用上了，做完',
  });
  expect(task1(f)).toMatchObject({ status: 'review' });
  f.delegations.dispose();
  f.groups.dispose();
}, 20_000);

it('卡住转出的下一次执行：排队的投递都没跑起来就记失败，不会一直占着', async () => {
  const f = fixture(['林经理', '阿后'], undefined, true);
  const { child } = await handOver(f);
  expect(f.delegations.reportBlocked(child, { need: '数据库密码' })).toMatchObject({ ok: true });
  expect(await f.tasks!.reply(f.chat.id, '#1', '密码在 1Password 里')).toMatchObject({ ok: true });
  await settle();
  // 插话改排到下一轮（worker 回合收尾时没收下）
  f.observe(child, { type: 'delivery-deferred', deliveryId: f.to(child).at(-1)!.deliveryId });
  f.reply(child, '缺密码，先停在这');
  await settle();
  const next = latest(f);
  expect(next).toMatchObject({ trigger: 'append', state: 'queued' });
  // 排队的投递被撤掉（没开跑）
  await f.host.abortConversation(child);
  await settle();
  expect(f.delegations.list().find((record) => record.id === next.id)).toMatchObject({
    state: 'failed',
    failure: 'error',
  });
  f.delegations.dispose();
  f.groups.dispose();
});

it('委派完成：结果以被委派成员身份写进群时间线（幂等、不路由），卡片不再带摘要，发起人不重复看到', async () => {
  const f = fixture(['吴经理', '小设']);
  await f.groups.send(f.chat.id, '出一版设计', { deliveryId: 'human-1' });
  await settle();
  const boss = f.conversation(f.ids[0]);
  f.start(boss);
  const sent = f.delegations.delegate(boss, { to: '小设', task: '设计' });
  if (!sent.ok) throw new Error(sent.error);
  await settle();
  const child = f.child(sent.delegationId);
  f.start(child);
  f.reply(boss, '已安排');
  await settle();
  f.reply(child, '设计稿完成，见 design.md');
  await settle();
  const result = f.entries().find((e) => e.id === `delegation-result:${sent.delegationId}`);
  expect(result).toMatchObject({
    kind: 'bot',
    botId: f.ids[1],
    conversationId: child,
    turnId: expect.stringMatching(/^turn-/),
    delegationId: sent.delegationId,
    text: '设计稿完成，见 design.md',
  });
  const record = f.delegations.list().find((r) => r.id === sent.delegationId)!;
  expect(record.resultSeq).toBe(result!.seq);
  expect(record).not.toHaveProperty('pendingResultEntry');
  // 结果不经群路由：没有新的成员群会话被投递
  expect(f.chats.get(f.chat.id)?.sessions[f.ids[1]]).toBeUndefined();
  const lead = f.to(boss).at(-1)!.text;
  expect(lead.startsWith(`<delegation-result id="${sent.delegationId}"`)).toBe(true);
  expect(lead).not.toContain(`seq="${result!.seq}"`);
  f.start(boss);
  f.reply(boss, '收到');
  await settle();
  const card = f.entries().find((e) => e.kind === 'delegation');
  expect(card).toMatchObject({ delegationId: sent.delegationId, state: 'completed' });
  expect(card).not.toHaveProperty('summary');
  expect(f.entries().filter((e) => e.id === `delegation-result:${sent.delegationId}`)).toHaveLength(
    1
  );
  // 被委派者本人的群会话能看到自己交付的结果
  await f.groups.send(f.chat.id, '@小设 再看下细节', { deliveryId: 'human-2' });
  await settle();
  const own = f.to(f.conversation(f.ids[1])).at(-1)!.text;
  expect(own).toContain(`delegation="${sent.delegationId}"`);
  expect(own).toContain('设计稿完成，见 design.md');
  f.delegations.dispose();
  f.groups.dispose();
});

it('失败的委派和第二层委派的结果不写进群时间线', async () => {
  const f = fixture(['吴经理', '小设', '阿全', '阿测']);
  await f.groups.send(f.chat.id, '开工', { deliveryId: 'human-1' });
  await settle();
  const boss = f.conversation(f.ids[0]);
  f.start(boss);
  const first = f.delegations.delegate(boss, { to: '小设', task: '设计' });
  const second = f.delegations.delegate(boss, { to: '阿全', task: '代码' });
  if (!first.ok || !second.ok) throw new Error('delegate');
  await settle();
  const designer = f.child(first.delegationId);
  const coder = f.child(second.delegationId);
  f.start(designer);
  f.start(coder);
  f.reply(boss, '已安排');
  await settle();
  // 第二层：小设的子会话再委派阿测
  const nested = f.delegations.delegate(designer, { to: '阿测', task: '帮我切图' });
  if (!nested.ok) throw new Error(nested.error);
  await settle();
  const nestedChild = f.child(nested.delegationId);
  f.start(nestedChild);
  f.reply(nestedChild, '切好了');
  await settle();
  f.fail(coder, 'compile error');
  await settle();
  const results = f.entries().filter((e) => e.id.startsWith('delegation-result:'));
  expect(results).toEqual([]);
  expect(f.delegations.list().find((r) => r.id === nested.delegationId)).toMatchObject({
    state: 'completed',
  });
  expect(f.delegations.list().find((r) => r.id === nested.delegationId)).not.toHaveProperty(
    'resultSeq'
  );
  expect(f.delegations.list().find((r) => r.id === nested.delegationId)).not.toHaveProperty(
    'pendingResultEntry'
  );
  f.delegations.dispose();
  f.groups.dispose();
});

it('嵌套委派：第一层等下层结果整合完才交回并入群；群里只有第一层的结果，只写一次', async () => {
  const f = fixture(['吴经理', '小设', '阿测']);
  await f.groups.send(f.chat.id, '出一版设计', { deliveryId: 'human-1' });
  await settle();
  const boss = f.conversation(f.ids[0]);
  f.start(boss);
  const sent = f.delegations.delegate(boss, { to: '小设', task: '设计' });
  if (!sent.ok) throw new Error(sent.error);
  await settle();
  const designer = f.child(sent.delegationId);
  f.start(designer);
  f.reply(boss, '已安排');
  await settle();
  const nested = f.delegations.delegate(designer, { to: '阿测', task: '切图' });
  if (!nested.ok) throw new Error(nested.error);
  await settle();
  const nestedChild = f.child(nested.delegationId);
  f.start(nestedChild);
  const results = () => f.entries().filter((e) => e.id.startsWith('delegation-result:'));
  const toBoss = () => f.to(boss).filter((p) => p.text.includes('<delegation-result'));
  f.reply(designer, '设计稿初版好了，等阿测切图');
  await settle();
  expect(f.store.get(sent.delegationId)?.state).toBe('running');
  expect(results()).toEqual([]);
  expect(toBoss()).toHaveLength(0);
  f.reply(nestedChild, '切好了');
  await settle();
  expect(f.to(designer).at(-1)!.text).toContain(`<delegation-result id="${nested.delegationId}"`);
  expect(results()).toEqual([]);
  f.start(designer);
  f.reply(designer, '设计稿和切图都完成');
  await settle();
  expect(results()).toHaveLength(1);
  expect(results()[0]).toMatchObject({
    id: `delegation-result:${sent.delegationId}`,
    botId: f.ids[1],
    conversationId: designer,
    text: '设计稿和切图都完成',
  });
  expect(toBoss()).toHaveLength(1);
  expect(toBoss()[0].text).toContain('设计稿和切图都完成');
  expect(toBoss()[0].text).not.toContain('等阿测切图');
  f.start(boss);
  f.reply(boss, '收到');
  await settle();
  f.delegations.dispose();
  const again = f.makeDelegations();
  await settle();
  expect(results()).toHaveLength(1);
  expect(toBoss()).toHaveLength(1);
  again.dispose();
  f.groups.dispose();
});

/**
 * 群主委派小设、小设的子会话已开工；随后服务停掉（模拟崩溃），
 * 记录按 finish 的样子落盘为 completed + 待入群标记，群条目还没写。
 */
async function crashAfterFinish(
  f: ReturnType<typeof fixture>,
  options: { chatId?: string; marker?: boolean } = {}
) {
  const chatId = options.chatId ?? f.chat.id;
  await f.groups.send(chatId, '出一版设计', { deliveryId: 'human-1' });
  await settle();
  const boss = f.chats.get(chatId)!.sessions[f.ids[0]].conversationId;
  f.start(boss);
  const sent = f.delegations.delegate(boss, { to: '小设', task: '设计' });
  if (!sent.ok) throw new Error(sent.error);
  await settle();
  const child = f.child(sent.delegationId);
  f.start(child);
  f.reply(boss, '已安排');
  await settle();
  f.delegations.dispose();
  const record = f.store.get(sent.delegationId)!;
  f.store.save({
    ...record,
    state: 'completed',
    result: '设计稿完成，见 design.md',
    finishedAt: Date.now(),
    ...(options.marker === false ? {} : { pendingResultEntry: { turnId: 'turn-crash' } }),
  });
  return { boss, child, id: sent.delegationId, chatId };
}

const resultEntries = (f: ReturnType<typeof fixture>, chatId: string, id: string) =>
  f.chats
    .readEntries(chatId, { limit: Number.MAX_SAFE_INTEGER })
    .filter((entry) => entry.id === `delegation-result:${id}`);
const mentions = (text: string, needle: string) => text.split(needle).length - 1;

it('崩溃点 1：记录已落盘、群条目未写——重启补写这条成员结果，发起人只随回传看一次全文', async () => {
  const f = fixture(['吴经理', '小设']);
  const { boss, child, id } = await crashAfterFinish(f);
  expect(resultEntries(f, f.chat.id, id)).toEqual([]);
  const before = f.to(boss).length;
  const restarted = f.makeDelegations();
  await settle();
  const entries = resultEntries(f, f.chat.id, id);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    kind: 'bot',
    botId: f.ids[1],
    conversationId: child,
    turnId: 'turn-crash',
    delegationId: id,
    text: '设计稿完成，见 design.md',
  });
  expect(entries[0]).not.toHaveProperty('hiddenFrom');
  const record = f.store.get(id)!;
  expect(record.resultSeq).toBe(entries[0].seq);
  expect(record).not.toHaveProperty('pendingResultEntry');
  // 补写不经群路由；发起人收到一次回传（之前没收到过），全文只出现一次
  expect(f.chats.get(f.chat.id)?.sessions[f.ids[1]]).toBeUndefined();
  expect(f.to(boss)).toHaveLength(before + 1);
  const lead = f.to(boss).at(-1)!.text;
  expect(lead.startsWith(`<delegation-result id="${id}"`)).toBe(true);
  expect(mentions(lead, '设计稿完成，见 design.md')).toBe(1);
  f.start(boss);
  f.reply(boss, '收到');
  await settle();
  restarted.dispose();
  // 重复启动：不再写、不再回传
  const again = f.makeDelegations();
  await settle();
  expect(resultEntries(f, f.chat.id, id)).toHaveLength(1);
  expect(f.to(boss)).toHaveLength(before + 1);
  again.dispose();
  f.groups.dispose();
});

it('崩溃点 2：群条目已写、resultSeq 未存——重启从时间线回填 resultSeq，不重复写条目', async () => {
  const f = fixture(['吴经理', '小设']);
  const { boss, child, id } = await crashAfterFinish(f);
  const written = f.chats.appendEntry(f.chat.id, {
    kind: 'bot',
    id: `delegation-result:${id}`,
    at: Date.now(),
    botId: f.ids[1],
    text: '设计稿完成，见 design.md',
    conversationId: child,
    turnId: 'turn-crash',
    delegationId: id,
  })!;
  const restarted = f.makeDelegations();
  await settle();
  expect(resultEntries(f, f.chat.id, id)).toHaveLength(1);
  const record = f.store.get(id)!;
  expect(record.resultSeq).toBe(written.seq);
  expect(record).not.toHaveProperty('pendingResultEntry');
  const lead = f.to(boss).at(-1)!.text;
  expect(lead.startsWith(`<delegation-result id="${id}"`)).toBe(true);
  expect(mentions(lead, '设计稿完成，见 design.md')).toBe(1);
  f.start(boss);
  f.reply(boss, '收到');
  await settle();
  // resultSeq 已回填：卡片不再带摘要
  const card = f.entries().find((e) => e.kind === 'delegation');
  expect(card).toMatchObject({ delegationId: id, state: 'completed' });
  expect(card).not.toHaveProperty('summary');
  restarted.dispose();
  const again = f.makeDelegations();
  await settle();
  expect(resultEntries(f, f.chat.id, id)).toHaveLength(1);
  expect(f.store.get(id)!.resultSeq).toBe(written.seq);
  again.dispose();
  f.groups.dispose();
});

it('旧数据不补发：没有待入群标记的已完成委派，升级后首次启动不写进群', async () => {
  const f = fixture(['吴经理', '小设']);
  const { id } = await crashAfterFinish(f, { marker: false });
  const restarted = f.makeDelegations();
  await settle();
  expect(resultEntries(f, f.chat.id, id)).toEqual([]);
  expect(f.store.get(id)).not.toHaveProperty('resultSeq');
  restarted.dispose();
  const again = f.makeDelegations();
  await settle();
  expect(resultEntries(f, f.chat.id, id)).toEqual([]);
  again.dispose();
  f.groups.dispose();
});

it('群已归档 / 群已删除 / 话题已删除：重启不补写，并清掉待入群标记', async () => {
  const archived = fixture(['吴经理', '小设']);
  const a = await crashAfterFinish(archived);
  archived.chats.update(a.chatId, (draft) => ({ ...draft, archivedAt: Date.now() }));
  archived.makeDelegations().dispose();
  expect(resultEntries(archived, a.chatId, a.id)).toEqual([]);
  expect(archived.store.get(a.id)).not.toHaveProperty('pendingResultEntry');
  expect(archived.store.get(a.id)).not.toHaveProperty('resultSeq');
  archived.groups.dispose();
  rmSync(root, { recursive: true, force: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'group-delegation-')));

  const removed = fixture(['吴经理', '小设']);
  const r = await crashAfterFinish(removed);
  removed.chats.remove(r.chatId);
  removed.makeDelegations().dispose();
  expect(resultEntries(removed, r.chatId, r.id)).toEqual([]);
  expect(removed.store.get(r.id)).not.toHaveProperty('pendingResultEntry');
  removed.groups.dispose();
  rmSync(root, { recursive: true, force: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'group-delegation-')));

  const topic = fixture(['吴经理', '小设']);
  const thread = topic.chats.createThread(topic.chat.id, '设计话题')!;
  const t = await crashAfterFinish(topic, { chatId: thread.id });
  expect(topic.store.get(t.id)?.chatId).toBe(thread.id);
  topic.chats.remove(thread.id);
  topic.makeDelegations().dispose();
  expect(resultEntries(topic, thread.id, t.id)).toEqual([]);
  expect(resultEntries(topic, topic.chat.id, t.id)).toEqual([]);
  expect(topic.store.get(t.id)).not.toHaveProperty('pendingResultEntry');
  topic.groups.dispose();
});

it('写群条目失败但回传已送达：重启补写给其他成员看，发起人的群增量里不再出现', async () => {
  const f = fixture(['吴经理', '小设', '阿全']);
  await f.groups.send(f.chat.id, '出一版设计', { deliveryId: 'human-1' });
  await settle();
  const boss = f.conversation(f.ids[0]);
  f.start(boss);
  const sent = f.delegations.delegate(boss, { to: '小设', task: '设计' });
  if (!sent.ok) throw new Error(sent.error);
  await settle();
  const child = f.child(sent.delegationId);
  f.start(child);
  f.reply(boss, '已安排');
  await settle();
  // 写结果条目时磁盘出错（只这一次）
  const append = f.chats.appendEntry.bind(f.chats);
  let broken = true;
  f.chats.appendEntry = (chatId, input) => {
    if (broken && input.id.startsWith('delegation-result:')) {
      broken = false;
      throw new Error('EIO');
    }
    return append(chatId, input);
  };
  f.reply(child, '设计稿完成，见 design.md');
  await settle();
  expect(resultEntries(f, f.chat.id, sent.delegationId)).toEqual([]);
  expect(f.store.get(sent.delegationId)).toMatchObject({
    state: 'completed',
    pendingResultEntry: expect.any(Object),
  });
  // 回传照常送达发起人
  expect(f.to(boss).at(-1)!.text.startsWith(`<delegation-result id="${sent.delegationId}"`)).toBe(
    true
  );
  f.start(boss);
  f.reply(boss, '收到');
  await settle();
  expect(f.store.get(sent.delegationId)?.deliveredAt).toBeDefined();
  const delivered = f.to(boss).length;
  f.delegations.dispose();
  const restarted = f.makeDelegations();
  await settle();
  const entries = resultEntries(f, f.chat.id, sent.delegationId);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ botId: f.ids[1], hiddenFrom: f.ids[0] });
  expect(f.store.get(sent.delegationId)).not.toHaveProperty('pendingResultEntry');
  // 补写不唤醒发起人
  expect(f.to(boss)).toHaveLength(delivered);
  // 其他成员能看到；发起人下一次群增量里没有
  await f.groups.send(f.chat.id, '@阿全 看下设计', { deliveryId: 'human-2' });
  await settle();
  const quan = f.conversation(f.ids[2]);
  expect(f.to(quan).at(-1)!.text).toContain(`delegation="${sent.delegationId}">设计稿完成`);
  f.start(quan);
  f.reply(quan, '看过了');
  await settle();
  await f.groups.send(f.chat.id, '@吴经理 汇总一下', { deliveryId: 'human-3' });
  await settle();
  expect(f.to(boss)).toHaveLength(delivered + 1);
  expect(f.to(boss).at(-1)!.text).toContain('看过了');
  // 补写的成员结果条目不进发起人上下文（此前已有的委派卡片摘要是既有行为，不在此列）
  expect(f.to(boss).at(-1)!.text).not.toContain(`delegation="${sent.delegationId}"`);
  restarted.dispose();
  f.groups.dispose();
});

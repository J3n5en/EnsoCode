import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Delegation, GroupTask } from '../../../shared/types/bot';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { GroupTaskStore } from './groupTaskStore';
import { GroupTaskService, taskAfterDelegation } from './groupTasks';

let root: string;
let bots: BotStore;
let chats: BotChatStore;
let service: GroupTaskService;
let alice: string;
let bob: string;
let chatId: string;
const emit = vi.fn();
const send = vi.fn(async (_chatId: string, _text: string) => ({ ok: true as const }));
const cancelDelegation = vi.fn();
let outputs: Array<{
  role: string;
  toolCallId: string;
  toolName: string;
  isError?: boolean;
  timestamp: number;
  content: Array<{ type: 'text'; text: string }>;
}> = [];
const sessionMessages = vi.fn(async (_chatId: string, _botId: string) => outputs);
const output = (toolCallId: string, text: string, timestamp: number, isError = false) => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'bash',
  isError,
  timestamp,
  content: [{ type: 'text' as const, text }],
});

const systemTexts = () =>
  chats
    .readEntries(chatId, { limit: 100 })
    .filter((entry) => entry.kind === 'system')
    .map((entry) => (entry.kind === 'system' ? entry.text : ''));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'group-task-service-'));
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'chats'));
  const a = bots.create({ name: 'Alice' }, []);
  const b = bots.create({ name: 'Bob', tools: 'readonly' }, []);
  if (!a.ok || !b.ok) throw new Error('fixture');
  alice = a.bot.id;
  bob = b.bot.id;
  chatId = chats.create({
    kind: 'group',
    title: 'Team',
    members: [alice, bob],
    bossBotId: alice,
    workspace: { kind: 'project', projectId: 'p' },
  })!.id;
  emit.mockClear();
  send.mockClear();
  cancelDelegation.mockClear();
  outputs = [];
  sessionMessages.mockClear();
  service = new GroupTaskService({
    store: new GroupTaskStore(join(root, 'chats')),
    chats,
    bots,
    emit,
    send,
    cancelDelegation,
    sessionMessages,
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const added = (title = 'Login page', actor = 'human') => {
  const result = service.add(chatId, actor, { title });
  if (!result.ok) throw new Error(result.error);
  return result.task;
};

describe('成员动作与权限', () => {
  it('新建 / 认领 / 完成写 system 时间线并推送 tasks 事件；编辑详情不写', () => {
    const task = added();
    expect(service.claim(chatId, bob, '#1')).toMatchObject({
      ok: true,
      task: { status: 'doing', assigneeBotId: bob },
    });
    expect(service.update(chatId, bob, '1', { detail: 'use OAuth' })).toMatchObject({ ok: true });
    expect(service.complete(chatId, bob, task.id, 'shipped')).toMatchObject({
      ok: true,
      task: { status: 'done', result: 'shipped' },
    });
    expect(systemTexts()).toEqual([
      '用户 新建了任务 #1 Login page',
      'Bob 认领了 #1 Login page',
      'Bob 完成了 #1 Login page：shipped',
    ]);
    expect(emit).toHaveBeenCalledWith({ kind: 'tasks', chatId });
  });

  it('并发认领：第二个认领失败并给出明确错误', () => {
    added();
    const first = service.claim(chatId, alice, '#1');
    const second = service.claim(chatId, bob, '#1');
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: 'Task #1 is already claimed by Alice.' });
  });

  it('只有认领人能完成，且必须写 result；非成员与私聊一律拒绝', () => {
    added();
    service.claim(chatId, alice, '#1');
    expect(service.complete(chatId, bob, '#1', 'x')).toEqual({
      ok: false,
      error: 'Only the assignee (Alice) can complete task #1.',
    });
    expect(service.complete(chatId, alice, '#1', ' ')).toMatchObject({ ok: false });
    const carol = bots.create({ name: 'Carol' }, []);
    if (!carol.ok) throw new Error('fixture');
    expect(service.add(chatId, carol.bot.id, { title: 'x' })).toMatchObject({ ok: false });
    const direct = chats.create({
      kind: 'direct',
      title: '',
      members: [alice],
      bossBotId: null,
      workspace: { kind: 'member-home' },
    })!;
    expect(service.add(direct.id, alice, { title: 'x' })).toMatchObject({ ok: false });
  });

  it('成员只能取消自己建的或自己负责的任务；委派中的任务成员不能完成 / 取消，人类取消连带取消委派', () => {
    const task = added('A', alice);
    expect(service.cancel(chatId, bob, '#1')).toMatchObject({ ok: false });
    service.claim(chatId, bob, '#1');
    store().save(chatId, { ...store().find(chatId, task.id)!, delegationId: DELEGATION });
    expect(service.complete(chatId, bob, '#1', 'done')).toMatchObject({
      ok: false,
      error: expect.stringContaining('delegation'),
    });
    expect(service.cancel(chatId, bob, '#1')).toMatchObject({ ok: false });
    expect(cancelDelegation).not.toHaveBeenCalled();
    expect(service.cancel(chatId, 'human', '#1')).toMatchObject({
      ok: true,
      task: { status: 'canceled' },
    });
    expect(cancelDelegation).toHaveBeenCalledWith(DELEGATION);
    expect(service.claim(chatId, alice, '#1')).toEqual({
      ok: false,
      error: 'Task #1 was canceled.',
    });
  });

  it('tool 入口：list 返回名字而非 id，未知 action 报错', () => {
    added();
    service.claim(chatId, bob, '#1');
    expect(service.tool(chatId, alice, { action: 'list' })).toEqual({
      ok: true,
      tasks: [
        expect.objectContaining({
          id: '#1',
          title: 'Login page',
          status: 'doing',
          assignee: 'Bob',
        }),
      ],
    });
    expect(service.tool(chatId, alice, { action: 'add' })).toMatchObject({ ok: false });
    expect(service.tool(chatId, alice, { action: 'nuke' })).toMatchObject({ ok: false });
  });
});

describe('验收条件 check', () => {
  const check = { kind: 'output-contains' as const, text: 'XYZ_PASS' };
  let now = 1000;
  beforeEach(() => {
    now = 1000;
    service = new GroupTaskService({
      store: new GroupTaskStore(join(root, 'chats')),
      chats,
      bots,
      emit,
      send,
      cancelDelegation,
      sessionMessages,
      now: () => now,
    });
  });

  it('成员 complete 需在认领之后的最终工具结果里看到文本，否则拒绝', async () => {
    expect(service.add(chatId, alice, { title: 'Build', check })).toMatchObject({
      ok: true,
      task: { check },
    });
    outputs = [output('old', 'XYZ_PASS', 500)];
    now = 2000;
    expect(service.claim(chatId, bob, '#1')).toMatchObject({ ok: true, task: { claimedAt: 2000 } });
    outputs.push(output('a', 'XYZ_PASS', 2100), output('a', 'XYZ_PASS', 2200, true));
    const rejected = await service.tool(chatId, bob, {
      action: 'complete',
      id: '#1',
      result: 'ok',
    });
    expect(rejected).toEqual({
      ok: false,
      error: expect.stringContaining('Acceptance check failed'),
    });
    expect(sessionMessages).toHaveBeenCalledWith(chatId, bob);
    expect(store().find(chatId, '#1')).toMatchObject({ status: 'doing' });
    expect(service.complete(chatId, bob, '#1', 'ok')).toMatchObject({ ok: false });
    outputs.push(output('b', 'built: XYZ_PASS', 2300));
    expect(
      await service.tool(chatId, bob, { action: 'complete', id: '#1', result: 'ok' })
    ).toMatchObject({ ok: true, task: { status: 'done', check: 'XYZ_PASS', checkPassed: true } });
    expect(store().find(chatId, '#1')?.check).toEqual({ ...check, passed: true });
  });

  it('人类可直接完成；只有创建者能改验收条件，人类可清除', async () => {
    service.add(chatId, alice, { title: 'Build', check });
    expect(service.update(chatId, bob, '#1', { check: { ...check, text: 'X' } })).toMatchObject({
      ok: false,
    });
    expect(
      service.tool(chatId, alice, {
        action: 'update',
        id: '#1',
        check: { kind: 'output-contains', text: 'NEW' },
      })
    ).toMatchObject({ ok: true, task: { check: 'NEW' } });
    expect(service.update(chatId, 'human', '#1', { check: null })).toMatchObject({ ok: true });
    expect(store().find(chatId, '#1')).not.toHaveProperty('check');
    service.update(chatId, 'human', '#1', { check });
    expect(service.complete(chatId, 'human', '#1')).toMatchObject({
      ok: true,
      task: { status: 'done' },
    });
    expect(sessionMessages).not.toHaveBeenCalled();
  });

  it('读不到会话记录按未通过；指派也记认领时间', async () => {
    service.add(chatId, 'human', { title: 'Build', check });
    now = 3000;
    await service.assign(chatId, '#1', bob);
    expect(store().find(chatId, '#1')?.claimedAt).toBe(3000);
    sessionMessages.mockRejectedValueOnce(new Error('gone'));
    expect(
      await service.tool(chatId, bob, { action: 'complete', id: '#1', result: 'ok' })
    ).toMatchObject({ ok: false });
  });

  it('关联委派随验收流转：通过 → done 记通过；未通过 → 退回 todo，result 记原因', () => {
    const task = { ...todo, check };
    const linked = taskAfterDelegation(task, delegation({ check }), 5)!;
    expect(
      taskAfterDelegation(
        linked,
        delegation({ state: 'completed', result: 'ok', check: { ...check, passed: true } }),
        9
      )
    ).toMatchObject({ status: 'done', check: { ...check, passed: true } });
    const back = taskAfterDelegation(
      linked,
      delegation({
        state: 'failed',
        failure: 'check',
        error: '验收未通过：未在工具输出中看到「XYZ_PASS」',
        result: 'I tried',
        check: { ...check, passed: false },
      }),
      9
    )!;
    expect(back).toMatchObject({
      status: 'todo',
      result: '验收未通过：未在工具输出中看到「XYZ_PASS」',
      check: { ...check, passed: false },
    });
    expect(taskAfterDelegation(back, delegation({ id: 'next', check }), 10)?.check).toEqual(check);
  });

  it('gate 带出任务的验收条件', () => {
    const created = service.add(chatId, 'human', { title: 'Build', check });
    expect(service.gate(chatId, '#1', alice)).toEqual({
      ok: true,
      taskId: created.ok ? created.task.id : '',
      check,
    });
  });
});

describe('人类指派与成员离开', () => {
  it('指派 = 置 doing 并以人类身份 @ 成员；投递失败回滚', async () => {
    added();
    expect(await service.assign(chatId, '#1', bob)).toMatchObject({
      ok: true,
      task: { status: 'doing', assigneeBotId: bob },
    });
    expect(send).toHaveBeenCalledWith(chatId, '@Bob 请处理任务 #1：Login page');
    added('API');
    send.mockResolvedValueOnce({ ok: false, error: 'chat-stopping' } as never);
    expect(await service.assign(chatId, '#2', alice)).toEqual({
      ok: false,
      error: 'chat-stopping',
    });
    expect(store().find(chatId, '#2')).toMatchObject({ status: 'todo' });
    expect(store().find(chatId, '#2')).not.toHaveProperty('assigneeBotId');
  });

  it('删除成员：其认领中的任务退回 todo', () => {
    added();
    added('Done one');
    service.claim(chatId, bob, '#1');
    service.claim(chatId, bob, '#2');
    service.complete(chatId, bob, '#2', 'ok');
    service.releaseBot(bob);
    expect(store().find(chatId, '#1')).toMatchObject({ status: 'todo' });
    expect(store().find(chatId, '#1')).not.toHaveProperty('assigneeBotId');
    expect(store().find(chatId, '#2')).toMatchObject({ status: 'done', assigneeBotId: bob });
  });
});

const DELEGATION = '44444444-4444-4444-8444-444444444444';
function store(): GroupTaskStore {
  return (service as unknown as { deps: { store: GroupTaskStore } }).deps.store;
}
const delegation = (over: Partial<Delegation> = {}): Delegation => ({
  id: DELEGATION,
  parentConversationId: 'p',
  parentBotId: '11111111-1111-4111-8111-111111111111',
  targetBotId: '22222222-2222-4222-8222-222222222222',
  chatId: '33333333-3333-4333-8333-333333333333',
  task: 'do it',
  context: '',
  childConversationId: 'c',
  state: 'queued',
  depth: 1,
  createdAt: 1,
  taskId: '55555555-5555-4555-8555-555555555555',
  ...over,
});
const todo: GroupTask = {
  id: '55555555-5555-4555-8555-555555555555',
  seq: 3,
  title: 'Login',
  status: 'todo',
  createdBy: 'human',
  createdAt: 1,
  updatedAt: 1,
};

describe('委派联动状态机 taskAfterDelegation', () => {
  it('委派创建：todo → doing，负责人 = 目标，记 delegationId', () => {
    expect(taskAfterDelegation(todo, delegation(), 5)).toEqual({
      ...todo,
      status: 'doing',
      assigneeBotId: delegation().targetBotId,
      delegationId: DELEGATION,
      updatedAt: 5,
    });
  });

  it('发起人自己认领中的任务可转委派；别人认领 / 已有委派 / 终态不动', () => {
    const mine = { ...todo, status: 'doing' as const, assigneeBotId: delegation().parentBotId };
    expect(taskAfterDelegation(mine, delegation(), 5)?.assigneeBotId).toBe(
      delegation().targetBotId
    );
    const other = { ...mine, assigneeBotId: '66666666-6666-4666-8666-666666666666' };
    expect(taskAfterDelegation(other, delegation(), 5)).toBeUndefined();
    expect(
      taskAfterDelegation({ ...mine, delegationId: 'x' }, delegation({ id: 'y' }), 5)
    ).toBeUndefined();
    expect(taskAfterDelegation({ ...todo, status: 'done' }, delegation(), 5)).toBeUndefined();
    expect(taskAfterDelegation(todo, delegation({ taskId: 'other' }), 5)).toBeUndefined();
  });

  it('委派完成 → done 并取结果摘要；失败 / 取消 → 退回 todo 清负责人', () => {
    const linked = taskAfterDelegation(todo, delegation(), 5)!;
    expect(
      taskAfterDelegation(linked, delegation({ state: 'completed', result: 'all good' }), 9)
    ).toMatchObject({ status: 'done', result: 'all good', updatedAt: 9 });
    for (const state of ['failed', 'canceled'] as const) {
      const back = taskAfterDelegation(linked, delegation({ state }), 9)!;
      expect(back).toMatchObject({ status: 'todo', updatedAt: 9 });
      expect(back).not.toHaveProperty('assigneeBotId');
      expect(back).not.toHaveProperty('delegationId');
    }
    expect(
      taskAfterDelegation({ ...linked, status: 'canceled' }, delegation({ state: 'failed' }), 9)
    ).toBeUndefined();
  });
});

describe('委派闸门与同步', () => {
  it('gate：未知 / 终态 / 他人认领拒绝；同步后写 system 时间线', () => {
    const task = added();
    expect(service.gate(chatId, '#9', alice)).toEqual({
      ok: false,
      error: 'Task #9 not found in this group.',
    });
    expect(service.gate(chatId, '#1', alice)).toEqual({ ok: true, taskId: task.id });
    service.claim(chatId, bob, '#1');
    expect(service.gate(chatId, '#1', alice)).toEqual({
      ok: false,
      error: 'Task #1 is already claimed by Bob.',
    });
    expect(service.gate(chatId, '#1', bob)).toEqual({ ok: true, taskId: task.id });
    const record = delegation({ chatId, parentBotId: bob, targetBotId: alice, taskId: task.id });
    service.sync(record);
    expect(store().find(chatId, '#1')).toMatchObject({
      assigneeBotId: alice,
      delegationId: DELEGATION,
    });
    service.sync({ ...record, state: 'completed', result: 'done!' });
    expect(store().find(chatId, '#1')).toMatchObject({ status: 'done', result: 'done!' });
    expect(systemTexts().slice(-2)).toEqual([
      'Bob 把 #1 Login page 委派给 Alice',
      'Alice 完成了 #1 Login page：done!',
    ]);
  });
});

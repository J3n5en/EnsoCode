import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnModelConfig } from '@shared/types/agent';
import type { BotChat, Delegation } from '@shared/types/bot';
import type { BotChatStateResult } from '@shared/types/botIpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInitialTitleUserText,
  ROLLING_TITLE_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
  titleSummaryTimeoutMs,
} from '../../../agent/titleSummary';
import { BotChatStore } from './chatStore';
import { ThreadTitler, type ThreadWork, threadWorkPending } from './threadTitler';

const BOT_A = '11111111-1111-4111-8111-111111111111';
const BOT_B = '22222222-2222-4222-8222-222222222222';
const QUIET = 50;

const model = (id: string): SpawnModelConfig =>
  ({
    api: 'openai-completions',
    baseUrl: 'https://x.test',
    apiKey: 'k',
    modelId: id,
    settingsProviderId: 'p',
  }) as SpawnModelConfig;

interface Call {
  systemPrompt: string;
  userText: string;
  candidates: SpawnModelConfig[];
  timeoutMs: number;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

let root: string;
let chats: BotChatStore;
let enabled: boolean;
let calls: Call[];
let emitted: string[];
let candidates: SpawnModelConfig[];
let idleState: BotChatStateResult;
let busy: Set<string>;
let queued: Set<string>;
let delegations: Delegation[];
let titler: ThreadTitler;

const work: ThreadWork = {
  groupState: () => idleState,
  conversationBusy: (id) => busy.has(id),
  queued: (chatId) => queued.has(chatId),
  delegations: (chatId) => delegations.filter((record) => record.chatId === chatId),
};

function makeTitler(): ThreadTitler {
  return new ThreadTitler({
    chats,
    enabled: () => enabled,
    work,
    candidates: async () => candidates,
    complete: (input) =>
      new Promise<string>((resolve, reject) => calls.push({ ...input, resolve, reject })),
    emit: (chatId) => emitted.push(chatId),
    quietMs: QUIET,
  });
}

function newGroup(): BotChat {
  const chat = chats.create({
    kind: 'group',
    title: '发布小组',
    members: [BOT_A, BOT_B],
    bossBotId: BOT_A,
    workspace: { kind: 'project', projectId: 'p1' },
  });
  if (!chat) throw new Error('create failed');
  return chat;
}

/** 功能上线前的旧数据：没有 autoTitle 标记 */
function legacy(chatId: string): void {
  chats.update(chatId, (draft) => {
    delete draft.autoTitle;
    return draft;
  });
}

let turn = 0;
function human(chatId: string, text: string) {
  return chats.appendEntry(chatId, {
    kind: 'human',
    id: `h${++turn}`,
    at: 1,
    text,
    mentions: [],
  })!;
}
function bot(chatId: string, text: string, botId = BOT_A) {
  return chats.appendEntry(chatId, {
    kind: 'bot',
    id: `b${++turn}`,
    at: 1,
    botId,
    text,
    conversationId: `c-${botId}`,
    turnId: `t${turn}`,
  })!;
}

/** 人类在话题里发出一条消息（时间线已落盘后才回调） */
function send(chatId: string, text: string): void {
  human(chatId, text);
  titler.humanSent(chatId, text);
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(QUIET);
  await titler.settled();
}

/** 等到第 n 次模型调用发出 */
async function callAt(n: number): Promise<Call> {
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(n));
  return calls[n];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  root = mkdtempSync(join(tmpdir(), 'thread-titler-'));
  chats = new BotChatStore(root);
  enabled = true;
  calls = [];
  emitted = [];
  candidates = [model('m1')];
  idleState = {
    ok: true,
    current: null,
    queue: [],
    hops: 0,
    turnsByBot: {},
    pendingHuman: false,
    routing: false,
  };
  busy = new Set();
  queued = new Set();
  delegations = [];
  titler = makeTitler();
});
afterEach(() => {
  titler.dispose();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('threadWorkPending：话题内是否还有成员在工作', () => {
  const delegation = (patch: Partial<Delegation>): Delegation => ({
    id: 'd1',
    parentConversationId: 'c-a',
    parentBotId: BOT_A,
    targetBotId: BOT_B,
    chatId: null,
    task: 't',
    context: '',
    childConversationId: 'child',
    state: 'running',
    depth: 1,
    createdAt: 1,
    ...patch,
  });

  it('空闲：无当前发言、无排队、无待路由、无忙碌会话、无未结束委派', () => {
    const chat = newGroup();
    expect(threadWorkPending(chat, work)).toBe(false);
  });

  it('接力中 / 排队 / 待处理人类消息 / 智能选人中都算没结束', () => {
    const chat = newGroup();
    for (const patch of [
      { current: BOT_A },
      { queue: [BOT_B] },
      { pendingHuman: true },
      { routing: true },
    ]) {
      idleState = { ...(idleState as Extract<BotChatStateResult, { ok: true }>), ...patch };
      expect(threadWorkPending(chat, work)).toBe(true);
      idleState = { ...idleState, current: null, queue: [], pendingHuman: false, routing: false };
    }
  });

  it('成员会话运行中 / 宿主排队投递都算没结束', () => {
    const chat = chats.update(newGroup().id, (draft) => {
      draft.sessions[BOT_A] = { conversationId: 'c-a', cursor: 0 };
      return draft;
    })!;
    busy.add('c-a');
    expect(threadWorkPending(chat, work)).toBe(true);
    busy.clear();
    queued.add(chat.id);
    expect(threadWorkPending(chat, work)).toBe(true);
  });

  it('委派：排队 / 运行中、或已结束但结果还没送回当前发起会话，都算没结束', () => {
    const chat = chats.update(newGroup().id, (draft) => {
      draft.sessions[BOT_A] = { conversationId: 'c-a', cursor: 0 };
      return draft;
    })!;
    delegations = [delegation({ chatId: chat.id, state: 'queued' })];
    expect(threadWorkPending(chat, work)).toBe(true);
    delegations = [delegation({ chatId: chat.id, state: 'running' })];
    expect(threadWorkPending(chat, work)).toBe(true);
    // 第一层这一轮已结束、在等它发起的下层委派：仍是 running，算没结束
    delegations = [
      delegation({ chatId: chat.id, state: 'running', waiting: { since: 1, text: '等下层' } }),
    ];
    expect(threadWorkPending(chat, work)).toBe(true);
    delegations = [delegation({ chatId: chat.id, state: 'completed', result: 'ok' })];
    expect(threadWorkPending(chat, work)).toBe(true);
    delegations = [delegation({ chatId: chat.id, state: 'completed', deliveredAt: 5 })];
    expect(threadWorkPending(chat, work)).toBe(false);
    // 发起会话已换代（新对话 / 移除成员）：结果永远不会再送回，不能把话题卡住
    delegations = [delegation({ chatId: chat.id, state: 'failed', parentConversationId: 'stale' })];
    expect(threadWorkPending(chat, work)).toBe(false);
    // 别的话题的委派不算
    delegations = [delegation({ chatId: 'other', state: 'running' })];
    expect(threadWorkPending(chat, work)).toBe(false);
  });
});

describe('ThreadTitler', () => {
  it('开关开：新话题首条人类消息先取首句占位，随后被 initial AI 标题替换', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '  帮忙梳理发布清单\n细节');
    expect(chats.get(thread.id)?.threadTitle).toBe('帮忙梳理发布清单');
    const call = await callAt(0);
    expect(call.systemPrompt).toBe(TITLE_SYSTEM_PROMPT);
    expect(call.userText).toBe(buildInitialTitleUserText('  帮忙梳理发布清单\n细节'));
    expect(call.candidates).toEqual([model('m1')]);
    expect(call.timeoutMs).toBe(titleSummaryTimeoutMs(0));
    call.resolve('「发布清单梳理」');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('发布清单梳理');
    expect(emitted).toContain(thread.id);
  });

  it('主话题也参与：写根群 threadTitle，不改群名 title', async () => {
    const group = newGroup();
    send(group.id, '讨论季度路线图');
    expect(chats.get(group.id)?.threadTitle).toBe('讨论季度路线图');
    (await callAt(0)).resolve('季度路线图');
    await titler.settled();
    expect(chats.get(group.id)).toMatchObject({ title: '发布小组', threadTitle: '季度路线图' });
  });

  it('开关关：子话题仍取首句、主话题不设标题，不调用模型，轮结束也不滚动', async () => {
    enabled = false;
    const group = newGroup();
    const thread = chats.createThread(group.id)!;
    send(thread.id, '子话题首句\n后文');
    send(group.id, '主话题消息');
    bot(thread.id, '好的');
    bot(group.id, '收到');
    titler.notify(thread.id);
    titler.notify(group.id);
    await flush();
    expect(calls).toEqual([]);
    expect(chats.get(thread.id)?.threadTitle).toBe('子话题首句');
    expect(chats.get(group.id)).not.toHaveProperty('threadTitle');
  });

  it('旧话题（无 autoTitle 标记）不命名也不滚动：子话题保持首句截断，主话题保持缺省', async () => {
    const group = newGroup();
    const thread = chats.createThread(group.id)!;
    legacy(group.id);
    legacy(thread.id);
    send(thread.id, '旧话题首句');
    send(group.id, '旧主话题');
    bot(thread.id, '回复');
    bot(group.id, '回复');
    titler.notify(thread.id);
    titler.notify(group.id);
    await flush();
    expect(calls).toEqual([]);
    expect(chats.get(thread.id)?.threadTitle).toBe('旧话题首句');
    expect(chats.get(group.id)).not.toHaveProperty('threadTitle');
  });

  it('轮结束判定：还有成员在工作时不滚动；全部结束后只滚动一次，没有新一轮不再调用', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    (await callAt(0)).resolve('登录超时排查');
    await titler.settled();

    bot(thread.id, '我先看日志', BOT_A);
    idleState = { ...(idleState as Extract<BotChatStateResult, { ok: true }>), current: BOT_B };
    titler.notify(thread.id);
    await flush();
    expect(calls).toHaveLength(1);

    bot(thread.id, '数据库连接池耗尽，已调大', BOT_B);
    idleState = { ...idleState, current: null };
    titler.notify(thread.id);
    titler.notify(thread.id);
    titler.notify(thread.id);
    const rolling = await callAt(1);
    await vi.advanceTimersByTimeAsync(QUIET * 4);
    expect(calls).toHaveLength(2);
    expect(rolling.systemPrompt).toBe(ROLLING_TITLE_SYSTEM_PROMPT);
    expect(rolling.userText).toContain('Current title: 登录超时排查');
    expect(rolling.userText).toContain('排查登录超时');
    expect(rolling.userText).toContain('数据库连接池耗尽，已调大');
    rolling.resolve('登录超时：连接池耗尽');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('登录超时：连接池耗尽');

    // 没有新的一轮：再触发也不调用模型
    titler.notify(thread.id);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('本轮只有 [skip] / 系统消息时不滚动', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '你好');
    (await callAt(0)).resolve('问候');
    await titler.settled();
    bot(thread.id, '[skip]');
    chats.appendEntry(thread.id, { kind: 'system', id: 's1', at: 1, text: '回复失败' });
    titler.notify(thread.id);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('模型原样返回当前标题：不改标题、不发事件', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    (await callAt(0)).resolve('登录超时排查');
    await titler.settled();
    emitted = [];
    bot(thread.id, '继续看');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    (await callAt(1)).resolve('登录超时排查');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('登录超时排查');
    expect(emitted).toEqual([]);
  });

  it('手动改名锁定：进行中的结果返回后丢弃，之后不再自动命名', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    const call = await callAt(0);
    chats.update(thread.id, (draft) => {
      delete draft.autoTitle;
      return { ...draft, threadTitle: '我的标题' };
    });
    call.resolve('登录超时排查');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('我的标题');
    bot(thread.id, '回复');
    titler.notify(thread.id);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('候选依次回退：前一个失败换下一个（超时按下标递增）；全部失败或被拒保留当前标题且不抛错', async () => {
    candidates = [model('m1'), model('m2')];
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    (await callAt(0)).reject(new Error('m1: timed out'));
    const second = await callAt(1);
    expect(second.candidates).toEqual([model('m2')]);
    expect(second.timeoutMs).toBe(titleSummaryTimeoutMs(1));
    second.resolve('登录超时排查');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('登录超时排查');

    bot(thread.id, '已定位');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    (await callAt(2)).reject(new Error('boom'));
    // 叙述而不是标题：titleRejectReason 拒绝
    (await callAt(3)).resolve('我先查看代码。然后确认修复。最后验证');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('登录超时排查');
    // 失败的这一轮已处理过：没有新一轮不重试
    titler.notify(thread.id);
    await flush();
    expect(calls).toHaveLength(4);
  });

  it('没有可用候选：不调用模型，保留占位标题', async () => {
    candidates = [];
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    await titler.settled();
    expect(calls).toEqual([]);
    expect(chats.get(thread.id)?.threadTitle).toBe('排查登录超时');
  });

  it('话题被删 / 群已归档：不写回结果；归档群不再发起总结', async () => {
    const group = newGroup();
    const thread = chats.createThread(group.id)!;
    send(thread.id, '排查登录超时');
    const call = await callAt(0);
    chats.remove(thread.id);
    call.resolve('登录超时排查');
    await titler.settled();
    expect(chats.get(thread.id)).toBeUndefined();

    const other = chats.createThread(group.id)!;
    send(other.id, '另一个话题');
    const pending = await callAt(1);
    chats.update(group.id, (draft) => ({ ...draft, archivedAt: 9 }));
    pending.resolve('别的标题');
    await titler.settled();
    expect(chats.get(other.id)?.threadTitle).toBe('另一个话题');
    bot(other.id, '回复');
    titler.notify(other.id);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('同一话题不并发：initial 未返回时轮结束只记一笔，返回后再滚动一次', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    const initial = await callAt(0);
    bot(thread.id, '连接池耗尽');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(calls).toHaveLength(1);
    initial.resolve('登录超时排查');
    await titler.settled();
    await vi.advanceTimersByTimeAsync(QUIET);
    const rolling = await callAt(1);
    expect(rolling.systemPrompt).toBe(ROLLING_TITLE_SYSTEM_PROMPT);
    rolling.resolve('连接池耗尽排查');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('连接池耗尽排查');
  });

  it('静默窗口内新一轮开始：不滚动，直到新的结束信号', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    (await callAt(0)).resolve('登录超时排查');
    await titler.settled();
    bot(thread.id, '第一轮回复');
    titler.notify(thread.id);
    queued.add(thread.id);
    await flush();
    expect(calls).toHaveLength(1);
    queued.clear();
    bot(thread.id, '第二轮回复');
    titler.notify(thread.id);
    (await callAt(1)).resolve('两轮排查结果');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('两轮排查结果');
  });

  it('开关在请求进行中关闭：结果不写回', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    const call = await callAt(0);
    enabled = false;
    call.resolve('登录超时排查');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('排查登录超时');
    expect(chats.get(thread.id)?.autoTitle).toEqual({ seq: 0 });
  });

  it('候选解析尚未完成时又有成员开工：不得在新一轮中途发起 rolling', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    (await callAt(0)).resolve('登录超时排查');
    await titler.settled();
    titler.dispose();
    let resolveCandidates!: (value: SpawnModelConfig[]) => void;
    titler = new ThreadTitler({
      chats,
      enabled: () => enabled,
      work,
      candidates: () =>
        new Promise((resolve) => {
          resolveCandidates = resolve;
        }),
      complete: async (input) => {
        calls.push({ ...input, resolve: () => {}, reject: () => {} });
        return '迟到的旧轮总结';
      },
      emit: (chatId) => emitted.push(chatId),
      quietMs: QUIET,
    });
    bot(thread.id, '第一轮回复');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    queued.add(thread.id);
    human(thread.id, '新一轮任务');
    resolveCandidates(candidates);
    await titler.settled();
    expect(calls).toHaveLength(1);
    expect(chats.get(thread.id)?.threadTitle).toBe('登录超时排查');
  });

  it('候选解析期间被放弃的 rolling 不丢：autoTitle.seq 不推进，新一轮结束后两轮一起滚动', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    (await callAt(0)).resolve('登录超时排查');
    await titler.settled();
    const covered = chats.get(thread.id)?.autoTitle;
    titler.dispose();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    titler = new ThreadTitler({
      chats,
      enabled: () => enabled,
      work,
      candidates: async () => {
        await gate;
        return candidates;
      },
      complete: (input) =>
        new Promise((resolve, reject) => calls.push({ ...input, resolve, reject })),
      emit: (chatId) => emitted.push(chatId),
      quietMs: QUIET,
    });
    human(thread.id, '补充：先看连接池');
    bot(thread.id, '第一轮回复');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    queued.add(thread.id);
    human(thread.id, '新一轮任务');
    release();
    await titler.settled();
    expect(calls).toHaveLength(1);
    expect(chats.get(thread.id)?.autoTitle).toEqual(covered);

    queued.clear();
    bot(thread.id, '第二轮回复');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    const rolling = await callAt(1);
    expect(rolling.systemPrompt).toBe(ROLLING_TITLE_SYSTEM_PROMPT);
    expect(rolling.userText).toContain('补充：先看连接池');
    expect(rolling.userText).toContain('新一轮任务');
    expect(rolling.userText).toContain('第二轮回复');
    rolling.resolve('连接池排查');
    await titler.settled();
    expect(chats.get(thread.id)).toMatchObject({
      threadTitle: '连接池排查',
      autoTitle: { seq: chats.lastSeq(thread.id) },
    });
  });

  it('候选回退前新一轮已开始：不再尝试下一个候选，autoTitle.seq 不推进，新一轮结束后重新判定', async () => {
    candidates = [model('m1'), model('m2')];
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    (await callAt(0)).resolve('登录超时排查');
    await titler.settled();
    const covered = chats.get(thread.id)?.autoTitle;
    human(thread.id, '补充：先看连接池');
    bot(thread.id, '第一轮回复');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    const first = await callAt(1);
    idleState = { ...(idleState as Extract<BotChatStateResult, { ok: true }>), current: BOT_B };
    human(thread.id, '新一轮任务');
    first.reject(new Error('m1: timed out'));
    await titler.settled();
    expect(calls).toHaveLength(2);
    expect(chats.get(thread.id)?.autoTitle).toEqual(covered);

    idleState = { ...idleState, current: null };
    bot(thread.id, '第二轮回复', BOT_B);
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    const rolling = await callAt(2);
    expect(rolling.candidates).toEqual([model('m1')]);
    expect(rolling.userText).toContain('补充：先看连接池');
    expect(rolling.userText).toContain('新一轮任务');
    rolling.resolve('连接池排查');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('连接池排查');
  });

  it('titleRejectReason 拒绝后换候选前新一轮已开始：同样放弃，不写回不推进', async () => {
    candidates = [model('m1'), model('m2')];
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    (await callAt(0)).resolve('登录超时排查');
    await titler.settled();
    const covered = chats.get(thread.id)?.autoTitle;
    bot(thread.id, '第一轮回复');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    const first = await callAt(1);
    busy.add('c-a');
    chats.update(thread.id, (draft) => {
      draft.sessions[BOT_A] = { conversationId: 'c-a', cursor: 0 };
      return draft;
    });
    first.resolve('我先查看代码。然后确认修复。最后验证');
    await titler.settled();
    expect(calls).toHaveLength(2);
    expect(chats.get(thread.id)).toMatchObject({ threadTitle: '登录超时排查', autoTitle: covered });
  });

  it('initial 不受工作状态限制：首条消息后成员已开工，仍照常命名并按候选回退', async () => {
    candidates = [model('m1'), model('m2')];
    const thread = chats.createThread(newGroup().id)!;
    queued.add(thread.id);
    idleState = { ...(idleState as Extract<BotChatStateResult, { ok: true }>), current: BOT_A };
    send(thread.id, '排查登录超时');
    (await callAt(0)).reject(new Error('m1: timed out'));
    (await callAt(1)).resolve('登录超时排查');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('登录超时排查');
  });

  it('模型已在调用中时新一轮开始：旧轮结果照常写回且只推进到旧轮末尾，新一轮结束后只总结新一轮', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    (await callAt(0)).resolve('登录超时排查');
    await titler.settled();
    human(thread.id, '补充：先看连接池');
    const roundEnd = bot(thread.id, '第一轮回复');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    const rolling = await callAt(1);
    queued.add(thread.id);
    human(thread.id, '新一轮任务');
    rolling.resolve('连接池排查');
    await titler.settled();
    expect(chats.get(thread.id)).toMatchObject({
      threadTitle: '连接池排查',
      autoTitle: { seq: roundEnd.seq },
    });

    queued.clear();
    bot(thread.id, '第二轮回复');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    const next = await callAt(2);
    expect(next.userText).toContain('Current title: 连接池排查');
    expect(next.userText).toContain('新一轮任务');
    expect(next.userText).not.toContain('补充：先看连接池');
    next.resolve('第二轮排查结果');
    await titler.settled();
    expect(chats.get(thread.id)?.autoTitle?.seq).toBe(chats.lastSeq(thread.id));
  });

  it.each([true, false])('结束定时器先触发=%s：补齐下一轮且不重复', async (timerFirst) => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    (await callAt(0)).resolve('登录超时排查');
    await titler.settled();
    titler.dispose();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    titler = new ThreadTitler({
      chats,
      enabled: () => enabled,
      work,
      candidates: async () => {
        await gate;
        return candidates;
      },
      complete: (input) =>
        new Promise((resolve, reject) => calls.push({ ...input, resolve, reject })),
      emit: (chatId) => emitted.push(chatId),
      quietMs: QUIET,
    });
    const oldEnd = bot(thread.id, '第一轮回复');
    titler.notify(thread.id);
    await vi.advanceTimersByTimeAsync(QUIET);
    human(thread.id, '第二轮任务');
    const newEnd = bot(thread.id, '第二轮回复');
    titler.notify(thread.id);
    if (timerFirst) await vi.advanceTimersByTimeAsync(QUIET);
    release();
    (await callAt(1)).resolve('第一轮总结');
    await titler.settled();
    expect(chats.get(thread.id)?.autoTitle?.seq).toBe(oldEnd.seq);
    await vi.advanceTimersByTimeAsync(QUIET);
    const next = await callAt(2);
    expect(next.userText).toContain('第二轮任务');
    expect(next.userText).toContain('第二轮回复');
    next.resolve('两轮排查结果');
    await titler.settled();
    expect(chats.get(thread.id)?.autoTitle?.seq).toBe(newEnd.seq);
    titler.notify(thread.id);
    await flush();
    expect(calls).toHaveLength(3);
  });

  it('dispose 清除静默定时器并中止在飞模型请求', async () => {
    titler.dispose();
    const abort = vi.fn();
    titler = new ThreadTitler({
      chats,
      enabled: () => enabled,
      work,
      candidates: async () => candidates,
      complete: (input) =>
        new Promise((resolve, reject) => calls.push({ ...input, resolve, reject })),
      abort,
      emit: (chatId) => emitted.push(chatId),
      quietMs: QUIET,
    });
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    const call = await callAt(0);
    titler.notify(thread.id);
    titler.dispose();
    expect(abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    call.resolve('登录超时排查');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('排查登录超时');
  });

  it('dispose 后到达的结果丢弃', async () => {
    const thread = chats.createThread(newGroup().id)!;
    send(thread.id, '排查登录超时');
    const call = await callAt(0);
    titler.dispose();
    call.resolve('登录超时排查');
    await titler.settled();
    expect(chats.get(thread.id)?.threadTitle).toBe('排查登录超时');
  });
});

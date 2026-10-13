import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscussNextDecision, DiscussNextInput } from '../../../shared/bots/discussRoute';
import type { SmartRouteDecision, SmartRouteInput } from '../../../shared/bots/smartRoute';
import type { BotTurnFinished } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { GroupChatService } from './groupChat';
import { threadWorkPending } from './threadTitler';

/** 成员自选（turns）路由：只在讨论模式开关打开时生效；关闭时按 smart（即 main 行为） */
let root: string;
let bots: BotStore;
let chats: BotChatStore;
let group: GroupChatService;
let a: string;
let b: string;
let c: string;
let id: string;
let finish: (event: BotTurnFinished) => void;
let discussOn = true;
let delegated: string[] = [];
let withResponder = false;
const deliver = vi.fn();
const stopTurn = vi.fn(async () => {});
const emit = vi.fn();
const settledBatch = vi.fn();
const select =
  vi.fn<(input: SmartRouteInput, signal: AbortSignal) => Promise<SmartRouteDecision>>();
const next =
  vi.fn<(input: DiscussNextInput, signal: AbortSignal) => Promise<DiscussNextDecision>>();
const host = {
  onDeliverySent: () => () => {},
  deliver,
  stopTurn,
  onTurnFinished: (listener: typeof finish) => {
    finish = listener;
    return () => {};
  },
};
const entries = () => chats.readEntries(id);
const to = () => deliver.mock.calls.map((call) => call[1]);
const sent = (index: number) => String(deliver.mock.calls.at(index)?.[2]);
const systems = () =>
  entries()
    .filter((e) => e.kind === 'system')
    .map((e) => e.text);
const botEntries = () => entries().filter((e) => e.kind === 'bot');
const finishTurn = async (botId: string, text: string, ok = true) => {
  finish({
    chatId: id,
    botId,
    conversationId: botId,
    turnId: String(entries().length),
    turnKey: `k-${entries().length}`,
    text,
    ok,
    ...(ok ? {} : { error: 'broken' }),
  });
  await group.settled(id);
};
const make = () => {
  group?.dispose();
  group = new GroupChatService({
    bots,
    chats,
    host,
    emit,
    onBatchSettled: settledBatch,
    delegatedTargets: () => delegated,
    discussEnabled: () => discussOn,
    ...(withResponder ? { responder: { timeoutMs: () => 1000, select, next } } : {}),
  });
};
const setMode = (mode: 'boss' | 'smart' | 'turns', extra: Record<string, unknown> = {}) =>
  chats.update(id, (chat) => ({ ...chat, routing: { ...chat.routing, mode, ...extra } }));

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'group-turns-'));
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'chats'));
  const made = ['Alice', 'Bob', 'Carol'].map((name) => bots.create({ name }, []));
  const ids = made.map((result) => {
    if (!result.ok) throw new Error('fixture');
    return result.bot.id;
  });
  [a, b, c] = ids;
  id = chats.create({
    kind: 'group',
    title: 'Team',
    members: [a, b, c],
    bossBotId: a,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!.id;
  setMode('turns');
  deliver.mockImplementation(async (_chatId: string, botId: string) => {
    if (!chats.get(id)!.sessions[botId])
      chats.update(id, (draft) => {
        draft.sessions[botId] = { conversationId: botId, cursor: chats.lastSeq(id) };
        return draft;
      });
    return { ok: true, conversationId: botId };
  });
  discussOn = true;
  delegated = [];
  withResponder = false;
  select.mockReset();
  next.mockReset();
  make();
});
afterEach(() => {
  group.dispose();
  rmSync(root, { recursive: true, force: true });
});

/** a、b 各说一句，c [skip]；第 2 轮 b、c 没有新内容自动跳过，a [skip] → 交群主 a 收尾（已投递） */
const toWrapUp = async () => {
  await group.send(id, '讨论一下');
  await finishTurn(a, 'A1');
  await finishTurn(b, 'B1');
  await finishTurn(c, '[skip]');
  await finishTurn(a, '[skip]');
  expect(to()).toEqual([a, b, c, a, a]);
};

describe('成员自选（开关打开）', () => {
  it('依次发言：群主第一，附第几轮的说明；后面的人能看到前面刚说的话；状态带轮次与上限', async () => {
    await group.send(id, '大家怎么看');
    expect(to()).toEqual([a]);
    expect(sent(0)).toContain('成员自选发言（第 1 轮）');
    expect(sent(0)).toContain('@ 别人只是提醒');
    expect(group.state(id)).toMatchObject({
      current: a,
      queue: [b, c],
      hops: 0,
      turns: { round: 1 },
      discuss: { turns: 1, max: 50 },
    });
    expect(group.state(id)).not.toHaveProperty('wrapUp');
    await finishTurn(a, 'A1');
    expect(to()).toEqual([a, b]);
    expect(sent(1)).toContain('A1');
    await finishTurn(b, '[skip]');
    await finishTurn(c, 'C1');
    // 第 2 轮轮换为 b、c、a；c 刚说完没有新内容，自动跳过不调模型
    expect(to()).toEqual([a, b, c, b]);
    expect(sent(3)).toContain('第 2 轮');
    expect(sent(3)).toContain('C1');
    expect(group.state(id)).toMatchObject({ current: b, queue: [c, a], turns: { round: 2 } });
    await finishTurn(b, '[skip]');
    expect(to()).toEqual([a, b, c, b, a]);
    expect(botEntries().map((e) => e.kind === 'bot' && e.text)).toEqual(['A1', 'C1']);
    expect(botEntries().every((e) => e.kind === 'bot' && e.routedBy === undefined)).toBe(true);
  });

  it('第 1 轮全员 [skip]：只提示「成员都选择不回复」，不收尾、不交群主兜底', async () => {
    await group.send(id, 'hi');
    await finishTurn(a, '[skip]');
    await finishTurn(b, '[skip]');
    await finishTurn(c, '[skip]');
    expect(to()).toEqual([a, b, c]);
    expect(systems()).toEqual(['成员都选择不回复']);
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    expect(group.state(id)).not.toHaveProperty('turns');
    expect(settledBatch).not.toHaveBeenCalled();
  });

  it('一整轮全员 [skip] 且有效发言不到 2 条：静默结束', async () => {
    await group.send(id, 'hi');
    await finishTurn(a, 'A1');
    await finishTurn(b, '[skip]');
    await finishTurn(c, '[skip]');
    // 第 2 轮 b、c、a 都没有新内容：自动跳过，本轮无人发言
    expect(to()).toEqual([a, b, c]);
    expect(systems()).toEqual([]);
    expect(group.state(id)).toMatchObject({ current: null });
    expect(settledBatch).toHaveBeenCalledTimes(1);
    expect(settledBatch.mock.calls[0][0]).toMatchObject({ botIds: [a], lastText: 'A1' });
  });

  it('一整轮全员 [skip] 且有效发言 ≥2：交群主收尾，标 wrap-up；批次在收尾后只结算一次', async () => {
    await toWrapUp();
    expect(systems()).toEqual(['没有成员再接话，交给群主「Alice」收尾。']);
    const wrap = sent(-1);
    expect(wrap).toContain('请你作为群主收尾');
    expect(wrap).toContain('成员都没有新的补充了');
    expect(wrap).not.toContain('成员自选发言');
    expect(group.state(id)).toMatchObject({ current: a, wrapUp: true });
    expect(group.state(id)).not.toHaveProperty('turns');
    expect(settledBatch).not.toHaveBeenCalled();
    await finishTurn(a, '结论 @Bob');
    expect(botEntries().at(-1)).toMatchObject({ botId: a, routedBy: 'wrap-up' });
    // 收尾里的 @ 只是提醒
    expect(to()).toHaveLength(5);
    expect(group.state(id)).toMatchObject({ current: null });
    expect(settledBatch).toHaveBeenCalledTimes(1);
  });

  it('到达安全上限（含 [skip] 与失败）：按 cap 交群主收尾', async () => {
    setMode('turns', { discussMaxTurns: 5 });
    await group.send(id, 'hi');
    await finishTurn(a, 'A1');
    await finishTurn(b, 'B1');
    await finishTurn(c, 'C1');
    await finishTurn(b, 'B2');
    await finishTurn(c, '', false);
    expect(to()).toEqual([a, b, c, b, c, a]);
    expect(systems()).toEqual([
      'Carol 回复失败：broken',
      '本次讨论已达安全上限（5 次成员发言），交给群主「Alice」收尾。',
    ]);
    expect(sent(-1)).toContain('讨论已达安全上限（5 次成员发言）');
    expect(group.state(id)).toMatchObject({ current: a, wrapUp: true });
  });

  it('成员失败或投递失败：照常提示，本轮算跳过，后面的轮次不再排他', async () => {
    await group.send(id, 'hi');
    await finishTurn(a, 'A1');
    deliver.mockResolvedValueOnce({ ok: false, error: 'offline' });
    await finishTurn(b, '', false);
    // c 投递失败后直接轮到第 2 轮：b、c 已退出，a 还没看过新内容 → 没有新内容（失败不算发言）
    expect(to()).toEqual([a, b, c]);
    expect(systems()).toEqual(['Bob 回复失败：broken', 'Carol 暂时无法回复']);
    expect(group.state(id)).toMatchObject({ current: null });
  });

  it('有人在发言时人类发消息（含只 @ 当前发言者）：不插话，等他说完按合并后的消息重开，不收尾', async () => {
    await group.send(id, 'hi');
    await group.send(id, '@Alice 补充一');
    await group.send(id, '补充二');
    expect(to()).toEqual([a]);
    expect(group.state(id)).toMatchObject({ pendingHuman: true });
    await finishTurn(a, 'A1');
    // 合并后的消息只点名了 Alice：只有她参与
    expect(to()).toEqual([a, a]);
    expect(sent(1)).toContain('补充一');
    expect(sent(1)).toContain('补充二');
    expect(sent(1)).toContain('第 1 轮');
    expect(sent(1)).toContain('人类点名了你');
    expect(group.state(id)).toMatchObject({ current: a, queue: [], turns: { round: 1 } });
    expect(systems()).toEqual([]);
  });

  it('收尾期间来了新消息：等收尾说完再按新消息重开', async () => {
    await toWrapUp();
    await group.send(id, '@Bob 新问题');
    expect(to()).toHaveLength(5);
    await finishTurn(a, '结论');
    expect(botEntries().at(-1)).toMatchObject({ botId: a, routedBy: 'wrap-up' });
    expect(to()).toEqual([a, b, c, a, a, b]);
    expect(group.state(id)).toMatchObject({ current: b, turns: { round: 1 } });
  });

  it('有人委派：本轮已排队的人说完，不开下一轮，也不收尾', async () => {
    await group.send(id, 'hi');
    delegated = [c];
    await finishTurn(a, 'A1，已委派给 @Carol');
    delegated = [];
    expect(to()).toEqual([a, b]);
    await finishTurn(b, 'B1');
    await finishTurn(c, 'C1');
    expect(to()).toEqual([a, b, c]);
    expect(systems()).toEqual([]);
    expect(group.state(id)).toMatchObject({ current: null });
    expect(group.state(id)).not.toHaveProperty('wrapUp');
  });

  it('手动停止：清空状态，不收尾、不结算批次', async () => {
    await group.send(id, 'hi');
    await finishTurn(a, 'A1');
    expect(await group.stop(id)).toEqual({ ok: true });
    expect(stopTurn).toHaveBeenCalledWith(id, b);
    await finishTurn(b, 'B1');
    expect(to()).toEqual([a, b]);
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    expect(group.state(id)).not.toHaveProperty('turns');
    expect(systems()).toEqual([]);
    expect(settledBatch).not.toHaveBeenCalled();
  });

  it('例行任务 / 委派回传只叫负责的成员，回复里的 @ 不接力，也不开多轮', async () => {
    const result = group.runAs(id, b, '请整理日报', '日报');
    expect(await result).toMatchObject({ ok: true });
    expect(to()).toEqual([b]);
    expect(sent(0)).not.toContain('成员自选发言');
    await finishTurn(b, '整理好了 @Carol 看看');
    expect(to()).toEqual([b]);
    expect(group.state(id)).toMatchObject({ current: null });
    expect(systems()).toEqual(['例行任务：日报']);
  });

  it('多轮进行中到达的例行任务：等整段多轮结束才执行', async () => {
    await group.send(id, 'hi');
    const result = group.runAs(id, c, '例行', '巡检');
    await group.settled(id);
    expect(to()).toEqual([a]);
    await finishTurn(a, '[skip]');
    await finishTurn(b, '[skip]');
    await finishTurn(c, '[skip]');
    expect(await result).toMatchObject({ ok: true });
    expect(to()).toEqual([a, b, c, c]);
    expect(systems()).toEqual(['成员都选择不回复', '例行任务：巡检']);
  });

  it('静音成员不 @ 时不参与，被点名才参与；中途被移出或归档的成员静默跳过', async () => {
    setMode('turns', { muted: [c] });
    await group.send(id, 'hi');
    expect(group.state(id)).toMatchObject({ current: a, queue: [b] });
    await finishTurn(a, '[skip]');
    await finishTurn(b, '[skip]');
    await group.send(id, '@Carol @Bob 看看');
    expect(to()).toEqual([a, b, b]);
    expect(group.state(id)).toMatchObject({ queue: [c] });
    bots.setArchived(c, true);
    await finishTurn(b, 'B1');
    expect(to()).toEqual([a, b, b]);
    expect(systems()).not.toContain('请先指定群主');
  });

  it('被 @ 的成员都不能发言：提示，不交群主', async () => {
    bots.setArchived(b, true);
    await group.send(id, '@Bob 在吗');
    expect(to()).toEqual([]);
    expect(systems()).toEqual(['被 @ 的成员都不能发言']);
  });

  it('不调用智能选人与讨论判断', async () => {
    withResponder = true;
    make();
    await group.send(id, 'hi');
    await finishTurn(a, 'A1');
    await finishTurn(b, 'B1');
    await finishTurn(c, 'C1');
    expect(select).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('重启时有一轮正在进行：只出一条「回复被中断」，状态清空，不自动续上', async () => {
    await group.send(id, 'hi');
    await finishTurn(a, 'A1');
    // 模拟进程中断：不走会清空 router.json 的 dispose
    group = new GroupChatService({ bots, chats, host, emit, discussEnabled: () => discussOn });
    expect(systems()).toEqual(['回复被中断']);
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    expect(group.state(id)).not.toHaveProperty('turns');
    expect(to()).toEqual([a, b]);
  });

  it('运行中切换路由模式：已经开始的成员自选照常走完；新消息按新模式', async () => {
    await group.send(id, 'hi');
    setMode('boss');
    await finishTurn(a, 'A1');
    expect(to()).toEqual([a, b]);
    expect(sent(1)).toContain('成员自选发言');
    await finishTurn(b, '[skip]');
    await finishTurn(c, '[skip]');
    await finishTurn(a, '[skip]');
    expect(group.state(id)).toMatchObject({ current: null });
    // boss 模式：新消息群主回复，不再附成员自选说明
    await group.send(id, 'next');
    expect(to().at(-1)).toBe(a);
    expect(sent(-1)).not.toContain('成员自选发言');
    expect(group.state(id)).not.toHaveProperty('turns');
  });

  it('运行中切到成员自选：新消息等当前发言者说完，丢掉原接力，按成员自选重开', async () => {
    setMode('boss');
    await group.send(id, '@Alice @Bob hi');
    expect(group.state(id)).toMatchObject({ current: a, queue: [b] });
    setMode('turns');
    await group.send(id, 'next');
    expect(to()).toEqual([a]);
    await finishTurn(a, 'A1');
    expect(to()).toEqual([a, a]);
    expect(sent(1)).toContain('成员自选发言（第 1 轮）');
    expect(group.state(id)).toMatchObject({ current: a, queue: [b, c] });
  });
});

describe('审查 #59 边界回归', () => {
  it('收尾准备期间关闭开关，取消未投递的收尾且仅提示一次', async () => {
    let ready!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const waiting = new Promise<string>((resolve) => {
      resume = () => resolve('');
    });
    group.dispose();
    group = new GroupChatService({
      bots,
      chats,
      host,
      emit,
      discussEnabled: () => discussOn,
      refsAppendix: async () => {
        const state = group.state(id);
        if (!state.ok || !state.wrapUp) return '';
        ready();
        return waiting;
      },
    });
    await group.send(id, 'hi');
    await finishTurn(a, 'A1');
    await finishTurn(b, 'B1');
    await finishTurn(c, '[skip]');
    const completing = finishTurn(a, '[skip]');
    await entered;
    discussOn = false;
    const sync = group.syncDiscussMode();
    resume();
    await completing;
    await sync;
    expect(to()).toEqual([a, b, c, a]);
    expect(group.state(id)).toMatchObject({ current: null });
    expect(systems().filter((text) => text.includes('讨论模式已关闭'))).toHaveLength(1);
  });

  it('单人重试失败投递的回复不按 @ 接力', async () => {
    deliver.mockResolvedValueOnce({ ok: false, error: 'offline' });
    await group.send(id, '@Bob hi');
    const failure = entries().find((e) => e.kind === 'system' && e.failure);
    if (!failure) throw new Error('missing failure');
    expect(await group.retry(id, failure.id)).toEqual({ ok: true });
    await finishTurn(b, '重试成功 @Carol');
    expect(to()).toEqual([b, b]);
    expect(group.state(id)).toMatchObject({ current: null });
  });

  it('threadWorkPending 持续覆盖轮次与收尾，完成后清空', async () => {
    const work = {
      groupState: (chatId: string) => group.state(chatId),
      conversationBusy: () => false,
      queued: () => false,
      delegations: () => [],
    };
    await group.send(id, 'hi');
    expect(threadWorkPending(chats.get(id)!, work)).toBe(true);
    await finishTurn(a, 'A1');
    await finishTurn(b, 'B1');
    await finishTurn(c, '[skip]');
    expect(threadWorkPending(chats.get(id)!, work)).toBe(true);
    await finishTurn(a, '[skip]');
    expect(threadWorkPending(chats.get(id)!, work)).toBe(true);
    expect(settledBatch).not.toHaveBeenCalled();
    await finishTurn(a, '结论');
    expect(threadWorkPending(chats.get(id)!, work)).toBe(false);
    expect(settledBatch).toHaveBeenCalledTimes(1);
  });

  it('投递附录等待期间被静音的非点名成员，不应仍收到成员自选投递', async () => {
    let ready!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const waiting = new Promise<string>((resolve) => {
      resume = () => resolve('');
    });
    group.dispose();
    group = new GroupChatService({
      bots,
      chats,
      host,
      emit,
      discussEnabled: () => discussOn,
      refsAppendix: async (_chat, botId) => {
        if (botId !== b) return '';
        ready();
        return waiting;
      },
    });
    await group.send(id, 'hi');
    const completing = finishTurn(a, 'A1');
    await entered;
    setMode('turns', { muted: [b] });
    resume();
    await completing;
    expect(to()).toEqual([a, c]);
    expect(systems()).not.toContain('请先指定群主');
  });

  it('成功但空白的回复不算有效发言，不写正文、不打开第二轮或收尾', async () => {
    await group.send(id, 'hi');
    await finishTurn(a, '');
    await finishTurn(b, '   ');
    await finishTurn(c, '');
    expect(to()).toEqual([a, b, c]);
    expect(botEntries()).toEqual([]);
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    expect(group.state(id)).not.toHaveProperty('wrapUp');
    expect(settledBatch).not.toHaveBeenCalled();
  });

  it('多轮之后关闭开关，之前的发言不占普通接力额度', async () => {
    setMode('turns', { maxTurnsPerBot: 1 });
    await group.send(id, 'hi');
    await finishTurn(a, 'A1');
    await finishTurn(b, 'B1');
    await finishTurn(c, 'C1');
    discussOn = false;
    await group.syncDiscussMode();
    await finishTurn(b, 'B2 @Alice');
    expect(to()).toEqual([a, b, c, b, a]);
    expect(systems()).toEqual(['讨论模式已关闭，本轮讨论结束']);
  });

  it('中途静音或移出群的排队成员不再投递，不提示缺少群主', async () => {
    await group.send(id, 'hi');
    setMode('turns', { muted: [b] });
    chats.update(id, (chat) => ({ ...chat, members: [a, b] }));
    await finishTurn(a, 'A1');
    expect(to()).toEqual([a]);
    expect(systems()).toEqual([]);
    expect(group.state(id)).toMatchObject({ current: null });
  });

  it('只点名非群主子集，仍按 #33 由群主收尾', async () => {
    await group.send(id, '@Bob @Carol hi');
    await finishTurn(b, 'B1');
    await finishTurn(c, 'C1');
    await finishTurn(b, '[skip]');
    expect(to()).toEqual([b, c, b, a]);
    expect(group.state(id)).toMatchObject({ current: a, wrapUp: true });
    expect(settledBatch).not.toHaveBeenCalled();
    await finishTurn(a, '收尾');
    expect(settledBatch).toHaveBeenCalledTimes(1);
  });
});

describe('成员自选（开关关闭）', () => {
  beforeEach(() => {
    discussOn = false;
    make();
  });

  it('存成 turns 的群按 smart 路由（智能选人），存储的 mode 不改写，不附成员自选说明', async () => {
    withResponder = true;
    make();
    select.mockResolvedValueOnce({ ids: [b] });
    await group.send(id, 'hi');
    await vi.waitFor(() => expect(to()).toEqual([b]));
    expect(select).toHaveBeenCalledTimes(1);
    expect(sent(0)).not.toContain('成员自选发言');
    expect(group.state(id)).not.toHaveProperty('turns');
    expect(group.state(id)).not.toHaveProperty('discuss');
    await finishTurn(b, 'B1 @Carol');
    // @ 照常接力（main 规则）
    expect(to()).toEqual([b, c]);
    expect(chats.get(id)!.routing.mode).toBe('turns');
  });

  it('没有判断后端时群主回复；只 @ 已归档成员时也交群主（不出成员自选的提示）', async () => {
    await group.send(id, 'hi');
    expect(to()).toEqual([a]);
    await finishTurn(a, 'A1');
    bots.setArchived(b, true);
    await group.send(id, '@Bob 在吗');
    expect(to()).toEqual([a, a]);
    expect(systems()).toEqual([]);
  });

  it('有人在发言时人类发消息：按 main 规则（只 @ 当前发言者时 steer）', async () => {
    await group.send(id, 'hi');
    await group.send(id, '@Alice 补充');
    expect(to()).toEqual([a, a]);
    expect(group.state(id)).toMatchObject({ pendingHuman: false });
  });
});

describe('成员自选：开关切换', () => {
  it('运行中关闭：当前发言者说完就停，回复按 main 规则（@ 接力），只提示一次', async () => {
    await group.send(id, 'hi');
    discussOn = false;
    await group.syncDiscussMode();
    expect(systems()).toEqual(['讨论模式已关闭，本轮讨论结束']);
    expect(group.state(id)).toMatchObject({ current: a, queue: [] });
    expect(group.state(id)).not.toHaveProperty('turns');
    expect(group.state(id)).not.toHaveProperty('discuss');
    await finishTurn(a, 'A1 @Carol');
    expect(to()).toEqual([a, c]);
    await finishTurn(c, 'C1');
    // main 规则：群主 @ 派出的成员回复后，追加一跳群主汇总
    expect(to()).toEqual([a, c, a]);
    expect(sent(-1)).toContain('你派出的成员都已回复');
    expect(sent(-1)).not.toContain('成员自选发言');
    expect(systems()).toEqual(['讨论模式已关闭，本轮讨论结束']);
  });

  it('运行中关闭但还没同步到这个群：当前发言者说完时按关闭处理，同样只提示一次', async () => {
    await group.send(id, 'hi');
    await finishTurn(a, 'A1');
    discussOn = false;
    await finishTurn(b, 'B1');
    expect(to()).toEqual([a, b]);
    expect(systems()).toEqual(['讨论模式已关闭，本轮讨论结束']);
    expect(group.state(id)).toMatchObject({ current: null });
  });

  it('群主已在收尾时关闭：让 TA 说完，不提示，回复按 main 规则', async () => {
    await toWrapUp();
    discussOn = false;
    await group.syncDiscussMode();
    expect(group.state(id)).not.toHaveProperty('wrapUp');
    await finishTurn(a, '结论 @Bob');
    expect(botEntries().at(-1)).toMatchObject({ botId: a, routedBy: 'wrap-up' });
    expect(to()).toEqual([a, b, c, a, a, b]);
    expect(systems()).toEqual(['没有成员再接话，交给群主「Alice」收尾。']);
  });

  it('打开：从下一条人类消息开始生效', async () => {
    discussOn = false;
    make();
    await group.send(id, 'hi');
    discussOn = true;
    await group.syncDiscussMode();
    await finishTurn(a, 'A1');
    expect(to()).toEqual([a]);
    expect(sent(0)).not.toContain('成员自选发言');
    await group.send(id, 'next');
    expect(to()).toEqual([a, a]);
    expect(sent(1)).toContain('成员自选发言（第 1 轮）');
  });
});

describe('#59 阻断修复补充', () => {
  /** 只在 gate 打开后拦住 target 的附录读取，用来模拟投递准备期间群况变化 */
  const gated = (target: string) => {
    let ready!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const waiting = new Promise<string>((resolve) => {
      resume = () => resolve('');
    });
    group.dispose();
    group = new GroupChatService({
      bots,
      chats,
      host,
      emit,
      onBatchSettled: settledBatch,
      discussEnabled: () => discussOn,
      refsAppendix: async (_chat, botId) => {
        if (botId !== target) return '';
        ready();
        return waiting;
      },
    });
    return { entered, resume };
  };

  it('空白回复不推进「有新内容」水位：后面的人不因此开第二轮', async () => {
    await group.send(id, 'hi');
    await finishTurn(a, 'A1');
    await finishTurn(b, '   ');
    await finishTurn(c, '');
    expect(to()).toEqual([a, b, c]);
    expect(botEntries().map((e) => e.kind === 'bot' && e.text)).toEqual(['A1']);
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    expect(systems()).toEqual([]);
    expect(settledBatch).toHaveBeenCalledTimes(1);
    expect(settledBatch.mock.calls[0][0]).toMatchObject({ botIds: [a], lastText: 'A1' });
  });

  it('附录等待期间被静音的点名成员照常投递', async () => {
    const gate = gated(b);
    const sending = group.send(id, '@Bob @Carol hi');
    await gate.entered;
    setMode('turns', { muted: [b] });
    gate.resume();
    await sending;
    expect(to()).toEqual([b]);
    await finishTurn(b, 'B1');
    expect(to()).toEqual([b, c]);
  });

  it('附录等待期间被归档的点名成员静默跳过：不投递、不算失败', async () => {
    const gate = gated(b);
    const sending = group.send(id, '@Bob @Carol hi');
    await gate.entered;
    bots.setArchived(b, true);
    gate.resume();
    await sending;
    expect(to()).toEqual([c]);
    await finishTurn(c, '[skip]');
    expect(to()).toEqual([c]);
    // 没投递出去的 Bob 不算失败：本条消息仍是「成员都选择不回复」
    expect(systems()).toEqual(['成员都选择不回复']);
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
  });

  it('附录等待期间被移出群的非点名成员静默跳过', async () => {
    const gate = gated(b);
    await group.send(id, 'hi');
    const completing = finishTurn(a, 'A1');
    await gate.entered;
    chats.update(id, (chat) => ({ ...chat, members: [a, c] }));
    gate.resume();
    await completing;
    expect(to()).toEqual([a, c]);
    expect(systems()).toEqual([]);
    expect(group.state(id)).toMatchObject({ current: c, queue: [] });
  });
});

describe('#60 空白与静默跳过复审', () => {
  it.each([' \n\t\r\n', '\u200b', '\u200c\u200d', '\ufeff'])(
    '仅不可见字符 %j 不构成有效发言',
    async (text) => {
      await group.send(id, 'hi');
      await finishTurn(a, text);
      await finishTurn(b, text);
      await finishTurn(c, text);
      expect(botEntries()).toEqual([]);
      expect(systems()).toEqual(['成员都选择不回复']);
      expect(to()).toEqual([a, b, c]);
      expect(group.state(id)).toMatchObject({ current: null });
    }
  );

  it('开关打开的普通接力仍写入空白正文', async () => {
    setMode('boss');
    await group.send(id, 'hi');
    await finishTurn(a, ' \n');
    expect(botEntries()).toMatchObject([{ botId: a, text: ' \n' }]);
  });

  it('成员自选进行中的并行点名仍按 main 写入空白正文', async () => {
    await group.send(id, 'hi');
    // 已开始的 turns 不随路由切换中断；新消息按普通路由可以并行投递。
    setMode('boss');
    await group.send(id, '@Bob 补充');
    expect(to()).toEqual([a, b]);
    finish({
      chatId: id,
      botId: b,
      conversationId: b,
      turnId: 'parallel',
      deliveryId: deliver.mock.calls[1][3].deliveryId,
      text: ' \n',
      ok: true,
    });
    await group.settled(id);
    expect(botEntries()).toMatchObject([{ botId: b, text: ' \n' }]);
    expect(group.state(id)).toMatchObject({ current: a });
  });

  it('附录阶段全员失去资格时有限结束，不投递、不记失败', async () => {
    group.dispose();
    group = new GroupChatService({
      bots,
      chats,
      host,
      emit,
      discussEnabled: () => discussOn,
      refsAppendix: async () => {
        for (const botId of [a, b, c]) bots.setArchived(botId, true);
        return '';
      },
    });
    await group.send(id, 'hi');
    expect(to()).toEqual([]);
    expect(group.state(id)).toMatchObject({ current: null, queue: [] });
    expect(systems()).toEqual(['成员都选择不回复']);
  });
});

describe('#59 阻断修复：开关关闭时空白回复与 main 一致', () => {
  beforeEach(() => {
    discussOn = false;
    make();
  });

  it('成功但空白的回复照 main 写进时间线', async () => {
    await group.send(id, 'hi');
    await finishTurn(a, '');
    expect(to()).toEqual([a]);
    expect(botEntries()).toMatchObject([{ botId: a, text: '' }]);
  });
});

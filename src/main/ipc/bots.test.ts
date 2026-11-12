import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostToPhone } from '@enso/pair';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairBotPort } from '../services/pairHost';
import { SourceAuthorityRegistry } from '../services/sourceAuthorityRegistry';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  root: '',
  registry: null as unknown,
  settings: {} as Record<string, unknown>,
  isMain: vi.fn(() => true),
  spawnSession: vi.fn((..._args: unknown[]) => ({ ok: true })),
  promptSession: vi.fn((..._args: unknown[]) => ({ ok: true })),
  steerSession: vi.fn((..._args: unknown[]) => ({ ok: true })),
  completeText: vi.fn(async (..._args: unknown[]) => 'OK'),
  workerReady: true,
  setSessionModel: vi.fn((..._args: unknown[]) => ({ ok: true })),
  setSessionReasoning: vi.fn((..._args: unknown[]) => ({ ok: true })),
  setSessionThinking: vi.fn((..._args: unknown[]) => ({ ok: true })),
  identities: new Map<string, { sessionId: string; generation: string }>(),
  pairPort: null as PairBotPort | null,
}));

vi.mock('../services/pairHost', () => ({
  setPairBotPort: (port: PairBotPort) => {
    mocks.pairPort = port;
  },
  broadcastPairFrame: vi.fn(),
  isPairSessionRunning: () => false,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  app: { getPath: () => mocks.root },
  shell: { openPath: async () => '' },
}));
vi.mock('../services/renderers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/renderers')>()),
  isMainRenderer: mocks.isMain,
  broadcastToRenderers: vi.fn(),
}));
vi.mock('../services/notifications', () => ({ notifyBotChat: vi.fn(async () => {}) }));
vi.mock('../services/oauthProviders', () => ({
  readStoredOauthCredentialKeys: async () => new Set<string>(),
}));
vi.mock('../services/instructionStore', () => ({ resolveGlobalInstruction: () => undefined }));
vi.mock('../services/sessionFileCleanup', () => ({ removeConversationSessionFiles: vi.fn() }));
vi.mock('../services/agentHost', () => ({
  agentTypeRegistrySnapshot: () => ({ revision: 0, candidates: [{ displayName: 'Reviewer' }] }),
  readSettingsState: () => mocks.settings,
  isAgentWorkerReady: () => mocks.workerReady,
  resolveModelSelection: () => ({
    ok: true,
    selection: {
      config: {
        api: 'openai-completions',
        baseUrl: 'https://x.test',
        apiKey: 'k',
        modelId: 'm',
        settingsProviderId: 'p',
      },
    },
  }),
  resolveVirtualClassifier: () => undefined,
  completeText: mocks.completeText,
  spawnSession: mocks.spawnSession,
  promptSession: mocks.promptSession,
  steerSession: mocks.steerSession,
  setSessionModel: mocks.setSessionModel,
  setSessionReasoning: mocks.setSessionReasoning,
  setSessionThinking: mocks.setSessionThinking,
  abortSession: vi.fn(),
  releaseParentSession: async () => ({ ok: true }),
}));
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => mocks.registry,
  readSessionHistoryFile: vi.fn(),
  setBotWorkerEventObserver: vi.fn(),
}));
vi.mock('./sessionIndex', () => ({
  agentSessionIndex: {
    currentIdentity: (id: string) => mocks.identities.get(id),
    prepareParent: (identity: { sessionId: string; generation: string }) =>
      mocks.identities.set(identity.sessionId, identity),
    isAlive: (id: string) => mocks.identities.has(id),
  },
}));

const main = { sender: { id: 1 } };
it('restricts queued interjection to the writable desktop Main renderer and validates identifiers', async () => {
  const channel = IPC_CHANNELS.BOT_CHAT_INTERJECT_QUEUED;
  mocks.isMain.mockReturnValue(false);
  expect(await call(channel, { chatId: 'forged', deliveryId: 'forged', actor: 'human' })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  mocks.isMain.mockReturnValue(true);
  expect((await call(channel, { chatId: 'forged', deliveryId: 'forged' })).ok).toBe(false);
  expect((await call(channel, null)).ok).toBe(false);
});
const call = async (channel: string, request?: unknown) => {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`missing ${channel}`);
  return (await handler(main, request)) as Record<string, unknown>;
};
const waitFor: typeof vi.waitFor = (fn, options) =>
  vi.waitFor(fn, {
    interval: 5,
    timeout: 1_000,
    ...(typeof options === 'number' ? { timeout: options } : options),
  });

beforeEach(async () => {
  mocks.root = realpathSync(mkdtempSync(join(tmpdir(), 'bots-ipc-')));
  mocks.registry = new SourceAuthorityRegistry({ registryFile: join(mocks.root, 'r.json') });
  mocks.settings = {
    botModeEnabled: true,
    defaultModel: { providerId: 'p', modelId: 'm' },
  };
  mocks.handlers.clear();
  mocks.identities.clear();
  mocks.spawnSession.mockClear();
  mocks.promptSession.mockClear();
  mocks.setSessionModel.mockClear();
  mocks.setSessionReasoning.mockClear();
  mocks.setSessionThinking.mockClear();
  mocks.isMain.mockReturnValue(true);
  mocks.workerReady = true;
  vi.resetModules();
  const { registerBotHandlers } = await import('./bots');
  registerBotHandlers();
});
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));

async function createBot(name: string): Promise<string> {
  const result = await call(IPC_CHANNELS.BOT_CREATE, { name, persona: 'Calm.' });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return (result.bot as { id: string }).id;
}

/** 第 nth 次 spawnSession 下发的实例号（Bot 宿主生成，随 spawn-parent 交给 worker） */
function instanceOf(nth: number): string | undefined {
  return (mocks.spawnSession.mock.calls[nth]?.[5] as { instanceId?: string } | undefined)
    ?.instanceId;
}

describe('bots IPC', () => {
  it('loads the configured capacity when services start and applies subsequent changes live', async () => {
    const { getBotServices, syncBotModeServices } = await import('./bots');
    mocks.settings.botModeEnabled = false;
    syncBotModeServices();
    mocks.settings.botMaxRunningTurns = 1;
    mocks.settings.botModeEnabled = true;
    const services = getBotServices()!;
    for (const text of ['one', 'two']) {
      const alice = await createBot(text);
      const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
        kind: 'direct',
        members: [alice],
        workspace: { kind: 'member-home' },
      });
      await services.host.deliver((created.chat as { id: string }).id, alice, text);
    }
    expect(mocks.promptSession).toHaveBeenCalledTimes(1);
    expect(services.host.queueState()).toMatchObject([{ reason: 'capacity' }]);
    mocks.settings.botMaxRunningTurns = 2;
    syncBotModeServices();
    await waitFor(() => expect(mocks.promptSession).toHaveBeenCalledTimes(2));
    expect(getBotServices()).toBe(services);
    expect(services.host.queueState()).toEqual([]);
  });

  it('讨论模式开关：Main 读本机设置传给群成员会话；切换只同步讨论与说明，不重建 Bot 服务', async () => {
    const { getBotServices, syncBotDiscussMode } = await import('./bots');
    const services = getBotServices()!;
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const group = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const groupId = (group.chat as { id: string }).id;
    type SpawnOptions = {
      bot: { groupTasks?: boolean; discussMode?: boolean; instruction: { content: string } };
    };
    // 非布尔值按关闭
    mocks.settings.botDiscussModeEnabled = 'true';
    expect(await services.host.deliver(groupId, alice, 'hi')).toMatchObject({ ok: true });
    const off = mocks.spawnSession.mock.calls[0][5] as SpawnOptions;
    expect(off.bot.groupTasks).toBe(true);
    expect(off.bot).not.toHaveProperty('discussMode');
    expect(off.bot.instruction.content).not.toContain('openly in the group');
    mocks.settings.botDiscussModeEnabled = true;
    const sync = vi.spyOn(services.groups, 'syncDiscussMode');
    const refresh = vi.spyOn(services.host, 'refreshGroupInstructions');
    syncBotDiscussMode();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(getBotServices()).toBe(services);
    expect(await services.host.deliver(groupId, bob, 'hi')).toMatchObject({ ok: true });
    const on = mocks.spawnSession.mock.calls[1][5] as SpawnOptions;
    expect(on.bot).toMatchObject({ groupTasks: true, discussMode: true });
    expect(on.bot.instruction.content).toContain('openly in the group');
  });

  it('审查：failed 状态但尚未 parent-ended 的旧实例，重建说明前仍须真正 release', async () => {
    const { getBotServices, syncBotDiscussMode } = await import('./bots');
    const agent = await import('../services/agentHost');
    const { agentSessionIndex } = await import('./sessionIndex');
    const services = getBotServices()!;
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const group = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const groupId = (group.chat as { id: string }).id;
    const first = await services.host.deliver(groupId, alice, 'first');
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    const registry = mocks.registry as SourceAuthorityRegistry;
    registry.markReady(id, join(mocks.root, 'session.jsonl'), { providerId: 'p', modelId: 'm' });
    const identity = mocks.identities.get(id)!;
    services.host.observe({ type: 'turn-failed', identity, seq: 2, turnId: 't1', error: 'failed' });
    // 真正 AgentSessionIndex.observe(status:failed) 将 alive 置 false，
    // 但 supervisor 通用异常并不销毁 sessions 里的实例，也不保证发 parent-ended。
    const alive = vi.spyOn(agentSessionIndex, 'isAlive').mockReturnValue(false);
    const release = vi.spyOn(agent, 'releaseParentSession');
    try {
      mocks.settings.botDiscussModeEnabled = true;
      syncBotDiscussMode();
      await services.host.refreshGroupInstructions();
      await services.host.deliver(groupId, alice, 'second');
      expect(release).toHaveBeenCalled();
    } finally {
      alive.mockRestore();
      release.mockRestore();
    }
  });

  it('status:failed 但未见实例结束：中止会话仍真正 release；已见 parent-ended / worker-exited 后不再空发 release', async () => {
    const { getBotServices } = await import('./bots');
    const { setBotWorkerEventObserver } = await import('./agent');
    const agent = await import('../services/agentHost');
    const { agentSessionIndex } = await import('./sessionIndex');
    const services = getBotServices()!;
    const observe = vi.mocked(setBotWorkerEventObserver).mock.calls.at(-1)?.[0];
    if (!observe) throw new Error('missing observer');
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const sent = await services.host.deliver(chatId, alice, 'first');
    if (!sent.ok) throw new Error(sent.error);
    const id = sent.conversationId;
    const identity = mocks.identities.get(id)!;
    observe({ type: 'turn-failed', identity, seq: 2, turnId: 't1', error: 'x' });
    // 会话索引因 status:failed 标为不活跃，supervisor 里的实例却还在
    const alive = vi.spyOn(agentSessionIndex, 'isAlive').mockReturnValue(false);
    const release = vi.spyOn(agent, 'releaseParentSession');
    try {
      await services.host.abortConversation(id);
      expect(release).toHaveBeenCalledTimes(1);
      // 闲置回收：实例真正结束，worker 里已没有它，再发 release-parent 只会空等超时
      expect(await services.host.deliver(chatId, alice, 'second')).toMatchObject({ ok: true });
      observe({
        type: 'parent-ended',
        identity,
        seq: 3,
        reason: 'evicted',
        instanceId: instanceOf(1),
      });
      await services.host.abortConversation(id);
      expect(release).toHaveBeenCalledTimes(1);
      expect(await services.host.deliver(chatId, alice, 'third')).toMatchObject({ ok: true });
      observe({ type: 'worker-exited' });
      await services.host.abortConversation(id);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      alive.mockRestore();
      release.mockRestore();
    }
  });

  it('审查48：旧 spawn+prompt 的第二次拒绝不能抹掉新 spawn 的实例登记', async () => {
    const { getBotServices } = await import('./bots');
    const { setBotWorkerEventObserver } = await import('./agent');
    const agent = await import('../services/agentHost');
    const { agentSessionIndex } = await import('./sessionIndex');
    const services = getBotServices()!;
    const observe = vi.mocked(setBotWorkerEventObserver).mock.calls.at(-1)![0]!;
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const sent = await services.host.deliver(chatId, alice, 'first');
    if (!sent.ok) throw new Error(sent.error);
    const id = sent.conversationId;
    const identity = mocks.identities.get(id)!;
    const alive = vi.spyOn(agentSessionIndex, 'isAlive').mockReturnValue(false);
    const release = vi.spyOn(agent, 'releaseParentSession');
    try {
      expect(
        await services.host.deliver(chatId, alice, 'second', { queueIfBusy: true })
      ).toMatchObject({ ok: true, queued: true });
      observe({
        type: 'parent-rejected',
        identity,
        seq: 0,
        reason: 'spawn preparation failed',
        instanceId: instanceOf(0),
      });
      await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledTimes(2));
      observe({
        type: 'parent-rejected',
        identity,
        seq: 0,
        reason: 'Unknown session',
        instanceId: instanceOf(0),
      });
      // 新 spawn 已下发；旧 prompt 的拒绝不证明这个新实例已经销毁。
      await services.host.abortConversation(id);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      alive.mockRestore();
      release.mockRestore();
    }
  });

  it('#49：闲置回收时在途 prompt 的拒绝晚于新 spawn 到达，不能抹掉新实例登记', async () => {
    const { getBotServices } = await import('./bots');
    const { setBotWorkerEventObserver } = await import('./agent');
    const agent = await import('../services/agentHost');
    const { agentSessionIndex } = await import('./sessionIndex');
    const services = getBotServices()!;
    const observe = vi.mocked(setBotWorkerEventObserver).mock.calls.at(-1)![0]!;
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const sent = await services.host.deliver(chatId, alice, 'first');
    if (!sent.ok) throw new Error(sent.error);
    const id = sent.conversationId;
    const identity = mocks.identities.get(id)!;
    observe({ type: 'status', identity, seq: 1, status: 'running' });
    observe({ type: 'turn-completed', identity, seq: 2, turnId: 't1' });
    const alive = vi.spyOn(agentSessionIndex, 'isAlive').mockReturnValue(false);
    const release = vi.spyOn(agent, 'releaseParentSession');
    try {
      expect(await services.host.deliver(chatId, alice, 'again')).toMatchObject({ ok: true });
      expect(
        await services.host.deliver(chatId, alice, 'third', { queueIfBusy: true })
      ).toMatchObject({ ok: true, queued: true });
      observe({
        type: 'parent-ended',
        identity,
        seq: 3,
        reason: 'evicted',
        instanceId: instanceOf(0),
      });
      await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledTimes(2));
      observe({
        type: 'parent-rejected',
        identity,
        seq: 0,
        reason: 'unknown or stale session generation',
        instanceId: instanceOf(0),
      });
      await services.host.abortConversation(id);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      alive.mockRestore();
      release.mockRestore();
    }
  });

  it('审查49：evicted 前 abort 的 idle 不得清掉在途 prompt 的拒绝归属', async () => {
    const { getBotServices } = await import('./bots');
    const { setBotWorkerEventObserver } = await import('./agent');
    const agent = await import('../services/agentHost');
    const services = getBotServices()!;
    const observe = vi.mocked(setBotWorkerEventObserver).mock.calls.at(-1)![0]!;
    const waiters: (() => void)[] = [];
    const emit = (event: Parameters<typeof observe>[0]) => {
      if (event.type === 'parent-ended' || event.type === 'parent-rejected')
        for (const wake of waiters.splice(0)) wake();
      observe(event);
    };
    const release = vi
      .spyOn(agent, 'releaseParentSession')
      .mockImplementation(
        () => new Promise((resolve) => waiters.push(() => resolve({ ok: true })))
      );
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const finished: { deliveryId?: string; ok: boolean }[] = [];
    services.host.onTurnFinished((event) => finished.push(event));
    try {
      const first = await services.host.deliver(chatId, alice, 'first', { deliveryId: 'first' });
      if (!first.ok) throw new Error(first.error);
      const id = first.conversationId;
      const identity = mocks.identities.get(id)!;
      emit({ type: 'status', identity, seq: 1, status: 'running' });
      emit({ type: 'turn-completed', identity, seq: 2, turnId: 't1' });
      // worker 已开始闲置回收，prompt 排在尚未完成的 releaseParent 后面。
      await services.host.deliver(chatId, alice, 'second', { deliveryId: 'second' });
      const stopping = services.host.abortConversation(id);
      await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      // 真 supervisor 的 abort 绕过 gate，在 evicted 之前发出 idle；不是 prompt 的确认。
      emit({ type: 'status', identity, seq: 3, status: 'idle' });
      emit({
        type: 'parent-ended',
        identity,
        seq: 4,
        reason: 'evicted',
        instanceId: instanceOf(0),
      });
      await stopping;
      expect(
        await services.host.deliver(chatId, alice, 'third', { deliveryId: 'third' })
      ).toMatchObject({ ok: true });
      await waitFor(() => expect(mocks.promptSession).toHaveBeenCalledTimes(3));
      // 旧 prompt 现在才执行，因旧会话已回收而拒绝；新 spawn 已发出但未回 ready。
      emit({
        type: 'parent-rejected',
        identity,
        seq: 0,
        reason: 'Unknown session',
        instanceId: instanceOf(0),
      });
      expect(finished.filter((event) => event.deliveryId === 'third')).toEqual([]);
      expect(services.host.runningCount()).toBe(1);
    } finally {
      release.mockRestore();
    }
  });

  it('阶段12：旧实例的拒绝晚于新 spawn 到达并唤醒 release 等待者时，新实例的 release 不算成功；新实例真正结束后事件归属正确', async () => {
    const { getBotServices } = await import('./bots');
    const { setBotWorkerEventObserver } = await import('./agent');
    const agent = await import('../services/agentHost');
    const { agentSessionIndex } = await import('./sessionIndex');
    const services = getBotServices()!;
    const observe = vi.mocked(setBotWorkerEventObserver).mock.calls.at(-1)![0]!;
    // 照真实 agentHost：同会话任意一条 parent-ended / parent-rejected 都唤醒 release 等待者，
    // 唤醒在前、同一条事件随后同步交给 Bot 观察者，release 的后续代码在两者之后才执行
    const waiters: (() => void)[] = [];
    const emit = (event: Parameters<typeof observe>[0]) => {
      if (event.type === 'parent-ended' || event.type === 'parent-rejected')
        for (const wake of waiters.splice(0)) wake();
      observe(event);
    };
    const release = vi
      .spyOn(agent, 'releaseParentSession')
      .mockImplementation(
        () => new Promise((resolve) => waiters.push(() => resolve({ ok: true })))
      );
    const alive = vi.spyOn(agentSessionIndex, 'isAlive').mockReturnValue(false);
    const finished: { ok: boolean; error?: string }[] = [];
    services.host.onTurnFinished((event) => finished.push(event));
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    try {
      const sent = await services.host.deliver(chatId, alice, 'first');
      if (!sent.ok) throw new Error(sent.error);
      const id = sent.conversationId;
      const identity = mocks.identities.get(id)!;
      expect(
        await services.host.deliver(chatId, alice, 'second', { queueIfBusy: true })
      ).toMatchObject({ ok: true, queued: true });
      // 旧实例：spawn 失败回第一条拒绝，宿主随即派出新 spawn；旧 prompt 的拒绝还在路上
      emit({
        type: 'parent-rejected',
        identity,
        seq: 0,
        reason: 'spawn preparation failed',
        instanceId: instanceOf(0),
      });
      await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledTimes(2));
      const aborting = services.host.abortConversation(id);
      await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      emit({
        type: 'parent-rejected',
        identity,
        seq: 0,
        reason: 'Unknown session',
        instanceId: instanceOf(0),
      });
      // 唤醒它的是旧实例的拒绝：新实例还在 worker 里，release 不能报成功
      await expect(aborting).rejects.toThrow('release-unconfirmed');
      // 新实例未确认结束前仍按停止中处理：新投递只排队，不另起实例
      expect(
        await services.host.deliver(chatId, alice, 'third', { queueIfBusy: true })
      ).toMatchObject({ ok: true, queued: true });
      expect(mocks.spawnSession).toHaveBeenCalledTimes(2);
      // 排在后面的 release-parent 真正销毁新实例：这条结束事件归新实例，确认释放并放行排队投递
      emit({ type: 'status', identity, seq: 1, status: 'running' });
      emit({
        type: 'parent-ended',
        identity,
        seq: 2,
        reason: 'released',
        instanceId: instanceOf(1),
      });
      await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(mocks.promptSession).toHaveBeenCalledTimes(3));
      const settled = finished.length;
      emit({ type: 'status', identity, seq: 1, status: 'running' });
      emit({ type: 'turn-completed', identity, seq: 2, turnId: 't3' });
      await waitFor(() => expect(finished.length).toBe(settled + 1));
      expect(finished.at(-1)).toMatchObject({ ok: true });
      // 第三个实例仍登记在案：中止要真正 release，由它自己的 parent-ended 正常确认
      const stopping = services.host.abortConversation(id);
      await waitFor(() => expect(release).toHaveBeenCalledTimes(2));
      emit({
        type: 'parent-ended',
        identity,
        seq: 3,
        reason: 'released',
        instanceId: instanceOf(2),
      });
      await expect(stopping).resolves.toBeUndefined();
    } finally {
      alive.mockRestore();
      release.mockRestore();
    }
  });

  it('阶段13：插话被 worker 吸收（无回执）后实例被回收，新实例自己的 spawn 失败照常结束登记，中止不再空发 release', async () => {
    const { getBotServices } = await import('./bots');
    const { setBotWorkerEventObserver } = await import('./agent');
    const agent = await import('../services/agentHost');
    const { agentSessionIndex } = await import('./sessionIndex');
    const services = getBotServices()!;
    const observe = vi.mocked(setBotWorkerEventObserver).mock.calls.at(-1)![0]!;
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const sent = await services.host.deliver(chatId, alice, 'first');
    if (!sent.ok) throw new Error(sent.error);
    const id = sent.conversationId;
    const identity = mocks.identities.get(id)!;
    observe({ type: 'status', identity, seq: 1, status: 'running' });
    const steers = mocks.steerSession.mock.calls.length;
    await services.host.deliver(chatId, alice, 'more');
    expect(mocks.steerSession).toHaveBeenCalledTimes(steers + 1);
    observe({
      type: 'parent-ended',
      identity,
      seq: 2,
      reason: 'evicted',
      instanceId: instanceOf(0),
    });
    expect(await services.host.deliver(chatId, alice, 'next')).toMatchObject({ ok: true });
    expect(mocks.spawnSession).toHaveBeenCalledTimes(2);
    expect(instanceOf(1)).not.toBe(instanceOf(0));
    observe({
      type: 'parent-rejected',
      identity,
      seq: 0,
      reason: 'spawn failed',
      instanceId: instanceOf(1),
    });
    const alive = vi.spyOn(agentSessionIndex, 'isAlive').mockReturnValue(false);
    const release = vi.spyOn(agent, 'releaseParentSession');
    try {
      await services.host.abortConversation(id);
      expect(release).not.toHaveBeenCalled();
    } finally {
      alive.mockRestore();
      release.mockRestore();
    }
  });

  it('saving a member model synchronizes idle sessions and reasoning without respawning', async () => {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    const sent = await services.host.deliver(chatId, alice, 'hello');
    if (!sent.ok) throw new Error(sent.error);
    const identity = mocks.identities.get(sent.conversationId)!;
    services.host.observe({ type: 'turn-completed', identity, seq: 1, turnId: 't1' });
    expect(
      await call(IPC_CHANNELS.BOT_UPDATE, {
        botId: alice,
        draft: { engine: { providerId: 'p2', modelId: 'm2', thinkingLevel: 'high' } },
      })
    ).toMatchObject({ ok: true });
    expect(mocks.setSessionModel).toHaveBeenLastCalledWith(identity, 'p2', 'm2', new Set());
    expect(mocks.setSessionReasoning).toHaveBeenLastCalledWith(identity, true, 'high');
    expect(mocks.setSessionThinking).toHaveBeenLastCalledWith(identity, 'high');
    expect(
      await call(IPC_CHANNELS.BOT_UPDATE, { botId: alice, draft: { engine: null } })
    ).toMatchObject({ ok: true });
    expect(mocks.setSessionModel).toHaveBeenLastCalledWith(identity, 'p', 'm', new Set());
    expect(mocks.spawnSession).toHaveBeenCalledTimes(1);
  });
  it('自动设置能力：入参收窄；worker 未就绪时报 no-model；开关关闭报 disabled', async () => {
    mocks.workerReady = false;
    expect(await call(IPC_CHANNELS.BOT_SUGGEST_ABILITIES, { name: 'x', path: '/etc' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(
      await call(IPC_CHANNELS.BOT_SUGGEST_ABILITIES, { name: 'Rex', scope: 'Reviews PRs' })
    ).toEqual({ ok: false, error: 'no-model' });
    mocks.settings.botModeEnabled = false;
    expect(await call(IPC_CHANNELS.BOT_SUGGEST_ABILITIES, { name: 'Rex' })).toEqual({
      ok: false,
      error: 'disabled',
    });
  });

  it('mode off disposes the host and rebuilding on mode on creates fresh services', async () => {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const { getBotServices, syncBotModeServices } = await import('./bots');
    const previous = getBotServices()!;
    await previous.host.deliver(chatId, alice, 'first');
    mocks.settings.botModeEnabled = false;
    syncBotModeServices();
    expect(await previous.host.deliver(chatId, alice, 'later')).toEqual({
      ok: false,
      error: 'disabled',
    });
    expect(getBotServices()).toBeNull();
    mocks.settings.botModeEnabled = true;
    syncBotModeServices();
    expect(getBotServices()).not.toBe(previous);
  });
  it('validates routine ownership and cron; projects list/save/remove and disabled lists', async () => {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const draft = {
      botId: alice,
      chatId,
      title: 'Check',
      prompt: 'check status',
      schedule: '0 9 * * *',
    };
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, { ...draft, botId: bob })).toMatchObject({
      ok: false,
    });
    expect(
      await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, { ...draft, schedule: 'invalid' })
    ).toMatchObject({ ok: false });
    const saved = await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, draft);
    expect(saved.ok).toBe(true);
    expect(await call(IPC_CHANNELS.BOT_ROUTINES_LIST, { botId: alice })).toMatchObject({
      routines: [saved.routine],
    });
    const id = (saved.routine as { id: string }).id;
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_DELETE, { botId: bob, id })).toMatchObject({
      ok: false,
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_DELETE, { botId: alice, id })).toEqual({ ok: true });
    mocks.settings.botModeEnabled = false;
    expect(await call(IPC_CHANNELS.BOT_ROUTINES_LIST)).toEqual({
      ok: true,
      routines: [],
      enabled: false,
    });
    expect(await call(IPC_CHANNELS.BOT_DELEGATIONS_LIST)).toEqual({
      ok: true,
      delegations: [],
      enabled: false,
    });
    expect(await call(IPC_CHANNELS.BOT_DELEGATION_CANCEL, { id })).toMatchObject({
      ok: false,
      error: 'disabled',
    });
  });
  it('开关关闭：写返回 disabled，列表为空，不落任何 Bot 目录', async () => {
    mocks.settings.botModeEnabled = false;
    expect(await call(IPC_CHANNELS.BOT_CREATE, { name: 'Alice' })).toEqual({
      ok: false,
      error: 'disabled',
    });
    expect(await call(IPC_CHANNELS.BOTS_LIST)).toEqual({ ok: true, bots: [], enabled: false });
    expect(existsSync(join(mocks.root, 'bots'))).toBe(false);
  });

  it('非主窗口写入被拒；名字不能占用 agent 类型名', async () => {
    mocks.isMain.mockReturnValue(false);
    expect(await call(IPC_CHANNELS.BOT_CREATE, { name: 'Alice' })).toMatchObject({ ok: false });
    mocks.isMain.mockReturnValue(true);
    expect(await call(IPC_CHANNELS.BOT_CREATE, { name: 'scout' })).toEqual({
      ok: false,
      error: 'reserved',
    });
    expect(await call(IPC_CHANNELS.BOT_CREATE, { name: 'reviewer' })).toEqual({
      ok: false,
      error: 'reserved',
    });
  });

  it('头像：只收 botId + 2MB 内的 PNG/JPEG/WebP；协议按 botId 寻址；删除成员清理文件', async () => {
    const alice = await createBot('Alice');
    const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0);
    const file = join(mocks.root, 'bots', alice, 'avatar.png');
    for (const image of ['x', [1, 2], new TextEncoder().encode('<svg/>'), new Uint8Array()]) {
      expect(await call(IPC_CHANNELS.BOT_SET_AVATAR, { botId: alice, image })).toEqual({
        ok: false,
        error: 'invalid',
      });
    }
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(png);
    expect(await call(IPC_CHANNELS.BOT_SET_AVATAR, { botId: alice, image: big })).toMatchObject({
      ok: false,
    });
    expect(existsSync(file)).toBe(false);

    const set = await call(IPC_CHANNELS.BOT_SET_AVATAR, { botId: alice, image: png });
    expect(set).toMatchObject({ ok: true, bot: { avatar: { image: 2 } } });
    const { botAvatarFile } = await import('../services/localImageProtocol');
    expect(botAvatarFile(alice)).toBe(file);
    expect(botAvatarFile('../x')).toBeNull();

    await call(IPC_CHANNELS.BOT_SET_AVATAR, { botId: alice, image: null });
    expect(existsSync(file)).toBe(false);
    expect(botAvatarFile(alice)).toBeNull();

    await call(IPC_CHANNELS.BOT_SET_AVATAR, { botId: alice, image: png });
    expect((await call(IPC_CHANNELS.BOT_DELETE, { botId: alice })).ok).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('私聊发送：Main 组装人设并在成员 home 里 spawn，之后 prompt', async () => {
    const alice = await createBot('Alice');
    const draft = { kind: 'direct', members: [alice], workspace: { kind: 'member-home' } };
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, draft);
    const again = await call(IPC_CHANNELS.BOT_CHAT_CREATE, draft);
    const chatId = (created.chat as { id: string }).id;
    expect((again.chat as { id: string }).id).toBe(chatId);

    const sent = await call(IPC_CHANNELS.BOT_SEND, { chatId, text: 'hello', deliveryId: 'd1' });
    expect(sent).toMatchObject({ ok: true });
    const [identity, request, , remote, projectId, options] = mocks.spawnSession.mock.calls[0] as [
      { sessionId: string },
      Record<string, unknown>,
      unknown,
      unknown,
      string,
      { bot: { systemPrompt: string; instruction: { content: string } } },
    ];
    expect(identity.sessionId).toBe(sent.conversationId);
    expect(request).toMatchObject({
      providerId: 'p',
      modelId: 'm',
      cwd: join(mocks.root, 'bots', alice, 'workspace'),
      approvalMode: 'full',
    });
    expect(remote).toBeUndefined();
    expect(projectId).toBeTruthy();
    expect(options.bot.systemPrompt).toContain('You are Alice.');
    expect(options.bot.systemPrompt).toContain('Calm.');
    expect(options.bot.instruction.content).toContain('Bot mode');
    expect(mocks.promptSession).toHaveBeenCalledWith(identity, 'hello', undefined, 'd1');
  });

  it('审查回归：resume 投递经真实 runtime 透传到 agentHost.promptSession', async () => {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    const session = services.host.ensureSession(chatId, alice);
    if (!session.ok) throw new Error(session.error);
    const result = await services.host.deliverConversation(session.conversationId, '继续断点', {
      deliveryId: 'review-resume',
      resume: true,
    });
    expect(result.ok).toBe(true);
    expect(mocks.promptSession).toHaveBeenCalledWith(
      mocks.identities.get(session.conversationId),
      '继续断点',
      undefined,
      'review-resume',
      true
    );
  });

  it('输入框引用：越权与不存在的标识在发给 worker 之前拒绝；技能与聊天摘录由 Main 展开', async () => {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const direct = async (members: string[]) =>
      (
        (
          await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
            kind: 'direct',
            members,
            workspace: { kind: 'member-home' },
          })
        ).chat as { id: string }
      ).id;
    const chatId = await direct([alice]);
    const otherId = await direct([bob]);
    const home = join(mocks.root, 'bots', alice, 'workspace');
    mkdirSync(join(home, 'src'), { recursive: true });
    writeFileSync(join(home, 'src', 'a.ts'), 'x');
    writeFileSync(join(mocks.root, 'outside.txt'), 'x');
    const skillDir = join(mocks.root, 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: review\n---\nReview carefully.');
    mocks.settings.skills = [
      { id: 's-review', name: 'review', description: '', path: skillDir, source: 'x' },
    ];

    const send = (extra: Record<string, unknown>) =>
      call(IPC_CHANNELS.BOT_SEND, {
        chatId,
        text: 'hi',
        deliveryId: crypto.randomUUID(),
        ...extra,
      });
    expect(await send({ chats: ['99999999-9999-4999-8999-999999999999'] })).toEqual({
      ok: false,
      error: 'chat-ref-not-found',
    });
    expect(await send({ files: ['../../outside.txt'] })).toEqual({
      ok: false,
      error: 'file-outside-workspace',
    });
    expect(await send({ skill: 's-review' })).toEqual({ ok: false, error: 'skill-unavailable' });
    expect(mocks.spawnSession).not.toHaveBeenCalled();
    expect(mocks.promptSession).not.toHaveBeenCalled();

    expect(
      await call(IPC_CHANNELS.BOT_FILE_SEARCH, {
        chatId: '99999999-9999-4999-8999-999999999999',
        query: '',
      })
    ).toEqual({ ok: false, error: 'invalid' });
    expect(await call(IPC_CHANNELS.BOT_FILE_SEARCH, { chatId, query: 'a', root: '/' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    const found = await call(IPC_CHANNELS.BOT_FILE_SEARCH, { chatId, query: 'a.ts' });
    expect(found).toMatchObject({ ok: true, files: [{ relativePath: 'src/a.ts' }] });

    const sent = await send({ files: ['src/a.ts'], chats: [otherId], text: '看 @src/a.ts' });
    expect(sent).toMatchObject({ ok: true });
    const text = mocks.promptSession.mock.calls[0][1] as string;
    expect(text.startsWith('看 @src/a.ts\n\n<chat-reference id="')).toBe(true);
    expect(text).toContain('title="Bob" kind="direct"');
  });

  it('私聊回退：校验目标、取消越过的委派、退回记忆水位；群聊与忙碌会话拒绝', async () => {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const { getBotServices, rewindBotChat, retryBotChat } = await import('./bots');
    const services = getBotServices()!;
    const session = services.host.ensureSession(chatId, alice);
    if (!session.ok) throw new Error(session.error);
    const conv = session.conversationId;
    const rewind = vi.fn((..._args: unknown[]) => ({ ok: true }));
    (
      services.host as unknown as { deps: { runtime: Record<string, unknown> } }
    ).deps.runtime.rewind = rewind;
    const branch = [
      { id: 'h' },
      { id: 'u1', userAt: 100 },
      { id: 'a1' },
      { id: 'u2', userAt: 200 },
      { id: 'a2' },
    ];
    const readBranch = async () => branch;
    const save = (patch: Record<string, unknown>) =>
      (
        services.delegations as unknown as { deps: { store: { save(r: unknown): void } } }
      ).deps.store.save({
        id: crypto.randomUUID(),
        parentConversationId: conv,
        parentBotId: alice,
        targetBotId: bob,
        chatId,
        task: 't',
        context: '',
        childConversationId: crypto.randomUUID(),
        depth: 1,
        ...patch,
      });
    const ids = { old: crypto.randomUUID(), late: crypto.randomUUID(), live: crypto.randomUUID() };
    save({ id: ids.old, state: 'completed', createdAt: 150 });
    save({ id: ids.late, state: 'completed', createdAt: 250 });
    save({ id: ids.live, state: 'running', createdAt: 260 });
    services.chats.update(chatId, (draft) => {
      draft.sessions[alice].distilledTo = 'a2';
      return draft;
    });

    expect(await rewindBotChat(services, { chatId, entryId: 'a1' }, readBranch)).toEqual({
      ok: false,
      error: 'rewind-target-not-found',
    });
    expect(
      await rewindBotChat(services, { chatId, entryId: 'u2', path: '/x' }, readBranch)
    ).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(rewind).not.toHaveBeenCalled();

    expect(
      await rewindBotChat(services, { chatId, entryId: 'u2', restoreFiles: true }, readBranch)
    ).toEqual({ ok: true });
    expect(rewind).toHaveBeenCalledWith(conv, 'u2', true);
    const state = (key: keyof typeof ids) =>
      services.delegations.list().find((item) => item.id === ids[key]);
    expect(state('old')?.deliveredAt).toBeUndefined();
    expect(state('late')?.deliveredAt).toBeDefined();
    expect(state('live')).toMatchObject({ state: 'canceled' });
    expect(state('live')?.deliveredAt).toBeDefined();
    expect(services.chats.get(chatId)?.sessions[alice].distilledTo).toBe('a1');

    await services.host.deliver(chatId, alice, 'busy now');
    expect(await rewindBotChat(services, { chatId, entryId: 'u1' }, readBranch)).toEqual({
      ok: false,
      error: 'session-busy',
    });
    expect(await retryBotChat(services, { chatId })).toEqual({ ok: false, error: 'session-busy' });

    const group = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const groupId = (group.chat as { id: string }).id;
    expect(await rewindBotChat(services, { chatId: groupId, entryId: 'u1' }, readBranch)).toEqual({
      ok: false,
      error: 'direct-only',
    });
    expect(await retryBotChat(services, { chatId: groupId })).toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it('核心笔记：入参收窄、version 防覆盖、只支持群笔记，保存后注入新会话系统提示词', async () => {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    for (const bad of [undefined, { botId: 'x' }, { botId: alice, path: '/etc' }, { chatId }])
      expect(await call(IPC_CHANNELS.BOT_NOTES_GET, bad)).toEqual({ ok: false, error: 'invalid' });
    const empty = await call(IPC_CHANNELS.BOT_NOTES_GET, { botId: alice });
    expect(empty).toMatchObject({ ok: true, notes: { content: '', maxChars: 3000 } });
    const version = (empty.notes as { version: string }).version;
    mocks.isMain.mockReturnValue(false);
    expect(
      await call(IPC_CHANNELS.BOT_NOTES_SAVE, { botId: alice, content: '- tea', version })
    ).toMatchObject({ ok: false });
    mocks.isMain.mockReturnValue(true);
    const saved = await call(IPC_CHANNELS.BOT_NOTES_SAVE, {
      botId: alice,
      content: '- likes tea',
      version,
    });
    expect(saved).toMatchObject({ ok: true, notes: { content: '- likes tea' } });
    expect(
      await call(IPC_CHANNELS.BOT_NOTES_SAVE, { botId: alice, content: '- coffee', version })
    ).toEqual({ ok: false, error: 'conflict' });
    expect(
      await call(IPC_CHANNELS.BOT_NOTES_SAVE, { chatId, content: '- x', version: '' })
    ).toEqual({ ok: false, error: 'invalid' });

    await call(IPC_CHANNELS.BOT_SEND, { chatId, text: 'hello', deliveryId: 'd1' });
    const options = mocks.spawnSession.mock.calls[0][5] as { bot: { systemPrompt: string } };
    expect(options.bot.systemPrompt).toContain('<member-notes>\n- likes tea\n</member-notes>');
  });

  it('群聊发送接入；状态和停止可用；改选工作区清空会话；删除群清理目录', async () => {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const group = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    expect(group.ok).toBe(true);
    expect(group.chat).toMatchObject({ routing: { mode: 'smart' } });
    const chatId = (group.chat as { id: string }).id;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await call(IPC_CHANNELS.BOT_SEND, { chatId, text: 'hi', deliveryId: 'd' })).toEqual({
      ok: true,
    });
    // 新群缺省智能选人；worker 不在线没有可用模型 → 兜底群主
    await waitFor(async () =>
      expect(await call(IPC_CHANNELS.BOT_CHAT_STATE, { chatId })).toMatchObject({
        ok: true,
        current: alice,
        queue: [],
        pendingHuman: false,
        routing: false,
      })
    );
    warn.mockRestore();
    expect(await call(IPC_CHANNELS.BOT_CHAT_STOP, { chatId })).toEqual({ ok: true });
    expect(await call(IPC_CHANNELS.BOT_CHAT_STATE, { chatId })).toMatchObject({
      ok: true,
      current: null,
    });

    const { getBotServices } = await import('./bots');
    const session = getBotServices()!.host.ensureSession(chatId, bob);
    if (!session.ok) throw new Error(session.error);
    const code = join(mocks.root, 'code');
    mkdirSync(code);
    const registry = mocks.registry as SourceAuthorityRegistry;
    const project = registry.createProject({ requestId: 'p', path: code });
    if (!project.accepted) throw new Error('project');
    const updated = await call(IPC_CHANNELS.BOT_CHAT_UPDATE, {
      chatId,
      workspace: { kind: 'project', projectId: project.value.projectId },
    });
    expect(updated).toMatchObject({ ok: true, chat: { sessions: {} } });
    expect(registry.conversation(session.conversationId)?.lifecycle).toBe('ended');

    expect(await call(IPC_CHANNELS.BOT_CHAT_DELETE, { chatId })).toEqual({ ok: true });
    expect(existsSync(join(mocks.root, 'bot-chats', chatId))).toBe(false);
  });

  it('群聊里人发的图存进聊天 media 并挂在时间线条目上，可按条目读取', async () => {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const group = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const chatId = (group.chat as { id: string }).id;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('pixels'),
    ]).toString('base64');
    expect(
      await call(IPC_CHANNELS.BOT_SEND, {
        chatId,
        text: '看这张',
        images: [
          { data: png, mimeType: 'image/png' },
          { data: Buffer.from('not an image').toString('base64'), mimeType: 'image/png' },
        ],
        deliveryId: 'img',
      })
    ).toEqual({ ok: false, error: 'image-not-image' });
    expect(mocks.promptSession).not.toHaveBeenCalled();
    expect((await call(IPC_CHANNELS.BOT_CHAT_TIMELINE, { chatId })).entries).toEqual([]);
    expect(
      await call(IPC_CHANNELS.BOT_SEND, {
        chatId,
        text: '看这张',
        images: [{ data: png, mimeType: 'image/png' }],
        deliveryId: 'img',
      })
    ).toEqual({ ok: true });
    const timeline = await call(IPC_CHANNELS.BOT_CHAT_TIMELINE, { chatId });
    const human = (timeline.entries as { kind: string; id: string; images?: string[] }[]).find(
      (entry) => entry.kind === 'human'
    );
    expect(human?.images).toHaveLength(1);
    const mediaId = human!.images![0];
    const media = await import('../services/bots/media');
    const store = vi.spyOn(media, 'storeMedia').mockReturnValue({ ok: false, error: 'quota' });
    expect(
      await call(IPC_CHANNELS.BOT_SEND, {
        chatId,
        text: 'duplicate',
        images: [{ data: png, mimeType: 'image/png' }],
        deliveryId: 'img',
      })
    ).toMatchObject({ ok: true, duplicate: true });
    expect(store).not.toHaveBeenCalled();
    const calls = mocks.promptSession.mock.calls.length;
    expect(
      await call(IPC_CHANNELS.BOT_SEND, {
        chatId,
        text: 'full',
        images: [{ data: png, mimeType: 'image/png' }],
        deliveryId: 'new',
      })
    ).toEqual({ ok: false, error: 'image-quota' });
    expect(mocks.promptSession).toHaveBeenCalledTimes(calls);
    store.mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(
      await call(IPC_CHANNELS.BOT_SEND, {
        chatId,
        text: 'disk full',
        images: [{ data: png, mimeType: 'image/png' }],
        deliveryId: 'new',
      })
    ).toEqual({ ok: false, error: 'image-storage' });
    store.mockRestore();
    expect(existsSync(join(mocks.root, 'bot-chats', chatId, 'media', mediaId))).toBe(true);
    expect(await call(IPC_CHANNELS.BOT_ARTIFACTS_LIST, { chatId, entryId: human!.id })).toEqual({
      ok: true,
      artifacts: [],
      media: [{ ok: true, mediaId, source: 'upload' }],
    });
    expect(
      await call(IPC_CHANNELS.BOT_ARTIFACT_READ, {
        chatId,
        entryId: human!.id,
        mediaId,
        variant: 'full',
      })
    ).toEqual({ ok: true, kind: 'image', dataUrl: `data:image/png;base64,${png}` });
  });
});

describe('群任务看板 IPC', () => {
  async function team() {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const carol = await createBot('Carol');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob, carol],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const chat = created.chat as { id: string; version: number };
    return { alice, bob, carol, chatId: chat.id, version: chat.version };
  }

  it('入参收窄、新建 / 编辑 / 完成 / 删除，删除群时清理任务文件', async () => {
    const { chatId } = await team();
    expect(await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, title: 1 })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId: '../x', title: 'a' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    const saved = await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, title: 'Login', detail: 'd' });
    expect(saved).toMatchObject({ ok: true, task: { seq: 1, status: 'todo', createdBy: 'human' } });
    const id = (saved.task as { id: string }).id;
    expect(await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, id, title: 'Login v2' })).toMatchObject(
      { ok: true, task: { title: 'Login v2' } }
    );
    expect(
      await call(IPC_CHANNELS.BOT_TASK_SAVE, {
        chatId,
        id,
        title: 'Login v2',
        check: 'x'.repeat(201),
      })
    ).toEqual({ ok: false, error: 'invalid' });
    expect(
      await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, id, title: 'Login v2', check: ' PASS ' })
    ).toMatchObject({ ok: true, task: { check: { kind: 'output-contains', text: 'PASS' } } });
    expect(
      (await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, id, title: 'Login v2', check: '' })).task
    ).not.toHaveProperty('check');
    expect(await call(IPC_CHANNELS.BOT_TASK_COMPLETE, { chatId, id, result: 'ok' })).toMatchObject({
      ok: true,
      task: { status: 'done', result: 'ok' },
    });
    expect(await call(IPC_CHANNELS.BOT_TASKS_LIST, { chatId })).toMatchObject({
      ok: true,
      enabled: true,
      tasks: [{ id, status: 'done' }],
    });
    expect(await call(IPC_CHANNELS.BOT_TASK_DELETE, { chatId, id })).toEqual({ ok: true });
    await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, title: 'Keep' });
    const file = join(mocks.root, 'bot-chats', chatId, 'tasks.jsonl');
    expect(existsSync(file)).toBe(true);
    expect(await call(IPC_CHANNELS.BOT_CHAT_DELETE, { chatId })).toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
    expect(await call(IPC_CHANNELS.BOT_TASKS_LIST, { chatId })).toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it('人类验收 IPC：入参收窄，退回必须带原因 → todo，再次交付后通过 → done', async () => {
    const { alice, bob, chatId } = await team();
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    const added = services.tasks.add(chatId, alice, { title: 'Login' });
    if (!added.ok) throw new Error(added.error);
    const id = added.task.id;
    const record = {
      id: '77777777-7777-4777-8777-777777777777',
      parentConversationId: 'p',
      parentBotId: alice,
      targetBotId: bob,
      chatId,
      task: 't',
      context: '',
      childConversationId: 'c',
      state: 'running' as const,
      depth: 1,
      createdAt: 1,
      taskId: id,
    };
    services.tasks.sync(record);
    services.tasks.sync({ ...record, state: 'completed', result: 'ok' });
    for (const bad of [
      { chatId, id },
      { chatId, id, accept: 'yes' },
      { chatId, id, accept: false },
      { chatId, id, accept: false, reason: 'x'.repeat(4001) },
      { chatId, id, accept: false, reason: 'redo', rework: 'yes' },
      { chatId, id, accept: true, rework: true },
    ])
      expect(await call(IPC_CHANNELS.BOT_TASK_REVIEW, bad)).toEqual({
        ok: false,
        error: 'invalid',
      });
    // 返工交给委派服务：这里的执行记录不在委派存储里，原样报错且任务不变
    expect(
      await call(IPC_CHANNELS.BOT_TASK_REVIEW, {
        chatId,
        id,
        accept: false,
        reason: 'redo',
        rework: true,
      })
    ).toEqual({ ok: false, error: 'Delegation not found.' });
    expect(
      await call(IPC_CHANNELS.BOT_TASK_REVIEW, { chatId, id, accept: false, reason: 'redo' })
    ).toMatchObject({ ok: true, task: { status: 'todo', returnReason: 'redo' } });
    services.tasks.sync({ ...record, id: '88888888-8888-4888-8888-888888888888' });
    services.tasks.sync({
      ...record,
      id: '88888888-8888-4888-8888-888888888888',
      state: 'completed',
      result: 'ok2',
    });
    expect(await call(IPC_CHANNELS.BOT_TASK_REVIEW, { chatId, id, accept: true })).toMatchObject({
      ok: true,
      task: { status: 'done', result: 'ok2' },
    });
    // 任务卡回复：入参按 unknown 收窄；已完成的任务只记评论
    for (const bad of [
      { chatId, id },
      { chatId, id, text: 3 },
      { chatId, id, text: '  ' },
      { chatId, id, text: 'x'.repeat(4001) },
      { chatId: 'nope', id, text: 'hi' },
    ])
      expect(await call(IPC_CHANNELS.BOT_TASK_REPLY, bad)).toEqual({
        ok: false,
        error: 'invalid',
      });
    expect(await call(IPC_CHANNELS.BOT_TASK_REPLY, { chatId, id, text: '辛苦了' })).toMatchObject({
      ok: true,
      task: { status: 'done' },
    });
  });

  it('移出成员时其认领中的任务退回 todo；开关关闭时列表为空、写返回 disabled', async () => {
    const { alice, bob, carol, chatId, version } = await team();
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    services.tasks.add(chatId, 'human', { title: 'Login' });
    expect(services.tasks.claim(chatId, bob, '#1')).toMatchObject({ ok: true });
    expect(
      await call(IPC_CHANNELS.BOT_CHAT_UPDATE, {
        chatId,
        expectedVersion: version,
        members: [alice, carol],
      })
    ).toMatchObject({ ok: true });
    expect(services.tasks.list(chatId)[0]).toMatchObject({ status: 'todo' });
    expect(services.tasks.list(chatId)[0]).not.toHaveProperty('assigneeBotId');
    mocks.settings.botModeEnabled = false;
    expect(await call(IPC_CHANNELS.BOT_TASKS_LIST, { chatId })).toEqual({
      ok: true,
      tasks: [],
      enabled: false,
    });
    expect(await call(IPC_CHANNELS.BOT_TASK_SAVE, { chatId, title: 'x' })).toEqual({
      ok: false,
      error: 'disabled',
    });
  });

  it('group_tasks 工具只对群聊当前会话开放', async () => {
    const { alice, chatId } = await team();
    const { getBotServices, groupTasksTool } = await import('./bots');
    const services = getBotServices()!;
    const session = services.host.ensureSession(chatId, alice);
    if (!session.ok) throw new Error(session.error);
    expect(
      groupTasksTool(
        services,
        session.conversationId,
        { botId: alice, chatId },
        {
          action: 'add',
          title: 'Plan',
        }
      )
    ).toMatchObject({ ok: true, task: { id: '#1', createdBy: 'Alice' } });
    expect(
      groupTasksTool(services, 'stale', { botId: alice, chatId }, { action: 'list' })
    ).toMatchObject({ ok: false });
    expect(
      groupTasksTool(
        services,
        session.conversationId,
        { botId: alice, chatId: null },
        {
          action: 'list',
        }
      )
    ).toMatchObject({ ok: false });
  });

  it('group_history 只读本群时间线，chatId 取自会话权威，越权一律拒绝', async () => {
    const { alice, bob, carol, chatId } = await team();
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'other',
      members: [bob, carol],
      bossBotId: bob,
      workspace: { kind: 'chat-home' },
    });
    const other = { chatId: (created.chat as { id: string }).id };
    const { getBotServices, groupHistoryTool } = await import('./bots');
    const services = getBotServices()!;
    services.chats.appendEntry(chatId, {
      kind: 'human',
      text: '本群早期约定：周五发布',
      mentions: [],
      id: 'h1',
      at: 1,
    });
    services.chats.appendEntry(other.chatId, {
      kind: 'human',
      text: '别的群秘密',
      mentions: [],
      id: 'h2',
      at: 1,
    });
    const session = services.host.ensureSession(chatId, alice);
    if (!session.ok) throw new Error(session.error);
    const read = groupHistoryTool(
      services,
      session.conversationId,
      { botId: alice, chatId },
      { query: '约定', chatId: other.chatId }
    );
    expect(read).toMatchObject({
      ok: true,
      entries: [{ from: '用户', text: '本群早期约定：周五发布' }],
    });
    expect(JSON.stringify(read)).not.toContain('别的群秘密');
    expect(groupHistoryTool(services, 'stale', { botId: alice, chatId }, {})).toMatchObject({
      ok: false,
    });
    expect(
      groupHistoryTool(services, session.conversationId, { botId: alice, chatId: null }, {})
    ).toMatchObject({ ok: false });
    expect(
      groupHistoryTool(services, session.conversationId, { botId: bob, chatId }, {})
    ).toMatchObject({ ok: false });
    expect(
      groupHistoryTool(services, session.conversationId, { botId: alice, chatId }, { limit: 'x' })
    ).toMatchObject({ ok: false });
    expect(
      groupHistoryTool(null, session.conversationId, { botId: alice, chatId }, {})
    ).toMatchObject({ ok: false });
  });
});

describe('例行任务生命周期', () => {
  async function group(options: { bobAcceptsNobody?: boolean } = {}) {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CREATE, {
      name: 'Bob',
      persona: 'Calm.',
      ...(options.bobAcceptsNobody ? { delegation: { canDelegateTo: 'any', acceptFrom: [] } } : {}),
    });
    const bob = (created.bot as { id: string }).id;
    const carol = await createBot('Carol');
    const chat = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const chatId = (chat.chat as { id: string }).id;
    const { getBotServices, routineProposeTool } = await import('./bots');
    const services = getBotServices()!;
    const session = services.host.ensureSession(chatId, alice);
    if (!session.ok) throw new Error(session.error);
    return { alice, bob, carol, chatId, services, routineProposeTool, session };
  }

  it('routine_propose：只对成员当前会话开放，解析简单调度，越权与坏参数拒绝', async () => {
    const { alice, bob, chatId, services, routineProposeTool, session } = await group();
    const binding = { botId: alice, chatId };
    const params = { title: '日报', prompt: '汇总今天的进展', schedule: '工作日 18:30' };
    for (const [conversationId, bad] of [
      ['stale', binding],
      [session.conversationId, { botId: alice, chatId: null }],
      [session.conversationId, { ...binding, delegationId: 'd' }],
      [session.conversationId, { botId: bob, chatId }],
    ] as const)
      expect(routineProposeTool(services, conversationId, bad, params)).toMatchObject({
        ok: false,
      });
    expect(routineProposeTool(null, session.conversationId, binding, params)).toMatchObject({
      ok: false,
    });
    expect(
      routineProposeTool(services, session.conversationId, binding, {
        ...params,
        schedule: 'sometimes',
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining('cron') });
    expect(
      routineProposeTool(services, session.conversationId, binding, { ...params, prompt: '' })
    ).toMatchObject({ ok: false });
    expect(
      routineProposeTool(services, session.conversationId, binding, {
        ...params,
        doneBy: 'Nobody',
      })
    ).toMatchObject({ ok: false });
    expect(
      routineProposeTool(services, session.conversationId, binding, { ...params, doneBy: 'carol' })
    ).toMatchObject({ ok: false });

    const proposed = routineProposeTool(services, session.conversationId, binding, {
      ...params,
      doneBy: 'bob',
    });
    expect(proposed).toMatchObject({ ok: true, status: 'draft', doneBy: 'Bob' });
    const listed = await call(IPC_CHANNELS.BOT_ROUTINES_LIST, { botId: alice });
    expect(listed.routines).toEqual([
      expect.objectContaining({
        status: 'draft',
        schedule: '30 18 * * 1-5',
        doneBy: bob,
        proposedBy: alice,
      }),
    ]);
    const id = (proposed as { id: string }).id;
    expect(services.chats.readEntries(chatId).at(-1)).toMatchObject({
      kind: 'system',
      routine: { botId: alice, id },
      text: expect.stringContaining('等待批准'),
    });
  });

  it('routine_propose 遵守委派 ACL：执行成员不接受委派时拒绝', async () => {
    const { alice, chatId, services, routineProposeTool, session } = await group({
      bobAcceptsNobody: true,
    });
    expect(
      routineProposeTool(
        services,
        session.conversationId,
        { botId: alice, chatId },
        { title: 't', prompt: 'p', schedule: 'hourly', doneBy: 'Bob' }
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('does not accept') });
    expect(
      await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, {
        botId: alice,
        chatId,
        title: 't',
        prompt: 'p',
        schedule: '0 9 * * *',
        doneBy: (services.bots.list().find((bot) => bot.name === 'Bob') as { id: string }).id,
      })
    ).toEqual({ ok: false, error: 'acl' });
  });

  it('审批、试运行、手动运行与运行历史经 IPC 收窄', async () => {
    const { alice, chatId, services, routineProposeTool, session } = await group();
    const proposed = routineProposeTool(
      services,
      session.conversationId,
      { botId: alice, chatId },
      { title: '日报', prompt: '写日报', schedule: 'daily 09:00' }
    ) as { id: string };
    const target = { botId: alice, id: proposed.id };
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_REVIEW, { ...target, approve: 'yes' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUNS, { botId: '../x', id: proposed.id })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUN_NOW, target)).toEqual({
      ok: false,
      error: 'not-approved',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUN_NOW, { ...target, dryRun: 1 })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUN_NOW, { ...target, dryRun: true })).toEqual({
      ok: true,
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUNS, target)).toMatchObject({
      ok: true,
      runs: [{ trigger: 'dry-run', executorId: alice, chatId }],
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUN_NOW, { ...target, dryRun: true })).toEqual({
      ok: false,
      error: 'busy',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_REVIEW, { ...target, approve: true })).toMatchObject(
      { ok: true, routine: { status: 'enabled', approvedVersion: 1 } }
    );
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_REVIEW, { ...target, approve: true })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_DELETE, target)).toEqual({ ok: true });
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_RUNS, target)).toEqual({ ok: true, runs: [] });
  });

  it('保存时执行成员不在目标聊天里拒绝；成员离群后依赖检查自动阻塞', async () => {
    const { alice, bob, carol, chatId, services } = await group();
    const draft = { botId: alice, chatId, title: 't', prompt: 'p', schedule: '0 9 * * *' };
    expect(await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, { ...draft, doneBy: carol })).toEqual({
      ok: false,
      error: 'invalid',
    });
    const saved = await call(IPC_CHANNELS.BOT_ROUTINE_SAVE, { ...draft, doneBy: bob });
    expect(saved).toMatchObject({ ok: true, routine: { status: 'enabled', doneBy: bob } });
    const id = (saved.routine as { id: string }).id;
    expect(
      services.chats.update(chatId, (chat) => ({ ...chat, members: [alice, carol] }))
    ).toBeTruthy();
    expect(services.scheduler.verify(alice, id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'not-in-chat',
    });
  });
});

describe('聊天管理', () => {
  it('搁置会取消置顶，稍后提醒隐含搁置，置顶顺序只在置顶时保留；人类发言取消搁置', async () => {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const update = async (patch: Record<string, unknown>) =>
      (await call(IPC_CHANNELS.BOT_CHAT_UPDATE, { chatId, ...patch })).chat as Record<
        string,
        unknown
      >;
    expect(await update({ pinned: true, pinOrder: 2 })).toMatchObject({
      pinned: true,
      pinOrder: 2,
    });
    const settled = await update({ settled: true });
    expect(settled).toMatchObject({ pinned: false });
    expect(settled.settledAt).toEqual(expect.any(Number));
    expect(settled.pinOrder).toBeUndefined();
    const until = Date.now() + 3_600_000;
    expect(await update({ settled: false, snoozedUntil: until })).toMatchObject({
      snoozedUntil: until,
      settledAt: expect.any(Number),
    });
    expect(await call(IPC_CHANNELS.BOT_CHAT_UPDATE, { chatId, snoozedUntil: -5 })).toEqual({
      ok: false,
      error: 'invalid',
    });
    await call(IPC_CHANNELS.BOT_SEND, { chatId, text: 'back', deliveryId: 'w1' });
    const list = await call(IPC_CHANNELS.BOT_CHATS_LIST);
    const chat = (list.chats as Record<string, unknown>[]).find((item) => item.id === chatId);
    expect(chat?.settledAt).toBeUndefined();
    expect(chat?.snoozedUntil).toBeUndefined();
  });
});

describe('收件箱 IPC', () => {
  it('列表与忽略入参收窄；审批随 worker 事件出现与结束；开关关闭返回空列表', async () => {
    const { setBotWorkerEventObserver } = await import('./agent');
    const observe = vi.mocked(setBotWorkerEventObserver).mock.calls.at(-1)?.[0];
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const sent = await call(IPC_CHANNELS.BOT_SEND, { chatId, text: 'hi', deliveryId: 'i1' });
    const identity = { sessionId: sent.conversationId as string, generation: 'g' };
    observe?.({
      type: 'approval-request',
      seq: 1,
      identity,
      request: { requestId: 'r1', tool: 'bash', kind: 'exec', summary: 'rm -rf x' },
    } as never);
    const listed = await call(IPC_CHANNELS.BOT_INBOX_LIST);
    expect(listed.items).toEqual([
      expect.objectContaining({ key: `approval:${identity.sessionId}:r1`, chatId, botId: alice }),
    ]);
    expect(
      await call(IPC_CHANNELS.BOT_INBOX_UPDATE, {
        key: `approval:${identity.sessionId}:r1`,
        action: 'dismiss',
      })
    ).toEqual({ ok: false, error: 'not-dismissible' });
    expect(await call(IPC_CHANNELS.BOT_INBOX_UPDATE, { key: 'k', action: 'drop' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    observe?.({ type: 'approval-resolved', seq: 2, identity, requestId: 'r1' } as never);
    expect((await call(IPC_CHANNELS.BOT_INBOX_LIST)).items).toEqual([]);
    mocks.settings.botModeEnabled = false;
    expect(await call(IPC_CHANNELS.BOT_INBOX_LIST)).toEqual({ ok: true, items: [] });
  });
});

describe('群聊新对话与克隆', () => {
  async function team() {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const carol = await createBot('Carol');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob, carol],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    return { alice, bob, carol, chatId: (created.chat as { id: string }).id };
  }

  async function phone() {
    const { registerPairBotHandlers } = await import('./pairBots');
    registerPairBotHandlers();
    return async (chatId: string, requestId: string, confirmed?: boolean, peer = 'peer') => {
      const frames: HostToPhone[] = [];
      await mocks.pairPort!.handle(
        peer,
        {
          type: 'bot-new-session',
          chatId,
          requestId,
          ...(confirmed === undefined ? {} : { confirmed }),
        },
        async (frame) => {
          frames.push(frame);
          return true;
        }
      );
      return frames;
    };
  }

  it('phone direct reset shares desktop lifecycle, deduplicates requests and refreshes chat sessions', async () => {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    const old = services.host.ensureSession(chatId, alice);
    if (!old.ok) throw new Error(old.error);
    const distill = vi.spyOn(services.memory, 'distill').mockResolvedValue(undefined);
    const send = await phone();
    const first = await send(chatId, 'request');
    expect(first).toContainEqual({
      type: 'bot-new-session-result',
      chatId,
      requestId: 'request',
      ok: true,
    });
    const current = services.chats.get(chatId)!.sessions[alice].conversationId;
    expect(current).not.toBe(old.conversationId);
    expect(
      (mocks.registry as SourceAuthorityRegistry).conversation(old.conversationId)?.lifecycle
    ).toBe('ended');
    expect(first).toContainEqual(
      expect.objectContaining({
        type: 'bot-chats',
        chats: [
          expect.objectContaining({
            id: chatId,
            sessions: { [alice]: { conversationId: current } },
          }),
        ],
      })
    );
    await send(chatId, 'request');
    expect(services.chats.get(chatId)!.sessions[alice].conversationId).toBe(current);
    expect(distill).toHaveBeenCalledTimes(1);
    await send(chatId, 'request', undefined, 'other-peer');
    expect(services.chats.get(chatId)!.sessions[alice].conversationId).not.toBe(current);
    expect(distill).toHaveBeenCalledTimes(2);
  });

  it.each([
    'current',
    'queue',
    'pendingHuman',
    'routing',
    'host',
    'hostQueue',
    'delegation',
  ] as const)(
    'phone busy group (%s) only resets after confirmation with a new request ID',
    async (source) => {
      const { alice, chatId } = await team();
      const { getBotServices } = await import('./bots');
      const services = getBotServices()!;
      services.chats.appendEntry(chatId, {
        kind: 'human',
        text: 'old',
        mentions: [],
        id: 'old',
        at: 1,
      });
      const session = services.host.ensureSession(chatId, alice);
      if (!session.ok) throw new Error(session.error);
      const before = services.chats.get(chatId);
      const state = services.groups.state(chatId);
      if (!state.ok) throw new Error(state.error);
      const busy =
        source === 'host'
          ? vi.spyOn(services.host, 'isBusy').mockReturnValue(true)
          : source === 'hostQueue'
            ? vi
                .spyOn(services.host, 'queueState')
                .mockReturnValue([
                  { chatId, botId: alice, conversationId: session.conversationId, position: 0 },
                ])
            : source === 'delegation'
              ? vi
                  .spyOn(services.delegations, 'list')
                  .mockReturnValue([{ state: 'running' } as never])
              : vi.spyOn(services.groups, 'state').mockReturnValue({
                  ...state,
                  [source]: source === 'current' ? alice : source === 'queue' ? [alice] : true,
                });
      const stop = vi.spyOn(services.groups, 'stop');
      const send = await phone();
      expect(await send(chatId, 'A')).toEqual([
        {
          type: 'bot-new-session-result',
          chatId,
          requestId: 'A',
          ok: false,
          needsConfirmation: true,
        },
      ]);
      expect(services.chats.get(chatId)).toEqual(before);
      expect(services.chats.lastSeq(chatId)).toBe(1);
      expect(stop).not.toHaveBeenCalled();
      expect(await send(chatId, 'A')).toEqual([
        {
          type: 'bot-new-session-result',
          chatId,
          requestId: 'A',
          ok: false,
          needsConfirmation: true,
        },
      ]);
      expect(await send(chatId, 'A', true)).toEqual([
        {
          type: 'bot-new-session-result',
          chatId,
          requestId: 'A',
          ok: false,
          error: 'invalid-request',
        },
      ]);
      expect(stop).not.toHaveBeenCalled();
      const frames = await send(chatId, 'B', true);
      busy.mockRestore();
      expect(frames).toContainEqual({
        type: 'bot-new-session-result',
        chatId,
        requestId: 'B',
        ok: true,
      });
      expect(services.chats.get(chatId)).toMatchObject({ sessions: {}, epochSeq: 2 });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(frames).toContainEqual(
        expect.objectContaining({ type: 'group-timeline', epochSeq: 2 })
      );
    }
  );

  it('phone concurrent reset frames share a result while other requests and desktop resets are busy', async () => {
    const { chatId } = await team();
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    services.chats.appendEntry(chatId, {
      kind: 'human',
      text: 'old',
      mentions: [],
      id: 'old',
      at: 1,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = services.groups.stop.bind(services.groups);
    const stop = vi.spyOn(services.groups, 'stop').mockImplementation(async (id) => {
      await gate;
      return original(id);
    });
    const send = await phone();
    const one = send(chatId, 'same', true);
    const duplicate = send(chatId, 'same', true);
    expect(await send(chatId, 'other', true)).toContainEqual({
      type: 'bot-new-session-result',
      chatId,
      requestId: 'other',
      ok: false,
      error: 'session-busy',
    });
    expect(await call(IPC_CHANNELS.BOT_CHAT_NEW_SESSION, { chatId })).toMatchObject({
      ok: false,
      error: 'session-busy',
    });
    release();
    const [a, b] = await Promise.all([one, duplicate]);
    expect(a[0]).toEqual(b[0]);
    expect(a[0]).toMatchObject({ ok: true });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(services.chats.lastSeq(chatId)).toBe(2);
    await send(chatId, 'empty');
    expect(services.chats.lastSeq(chatId)).toBe(2);
  });

  it('phone advertises support and returns correlated errors for missing/disabled chats and exceptions', async () => {
    const { chatId } = await team();
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    const send = await phone();
    const frames: HostToPhone[] = [];
    await mocks.pairPort!.handle('peer', { type: 'bot-catalog-request' }, async (frame) => {
      frames.push(frame);
      return true;
    });
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'bot-catalog', newSession: true })
    );
    expect(await send('missing', 'invalid')).toContainEqual(
      expect.objectContaining({ requestId: 'invalid', ok: false, error: expect.any(String) })
    );
    services.chats.appendEntry(chatId, {
      kind: 'human',
      text: 'old',
      mentions: [],
      id: 'old',
      at: 1,
    });
    const stop = vi.spyOn(services.groups, 'stop').mockRejectedValueOnce(new Error('private path'));
    expect(await send(chatId, 'fail')).toEqual([
      { type: 'bot-new-session-result', chatId, requestId: 'fail', ok: false, error: 'failed' },
    ]);
    expect(await send(chatId, 'next')).toContainEqual(
      expect.objectContaining({ requestId: 'next', ok: true })
    );
    expect(stop).toHaveBeenCalledTimes(2);
    mocks.settings.botModeEnabled = false;
    expect(await send(chatId, 'disabled')).toEqual([
      {
        type: 'bot-new-session-result',
        chatId,
        requestId: 'disabled',
        ok: false,
        error: 'disabled',
      },
    ]);
  });

  it('新对话：停掉成员、取消委派、结束旧会话并写分隔线；之后的上下文与 group_history 从分隔线开始', async () => {
    const { alice, bob, chatId } = await team();
    const { getBotServices, groupHistoryTool } = await import('./bots');
    const services = getBotServices()!;
    const registry = mocks.registry as SourceAuthorityRegistry;
    services.chats.appendEntry(chatId, {
      kind: 'human',
      text: '旧约定：周五发布',
      mentions: [],
      id: 'h-old',
      at: 1,
    });
    const old = services.host.ensureSession(chatId, bob);
    if (!old.ok) throw new Error(old.error);
    const stopTurn = vi.spyOn(services.host, 'stopTurn');
    const startOver = vi.spyOn(services.delegations, 'startOver');

    expect(await call(IPC_CHANNELS.BOT_CHAT_NEW_SESSION, { chatId })).toEqual({
      ok: true,
      epochSeq: 2,
    });
    expect(stopTurn).toHaveBeenCalledWith(chatId, bob);
    expect(startOver).toHaveBeenCalledWith(chatId);
    expect(registry.conversation(old.conversationId)?.lifecycle).toBe('ended');
    expect(services.chats.get(chatId)).toMatchObject({ epochSeq: 2, sessions: {} });
    expect(services.chats.readEntries(chatId).at(-1)).toMatchObject({
      seq: 2,
      kind: 'system',
      newConversation: true,
    });
    // 当前段为空：不再写分隔线
    expect(await call(IPC_CHANNELS.BOT_CHAT_NEW_SESSION, { chatId })).toEqual({
      ok: true,
      epochSeq: 2,
    });
    expect(services.chats.lastSeq(chatId)).toBe(2);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.promptSession.mockClear();
    await call(IPC_CHANNELS.BOT_SEND, { chatId, text: '新任务：写周报', deliveryId: 'd-new' });
    await waitFor(() => expect(mocks.promptSession).toHaveBeenCalled());
    warn.mockRestore();
    const prompt = mocks.promptSession.mock.calls[0][1] as string;
    expect(prompt).toContain('新任务：写周报');
    expect(prompt).not.toContain('旧约定');
    const session = services.chats.get(chatId)!.sessions[alice];
    const history = groupHistoryTool(
      services,
      session.conversationId,
      { botId: alice, chatId },
      { limit: 20 }
    );
    expect(history).toMatchObject({ ok: true });
    expect(JSON.stringify(history)).toContain('新任务');
    expect(JSON.stringify(history)).not.toContain('旧约定');

    expect(await call(IPC_CHANNELS.BOT_CHAT_NEW_SESSION, { chatId: 'nope' })).toMatchObject({
      ok: false,
    });
  });

  it('克隆：复制成员、群主与分派；独立目录的新建空目录，绑项目的沿用同一项目；不带记录与会话', async () => {
    const { alice, bob, carol, chatId } = await team();
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    const registry = mocks.registry as SourceAuthorityRegistry;
    await call(IPC_CHANNELS.BOT_CHAT_UPDATE, {
      chatId,
      pinned: true,
      routing: { mode: 'boss', maxHops: 3, maxTurnsPerBot: 1, muted: [carol] },
    });
    services.chats.appendEntry(chatId, { kind: 'system', text: 'x', id: 's1', at: 1 });
    writeFileSync(join(services.chats.workspaceDir(chatId), 'a.txt'), 'x');
    const session = services.host.ensureSession(chatId, bob);
    if (!session.ok) throw new Error(session.error);
    await call(IPC_CHANNELS.BOT_CHAT_NEW_SESSION, { chatId });
    const source = services.chats.get(chatId)!;

    const cloned = await call(IPC_CHANNELS.BOT_CHAT_CLONE, { chatId, title: 'team 的副本' });
    expect(cloned).toMatchObject({
      ok: true,
      chat: {
        kind: 'group',
        title: 'team 的副本',
        members: [alice, bob, carol],
        bossBotId: alice,
        routing: { mode: 'boss', maxHops: 3, maxTurnsPerBot: 1, muted: [carol] },
        pinned: false,
        sessions: {},
        workspace: { kind: 'chat-home' },
      },
    });
    const copy = cloned.chat as { id: string; epochSeq?: number; workspace: { projectId: string } };
    expect(copy.id).not.toBe(chatId);
    expect(copy.epochSeq).toBeUndefined();
    expect(copy.workspace.projectId).not.toBe(
      (source.workspace as { projectId: string }).projectId
    );
    expect(existsSync(join(services.chats.workspaceDir(copy.id), 'a.txt'))).toBe(false);
    expect(services.chats.lastSeq(copy.id)).toBe(0);
    expect(services.chats.get(chatId)?.sessions[bob]).toBeUndefined();

    const code = join(mocks.root, 'code');
    mkdirSync(code);
    const project = registry.createProject({ requestId: 'p', path: code });
    if (!project.accepted) throw new Error('project');
    await call(IPC_CHANNELS.BOT_CHAT_UPDATE, {
      chatId,
      workspace: { kind: 'project', projectId: project.value.projectId },
    });
    expect(await call(IPC_CHANNELS.BOT_CHAT_CLONE, { chatId, title: 'p' })).toMatchObject({
      ok: true,
      chat: { workspace: { kind: 'project', projectId: project.value.projectId } },
    });

    const direct = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    for (const bad of [
      { chatId: (direct.chat as { id: string }).id, title: 'x' },
      { chatId: '77777777-7777-4777-8777-777777777777', title: 'x' },
      { chatId, title: '' },
    ])
      expect(await call(IPC_CHANNELS.BOT_CHAT_CLONE, bad)).toMatchObject({ ok: false });

    expect(await call(IPC_CHANNELS.BOT_CHAT_DELETE, { chatId })).toEqual({ ok: true });
    expect(services.chats.get(copy.id)).toBeDefined();
    expect(existsSync(services.chats.workspaceDir(copy.id))).toBe(true);
  });
});

describe('群话题', () => {
  async function team() {
    const alice = await createBot('Alice');
    const bob = await createBot('Bob');
    const carol = await createBot('Carol');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'team',
      members: [alice, bob, carol],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    return { alice, bob, carol, chatId, services };
  }

  it('话题成员会话用根群目录与群笔记；话题不能单独改配置或删除', async () => {
    const { bob, chatId, services } = await team();
    const empty = await call(IPC_CHANNELS.BOT_NOTES_GET, { chatId });
    const version = (empty.notes as { version: string }).version;
    await call(IPC_CHANNELS.BOT_NOTES_SAVE, { chatId, content: '- ship friday', version });
    const thread = services.chats.createThread(chatId)!;
    expect(await call(IPC_CHANNELS.BOT_NOTES_GET, { chatId: thread.id })).toMatchObject({
      ok: false,
    });

    await services.host.deliver(thread.id, bob, 'hello');
    await waitFor(() => expect(mocks.spawnSession).toHaveBeenCalled());
    const [, request, , , , options] = mocks.spawnSession.mock.calls[0] as [
      unknown,
      { cwd: string },
      unknown,
      unknown,
      string,
      { bot: { systemPrompt: string } },
    ];
    expect(request.cwd).toBe(services.chats.workspaceDir(chatId));
    expect(options.bot.systemPrompt).toContain('<group-notes>\n- ship friday\n</group-notes>');

    expect(await call(IPC_CHANNELS.BOT_CHAT_UPDATE, { chatId: thread.id, title: 'x' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await call(IPC_CHANNELS.BOT_CHAT_DELETE, { chatId: thread.id })).toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it('压缩后的话题成员获得根群看板；群主删除提示只列根群一次', async () => {
    const { alice, bob, chatId, services } = await team();
    const thread = services.chats.createThread(chatId)!;
    expect
      .soft(services.host.discardBot(alice))
      .toMatchObject({ reason: 'boss', chatIds: [chatId] });
    services.tasks.add(chatId, 'human', { title: 'Shared pending task' });
    const review = services.tasks.add(chatId, 'human', { title: 'Delivered awaiting review' });
    if (!review.ok) throw new Error(review.error);
    const record = {
      id: '77777777-7777-4777-8777-777777777777',
      parentConversationId: 'p',
      parentBotId: bob,
      targetBotId: alice,
      chatId,
      task: 't',
      context: '',
      childConversationId: 'c',
      state: 'running' as const,
      depth: 1,
      createdAt: 1,
      taskId: review.task.id,
    };
    services.tasks.sync(record);
    services.tasks.sync({ ...record, state: 'completed', result: 'ok' });
    expect(services.tasks.list(chatId)[1]).toMatchObject({ status: 'review' });
    const session = services.host.ensureSession(thread.id, bob);
    if (!session.ok) throw new Error(session.error);
    services.groups.markCompacted(thread.id, bob, session.conversationId);
    expect(
      await call(IPC_CHANNELS.BOT_SEND, {
        chatId: thread.id,
        text: '@Bob hello',
        deliveryId: 'state',
      })
    ).toMatchObject({ ok: true });
    await waitFor(() => expect(mocks.promptSession).toHaveBeenCalled());
    const prompts = mocks.promptSession.mock.calls.map((args) => String(args[1])).join('\n');
    expect(prompts).toContain('<group-state>');
    expect(prompts).toContain('Shared pending task');
    expect(prompts).toContain('#2 Delivered awaiting review（待验收');
  });

  it('话题 IPC：新建并切换、空话题复用、首条消息定标题、改名、切换校验、删除回到根群', async () => {
    const { alice, bob, chatId, services } = await team();
    for (const bad of [undefined, { chatId: 'x' }, { chatId, extra: 1 }])
      expect(await call(IPC_CHANNELS.BOT_THREAD_CREATE, bad)).toEqual({
        ok: false,
        error: 'invalid',
      });
    const created = await call(IPC_CHANNELS.BOT_THREAD_CREATE, { chatId });
    const thread = created.chat as { id: string; parentId: string };
    expect(thread.parentId).toBe(chatId);
    expect(services.chats.get(chatId)?.activeThreadId).toBe(thread.id);
    expect(await call(IPC_CHANNELS.BOT_THREAD_CREATE, { chatId: thread.id })).toMatchObject({
      ok: false,
    });
    // 当前话题还是空的：不重复建
    expect(await call(IPC_CHANNELS.BOT_THREAD_CREATE, { chatId })).toMatchObject({
      ok: true,
      chat: { id: thread.id },
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      await call(IPC_CHANNELS.BOT_SEND, {
        chatId: thread.id,
        text: '  发布清单\n细节',
        deliveryId: 't1',
      })
    ).toMatchObject({ ok: true });
    warn.mockRestore();
    expect(services.chats.get(thread.id)?.threadTitle).toBe('发布清单');
    expect(services.chats.readEntries(chatId)).toEqual([]);

    expect(
      await call(IPC_CHANNELS.BOT_THREAD_UPDATE, { chatId: thread.id, title: '  上线  ' })
    ).toMatchObject({ ok: true, chat: { threadTitle: '上线' } });
    expect(
      await call(IPC_CHANNELS.BOT_THREAD_UPDATE, { chatId: thread.id, title: ' ' })
    ).toMatchObject({ ok: false });

    const second = (await call(IPC_CHANNELS.BOT_THREAD_CREATE, { chatId })).chat as { id: string };
    expect(second.id).not.toBe(thread.id);
    expect(await call(IPC_CHANNELS.BOT_THREAD_SELECT, { chatId, threadId: thread.id })).toEqual({
      ok: true,
    });
    expect(services.chats.get(chatId)?.activeThreadId).toBe(thread.id);
    expect(await call(IPC_CHANNELS.BOT_THREAD_SELECT, { chatId, threadId: chatId })).toEqual({
      ok: true,
    });
    expect(services.chats.get(chatId)).not.toHaveProperty('activeThreadId');
    const other = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'other',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    expect(
      await call(IPC_CHANNELS.BOT_THREAD_SELECT, {
        chatId,
        threadId: (other.chat as { id: string }).id,
      })
    ).toMatchObject({ ok: false });

    await call(IPC_CHANNELS.BOT_THREAD_SELECT, { chatId, threadId: second.id });
    expect(await call(IPC_CHANNELS.BOT_THREAD_DELETE, { chatId })).toMatchObject({ ok: false });
    expect(await call(IPC_CHANNELS.BOT_THREAD_DELETE, { chatId: second.id })).toEqual({ ok: true });
    expect(services.chats.get(second.id)).toBeUndefined();
    expect(services.chats.get(chatId)).not.toHaveProperty('activeThreadId');
    expect(services.chats.threadsOf(chatId).map((chat) => chat.id)).toEqual([chatId, thread.id]);
  });

  it('单独删除话题时清理该话题的粘贴文件，根群与其它话题的保留', async () => {
    const { chatId, services } = await team();
    const thread = services.chats.createThread(chatId)!;
    const other = services.chats.createThread(chatId)!;
    const text = 'x'.repeat(50_000);
    const save = async (id: string) =>
      (await call(IPC_CHANNELS.BOT_CHAT_SAVE_PASTED_TEXT, { chatId: id, text })) as {
        ok: true;
        path: string;
      };
    const [rootFile, threadFile, otherFile] = await Promise.all(
      [chatId, thread.id, other.id].map(save)
    );
    for (const file of [rootFile, threadFile, otherFile]) expect(existsSync(file.path)).toBe(true);

    expect(await call(IPC_CHANNELS.BOT_THREAD_DELETE, { chatId: thread.id })).toEqual({ ok: true });
    expect(existsSync(threadFile.path)).toBe(false);
    expect(existsSync(rootFile.path)).toBe(true);
    expect(existsSync(otherFile.path)).toBe(true);
  });

  it('手机话题：目录声明支持并下发子话题；新建 / 切换复用桌面逻辑、按请求回执', async () => {
    const { alice, bob, chatId, services } = await team();
    const { registerPairBotHandlers } = await import('./pairBots');
    registerPairBotHandlers();
    const run = async (command: Parameters<PairBotPort['handle']>[1]) => {
      const frames: HostToPhone[] = [];
      await mocks.pairPort!.handle('peer', command, async (frame) => {
        frames.push(frame);
        return true;
      });
      return frames;
    };
    const result = (requestId: string, patch: Record<string, unknown>) => ({
      type: 'bot-thread-result',
      chatId,
      requestId,
      ...patch,
    });

    expect(await run({ type: 'bot-catalog-request' })).toContainEqual(
      expect.objectContaining({ type: 'bot-catalog', threads: true })
    );
    const created = await run({ type: 'bot-thread-create', chatId, requestId: 'c1' });
    const threadId = services.chats.get(chatId)?.activeThreadId as string;
    expect(threadId).toEqual(expect.any(String));
    expect(created).toContainEqual(result('c1', { ok: true, threadId }));
    expect(created).toContainEqual(
      expect.objectContaining({
        type: 'bot-chats',
        chats: [expect.objectContaining({ id: chatId, activeThreadId: threadId })],
        threads: [expect.objectContaining({ id: threadId, parentId: chatId, kind: 'group' })],
      })
    );
    // 当前话题仍为空：与桌面一样复用，不堆空话题
    expect(await run({ type: 'bot-thread-create', chatId, requestId: 'c2' })).toContainEqual(
      result('c2', { ok: true, threadId })
    );
    expect(services.chats.threadsOf(chatId)).toHaveLength(2);

    expect(
      await run({ type: 'bot-thread-select', chatId, threadId: chatId, requestId: 's1' })
    ).toContainEqual(result('s1', { ok: true, threadId: chatId }));
    expect(services.chats.get(chatId)).not.toHaveProperty('activeThreadId');
    expect(
      await run({ type: 'bot-thread-select', chatId, threadId, requestId: 's2' })
    ).toContainEqual(result('s2', { ok: true, threadId }));
    expect(services.chats.get(chatId)?.activeThreadId).toBe(threadId);

    const other = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'other',
      members: [alice, bob],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const otherId = (other.chat as { id: string }).id;
    expect(
      await run({ type: 'bot-thread-select', chatId, threadId: otherId, requestId: 'bad' })
    ).toEqual([result('bad', { ok: false, error: 'invalid' })]);
    expect(await run({ type: 'bot-thread-create', chatId: threadId, requestId: 'nested' })).toEqual(
      [
        {
          type: 'bot-thread-result',
          chatId: threadId,
          requestId: 'nested',
          ok: false,
          error: 'invalid',
        },
      ]
    );
    expect(services.chats.get(chatId)?.activeThreadId).toBe(threadId);

    mocks.settings.botModeEnabled = false;
    expect(await run({ type: 'bot-thread-create', chatId, requestId: 'off' })).toEqual([
      result('off', { ok: false, error: 'disabled' }),
    ]);
    mocks.settings.botModeEnabled = true;
  });

  it('话题 AI 命名：开关开时占位标题被替换；主话题只写 threadTitle；手动改名后锁定', async () => {
    const { TITLE_SYSTEM_PROMPT } = await import('../../agent/titleSummary');
    mocks.settings.titleSummaryEnabled = true;
    mocks.completeText.mockImplementation(async (...args: unknown[]) => {
      const { systemPrompt, userText } = args[0] as { systemPrompt: string; userText: string };
      if (systemPrompt !== TITLE_SYSTEM_PROMPT) return 'OK';
      return userText.includes('发布清单') ? '发布清单梳理' : '季度路线图';
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { chatId, services } = await team();
      const thread = (await call(IPC_CHANNELS.BOT_THREAD_CREATE, { chatId })).chat as {
        id: string;
      };
      expect(services.chats.get(thread.id)?.autoTitle).toEqual({ seq: 0 });
      expect(
        await call(IPC_CHANNELS.BOT_SEND, {
          chatId: thread.id,
          text: '帮忙看下发布清单\n细节',
          deliveryId: 'a1',
        })
      ).toMatchObject({ ok: true });
      await waitFor(() => expect(services.chats.get(thread.id)?.threadTitle).toBe('发布清单梳理'));

      expect(
        await call(IPC_CHANNELS.BOT_THREAD_UPDATE, { chatId: thread.id, title: '我的标题' })
      ).toMatchObject({ ok: true, chat: { threadTitle: '我的标题' } });
      expect(services.chats.get(thread.id)).not.toHaveProperty('autoTitle');

      expect(
        await call(IPC_CHANNELS.BOT_SEND, { chatId, text: '讨论季度路线图', deliveryId: 'a2' })
      ).toMatchObject({ ok: true });
      await waitFor(() =>
        expect(services.chats.get(chatId)).toMatchObject({
          title: 'team',
          threadTitle: '季度路线图',
        })
      );
    } finally {
      warn.mockRestore();
      mocks.completeText.mockImplementation(async () => 'OK');
    }
  });

  it('根群移出成员：各话题里该成员的会话结束；删根群连同话题一起删', async () => {
    const { carol, chatId, services, alice, bob } = await team();
    const registry = mocks.registry as SourceAuthorityRegistry;
    const thread = services.chats.createThread(chatId)!;
    const session = services.host.ensureSession(thread.id, carol);
    if (!session.ok) throw new Error(session.error);
    expect(
      await call(IPC_CHANNELS.BOT_CHAT_UPDATE, { chatId, members: [alice, bob] })
    ).toMatchObject({ ok: true });
    expect(services.chats.get(thread.id)).toMatchObject({ members: [alice, bob], sessions: {} });
    expect(registry.conversation(session.conversationId)?.lifecycle).toBe('ended');

    expect(await call(IPC_CHANNELS.BOT_CHAT_DELETE, { chatId })).toEqual({ ok: true });
    expect(services.chats.get(thread.id)).toBeUndefined();
    expect(existsSync(join(mocks.root, 'bot-chats', thread.id))).toBe(false);
  });
});

describe('私聊切换对话', () => {
  it('列出对话带标题与时间；切回旧对话先停当前回合并提炼记忆，再续用原会话', async () => {
    const alice = await createBot('Alice');
    const created = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'direct',
      members: [alice],
      workspace: { kind: 'member-home' },
    });
    const chatId = (created.chat as { id: string }).id;
    const { getBotServices } = await import('./bots');
    const services = getBotServices()!;
    const registry = mocks.registry as SourceAuthorityRegistry;
    const old = services.host.ensureSession(chatId, alice);
    if (!old.ok) throw new Error(old.error);
    const dir = join(mocks.root, 'agent', 'sessions');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'old.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({ type: 'message', id: 'u', message: { role: 'user', content: '整理发布清单' } })}\n`
    );
    registry.markReady(old.conversationId, file, { providerId: 'p', modelId: 'm' });
    const fresh = services.host.ensureSession(chatId, alice, { fresh: true });
    if (!fresh.ok) throw new Error(fresh.error);

    const listed = await call(IPC_CHANNELS.BOT_CHAT_SESSIONS, { chatId });
    expect(listed).toMatchObject({
      ok: true,
      sessions: [
        {
          conversationId: old.conversationId,
          current: false,
          resumable: true,
          title: '整理发布清单',
        },
        { conversationId: fresh.conversationId, current: true, resumable: true },
      ],
    });
    expect((listed.sessions as { activityAt?: number }[])[0].activityAt).toBeGreaterThan(0);

    const stop = vi.spyOn(services.host, 'stopTurn');
    const distill = vi.spyOn(services.memory, 'distill').mockResolvedValue(undefined);
    for (const bad of [
      { chatId, conversationId: 'x' },
      { chatId, conversationId: '77777777-7777-4777-8777-777777777777' },
      { chatId },
    ])
      expect(await call(IPC_CHANNELS.BOT_CHAT_SWITCH_SESSION, bad)).toMatchObject({ ok: false });
    expect(stop).not.toHaveBeenCalled();

    expect(
      await call(IPC_CHANNELS.BOT_CHAT_SWITCH_SESSION, {
        chatId,
        conversationId: old.conversationId,
      })
    ).toEqual({ ok: true });
    expect(stop).toHaveBeenCalledWith(chatId, alice);
    expect(distill).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: fresh.conversationId })
    );
    expect(services.chats.get(chatId)?.sessions[alice].conversationId).toBe(old.conversationId);
    expect(registry.conversation(old.conversationId)?.lifecycle).toBe('ready');
    expect(registry.conversation(fresh.conversationId)?.lifecycle).toBe('ended');

    const group = await call(IPC_CHANNELS.BOT_CHAT_CREATE, {
      kind: 'group',
      title: 'g',
      members: [alice, await createBot('Bob')],
      bossBotId: alice,
      workspace: { kind: 'chat-home' },
    });
    const groupId = (group.chat as { id: string }).id;
    const member = services.host.ensureSession(groupId, alice);
    if (!member.ok) throw new Error(member.error);
    expect(
      await call(IPC_CHANNELS.BOT_CHAT_SWITCH_SESSION, {
        chatId: groupId,
        conversationId: member.conversationId,
      })
    ).toMatchObject({ ok: false });
  });
});

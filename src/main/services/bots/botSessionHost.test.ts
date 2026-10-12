import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import type { BotChat, BotEngine, BotProfile } from '../../../shared/types/bot';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import {
  type BotRuntimePort,
  BotSessionHost,
  type BotSessionHostDeps,
  type BotSpawnSpec,
  type BotTurnFinished,
} from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';

let root: string;
let registry: SourceAuthorityRegistry;
let bots: BotStore;
let chats: BotChatStore;
let runtime: FakeRuntime;
let events: Array<{ kind: string; chatId?: string }>;
let host: BotSessionHost;
let probeResult:
  | { ok: true; model?: BotEngine; fallback?: { model: BotEngine; label: string; reason: string } }
  | { ok: false; error: string };
let probeCalls: BotProfile[] = [];
let invalidated: Array<BotEngine | undefined> = [];

class FakeRuntime implements BotRuntimePort {
  engines: Array<{ id: string; engine?: BotEngine }> = [];
  modelResult = { ok: true } as { ok: boolean; error?: string };
  async updateEngine(id: string, engine?: BotEngine) {
    if (this.modelResult.ok) this.engines.push({ id, engine });
    return this.modelResult;
  }
  spawns: BotSpawnSpec[] = [];
  prompts: Array<{ id: string; text: string; resume?: true }> = [];
  steers: Array<{ id: string; text: string }> = [];
  released: string[] = [];
  aborted: string[] = [];
  removedFiles: string[] = [];
  spawnResult = { ok: true } as { ok: boolean; error?: string };
  /** 设置后 release 像真实 agentHost 一样：worker 里还在的实例先回放 parent-ended，再返回 */
  observer?: (event: AgentWorkerEvent) => void;
  /** worker 里还在的实例：会话 → 实例号 */
  private readonly alive = new Map<string, string | undefined>();
  async spawn(spec: BotSpawnSpec) {
    this.spawns.push(spec);
    if (this.spawnResult.ok) this.alive.set(spec.conversationId, spec.instanceId);
    return this.spawnResult;
  }
  /** 会话第 nth 次 spawn 的实例号（缺省最近一次） */
  instanceOf(id: string, nth = -1): string | undefined {
    return this.spawns.filter((spec) => spec.conversationId === id).at(nth)?.instanceId;
  }
  prompt(id: string, text: string, _images?: unknown, _deliveryId?: string, resume?: true) {
    this.prompts.push({ id, text, ...(resume ? { resume } : {}) });
    return { ok: true };
  }
  steer(id: string, text: string) {
    this.steers.push({ id, text });
    return { ok: true };
  }
  async release(id: string) {
    this.released.push(id);
    if (!this.observer || !this.alive.has(id)) return;
    const instanceId = this.alive.get(id);
    this.alive.delete(id);
    this.observer(ev({ type: 'parent-ended', reason: 'released', instanceId }, id));
  }
  abort(id: string) {
    this.aborted.push(id);
  }
  removeSessionFiles(conversation: { conversationId: string }) {
    this.removedFiles.push(conversation.conversationId);
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-host-')));
  registry = new SourceAuthorityRegistry({ registryFile: join(root, 'registry.json') });
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'bot-chats'));
  runtime = new FakeRuntime();
  events = [];
  probeResult = { ok: true };
  probeCalls = [];
  invalidated = [];
  host = new BotSessionHost({
    bots,
    chats,
    authority: registry,
    runtime,
    emit: (event) => events.push(event),
    probe: async (botProfile) => {
      probeCalls.push(botProfile);
      return probeResult;
    },
    invalidateProbe: (botProfile) => invalidated.push(botProfile.engine),
  });
  // 默认像真实 agentHost：release 等 worker 回 parent-ended 才返回
  runtime.observer = (event) => host.observe(event);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bot(name: string, persona = '') {
  const result = bots.create({ name, title: 'Dev', scope: `${name} scope`, persona }, []);
  if (!result.ok) throw new Error(result.reason);
  return result.bot;
}

function direct(botId: string, workspace: BotChat['workspace'] = { kind: 'member-home' }) {
  const chat = chats.create({
    kind: 'direct',
    title: '',
    members: [botId],
    bossBotId: null,
    workspace,
  });
  if (!chat) throw new Error('chat');
  return chat;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function ev(event: Record<string, unknown>, sessionId: string): AgentWorkerEvent {
  return { seq: 1, identity: { sessionId, generation: 'g' }, ...event } as AgentWorkerEvent;
}

describe('BotSessionHost live capacity', () => {
  it('starts queued turns on increase but keeps the same conversation serial', async () => {
    host.setMaxRunningTurns(1);
    const alice = bot('Alice');
    const one = direct(alice.id);
    const bob = bot('Bob');
    const two = direct(bob.id);
    const first = await host.deliver(one.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    await host.deliver(one.id, alice.id, 'same', { queueIfBusy: true });
    await host.deliver(two.id, bob.id, 'other');
    expect(host.queueState().map((item) => item.reason)).toEqual(['turn', 'capacity']);
    host.setMaxRunningTurns(2);
    await flush();
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first', 'other']);
    expect(host.queueState()).toMatchObject([{ reason: 'turn' }]);
    expect(host.runningCount()).toBe(2);
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    expect(runtime.prompts.at(-1)?.text).toBe('same');
  });

  it('does not interrupt active turns on decrease and waits until below the new limit', async () => {
    host.setMaxRunningTurns(2);
    const ids: string[] = [];
    for (const text of ['first', 'second', 'third']) {
      const alice = bot(text);
      const sent = await host.deliver(direct(alice.id).id, alice.id, text);
      if (!sent.ok) throw new Error(sent.error);
      ids.push(sent.conversationId);
    }
    host.setMaxRunningTurns(1);
    expect(host.runningCount()).toBe(2);
    expect(runtime.aborted).toEqual([]);
    expect(runtime.released).toEqual([]);
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, ids[0]));
    await flush();
    expect(runtime.prompts).toHaveLength(2);
    host.observe(ev({ type: 'turn-completed', turnId: 't2' }, ids[1]));
    await flush();
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first', 'second', 'third']);
    expect(host.runningCount()).toBe(1);
  });
});

describe('BotSessionHost resume delivery', () => {
  it('passes the resume flag only on the prompt that starts the resumed turn, including after queueing', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    expect(
      await host.deliver(chat.id, alice.id, 'resumed', {
        deliveryId: 'd1',
        queueIfBusy: true,
        resume: true,
      })
    ).toMatchObject({ ok: true, queued: true });
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    host.observe(ev({ type: 'turn-completed', turnId: 't2' }, first.conversationId));
    await flush();
    await host.deliver(chat.id, alice.id, 'plain');
    expect(runtime.prompts).toEqual([
      { id: first.conversationId, text: 'first' },
      { id: first.conversationId, text: 'resumed', resume: true },
      { id: first.conversationId, text: 'plain' },
    ]);
  });
});

describe('BotSessionHost.ensureSession', () => {
  it('updates idle member models in place and can return to the default model', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    const engine = { providerId: 'next', modelId: 'new', thinkingLevel: 'high' as const };
    bots.update(alice.id, { engine }, []);
    await host.refreshModel(alice.id);
    expect(runtime.engines).toEqual([{ id: first.conversationId, engine }]);
    expect(host.effectiveBot(first.conversationId)?.engine).toEqual(engine);
    bots.update(alice.id, { engine: undefined }, []);
    await host.refreshModel(alice.id);
    expect(runtime.engines.at(-1)).toEqual({ id: first.conversationId, engine: undefined });
    expect(runtime.spawns).toHaveLength(1);
    expect(runtime.released).toEqual([]);
    expect(chats.get(chat.id)?.sessions[alice.id].conversationId).toBe(first.conversationId);
  });

  it('keeps an active response on its model and switches before the next queued prompt', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    const engine = { providerId: 'next', modelId: 'new' };
    bots.update(alice.id, { engine }, []);
    await host.refreshModel(alice.id);
    expect(runtime.engines).toEqual([]);
    await host.deliver(chat.id, alice.id, 'next', { queueIfBusy: true });
    const prompt = runtime.prompt.bind(runtime);
    runtime.prompt = (id, text) => {
      expect(runtime.engines.at(-1)).toEqual({ id, engine });
      return prompt(id, text);
    };
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    expect(runtime.prompts.at(-1)?.text).toBe('next');
    expect(runtime.engines).toHaveLength(1);
    expect(runtime.aborted).toEqual([]);
  });

  it('does not send a new prompt with the old model when synchronization fails', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    bots.update(alice.id, { engine: { providerId: 'next', modelId: 'new' } }, []);
    runtime.modelResult = { ok: false, error: 'no-usable-model' };
    expect(await host.deliver(chat.id, alice.id, 'next')).toEqual({
      ok: false,
      error: 'no-usable-model',
    });
    expect(runtime.prompts).toHaveLength(1);
    expect(host.effectiveBot(first.conversationId)?.engine).toBeUndefined();
  });

  describe('model probe', () => {
    it('委派按任务自己的模型探测和回退，恢复后回任务模型而非成员后来修改的模型', async () => {
      const alice = bot('Alice');
      const bob = bot('Bob');
      const own = { providerId: 'p', modelId: 'task-model' };
      const specBot = { ...bob, engine: own };
      const parent = host.ensureSession(direct(alice.id).id, alice.id);
      if (!parent.ok) throw new Error(parent.error);
      const child = registry.createBotConversation(
        registry.conversation(parent.conversationId)!.projectId,
        { botId: bob.id, chatId: null, delegationId: 'd1' }
      )!;
      host.registerDelegation(child.conversationId, specBot);
      bots.update(bob.id, { engine: { providerId: 'p', modelId: 'new-member-model' } }, []);
      await host.deliverConversation(child.conversationId, 'first');
      expect(probeCalls.at(-1)?.engine).toEqual(own);
      expect(runtime.spawns[0].bot.engine).toEqual(own);
      host.observe(ev({ type: 'turn-completed', turnId: 't1' }, child.conversationId));
      await flush();
      const fallback = { providerId: 'p', modelId: 'default' };
      probeResult = {
        ok: true,
        fallback: { model: fallback, label: 'Default', reason: '鉴权失败' },
      };
      await host.deliverConversation(child.conversationId, 'failed');
      expect(runtime.engines.at(-1)?.engine).toEqual(fallback);
      host.observe(ev({ type: 'turn-completed', turnId: 't2' }, child.conversationId));
      await flush();
      probeResult = { ok: true };
      await host.deliverConversation(child.conversationId, 'recovered');
      expect(runtime.engines.at(-1)?.engine).toEqual(own);
    });

    it('真实投递报模型错误时作废该成员探测缓存；取消与非模型错误不作废', async () => {
      const alice = bot('Alice');
      const engine = { providerId: 'p', modelId: 'member-model' };
      bots.update(alice.id, { engine }, []);
      const chat = direct(alice.id);
      const first = await host.deliver(chat.id, alice.id, 'hi');
      if (!first.ok) throw new Error(first.error);
      host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
      host.observe(
        ev({ type: 'turn-failed', turnId: 't1', error: 'aborted' }, first.conversationId)
      );
      await flush();
      expect(invalidated).toEqual([]);
      await host.deliver(chat.id, alice.id, 'again');
      host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
      host.observe(
        ev(
          {
            type: 'message-upsert',
            index: 1,
            message: {
              role: 'assistant',
              content: [],
              stopReason: 'error',
              errorMessage: '401 Unauthorized: invalid api key',
            },
          },
          first.conversationId
        )
      );
      host.observe(ev({ type: 'turn-completed', turnId: 't2' }, first.conversationId));
      await flush();
      expect(invalidated).toEqual([engine]);
    });

    it('委派会话报模型错误时按任务自己的模型作废', async () => {
      const alice = bot('Alice');
      const bob = bot('Bob');
      const own = { providerId: 'p', modelId: 'task-model' };
      const parent = host.ensureSession(direct(alice.id).id, alice.id);
      if (!parent.ok) throw new Error(parent.error);
      const child = registry.createBotConversation(
        registry.conversation(parent.conversationId)!.projectId,
        { botId: bob.id, chatId: null, delegationId: 'd1' }
      )!;
      host.registerDelegation(child.conversationId, { ...bob, engine: own });
      await host.deliverConversation(child.conversationId, 'task');
      host.observe(ev({ type: 'status', status: 'running' }, child.conversationId));
      host.observe(
        ev({ type: 'turn-failed', turnId: 't1', error: 'fetch failed' }, child.conversationId)
      );
      await flush();
      expect(invalidated).toEqual([own]);
    });

    it('实测期间停止，返回后不得spawn、换模型或投递', async () => {
      const alice = bot('Alice');
      const chat = direct(alice.id);
      const ready = host.ensureSession(chat.id, alice.id);
      if (!ready.ok) throw new Error(ready.error);
      let release!: () => void;
      const probing = new Promise<void>((r) => {
        release = r;
      });
      host = new BotSessionHost({
        bots,
        chats,
        authority: registry,
        runtime,
        emit: (e) => events.push(e),
        probe: async () => {
          await probing;
          return {
            ok: true,
            fallback: {
              model: { providerId: 'p', modelId: 'default' },
              label: 'Default',
              reason: '鉴权失败',
            },
          };
        },
      });
      const sent = host.deliver(chat.id, alice.id, 'hi');
      await flush();
      const stopping = host.abortConversation(ready.conversationId);
      release();
      expect(await sent).toEqual({ ok: false, error: 'canceled' });
      await stopping;
      expect(runtime.spawns).toHaveLength(0);
      expect(runtime.engines).toHaveLength(0);
      expect(runtime.prompts).toHaveLength(0);
    });
    it('虚拟模型备用实测成功后活会话用备用，恢复后回到虚拟模型且全程不提示', async () => {
      const alice = bot('Alice');
      const engine = { providerId: 'enso-virtual', modelId: 'v' };
      bots.update(alice.id, { engine }, []);
      const chat = direct(alice.id);
      const first = await host.deliver(chat.id, alice.id, 'first');
      if (!first.ok) throw new Error(first.error);
      host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
      await flush();
      const backup = { providerId: 'p', modelId: 'backup' };
      probeResult = { ok: true, model: backup };
      await host.deliver(chat.id, alice.id, 'primary failed');
      expect(runtime.engines.at(-1)?.engine).toEqual(backup);
      expect(bots.get(alice.id)?.engine).toEqual(engine);
      host.observe(ev({ type: 'turn-completed', turnId: 't2' }, first.conversationId));
      await flush();
      probeResult = { ok: true };
      await host.deliver(chat.id, alice.id, 'recovered');
      expect(runtime.engines.at(-1)?.engine).toEqual(engine);
      expect(events.filter((e) => e.kind === 'model-notice')).toHaveLength(0);
    });
    it('冷会话实际用默认模型，活会话恢复成员模型，回退提示按状态去重', async () => {
      const alice = bot('Alice');
      const engine = { providerId: 'p', modelId: 'member' };
      const fallback = { providerId: 'p', modelId: 'default' };
      bots.update(alice.id, { engine }, []);
      const chat = direct(alice.id);
      probeResult = {
        ok: true,
        fallback: { model: fallback, label: 'Default', reason: '鉴权失败' },
      };
      const first = await host.deliver(chat.id, alice.id, 'hi');
      if (!first.ok) throw new Error(first.error);
      expect(runtime.spawns[0].bot.engine).toEqual(fallback);
      expect(bots.get(alice.id)?.engine).toEqual(engine);
      expect(events.filter((e) => e.kind === 'model-notice')).toHaveLength(1);
      host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
      await flush();
      await host.deliver(chat.id, alice.id, 'next');
      expect(events.filter((e) => e.kind === 'model-notice')).toHaveLength(1);
      host.observe(ev({ type: 'turn-completed', turnId: 't2' }, first.conversationId));
      await flush();
      probeResult = { ok: true };
      await host.deliver(chat.id, alice.id, 'recovered');
      expect(runtime.engines.at(-1)?.engine).toEqual(engine);
      host.observe(ev({ type: 'turn-completed', turnId: 't3' }, first.conversationId));
      await flush();
      probeResult = {
        ok: true,
        fallback: { model: fallback, label: 'Default', reason: '鉴权失败' },
      };
      await host.deliver(chat.id, alice.id, 'broken again');
      expect(runtime.engines.at(-1)?.engine).toEqual(fallback);
      expect(events.filter((e) => e.kind === 'model-notice')).toHaveLength(2);
      expect(runtime.prompts).toHaveLength(4);
    });

    it('群聊回退提示写进系统条，完整备用链成功不提示', async () => {
      const alice = bot('Alice');
      const bob = bot('Bob');
      const home = registry.ensureBotHomeProject(join(root, 'group-home'));
      const chat = chats.create({
        kind: 'group',
        title: 'G',
        members: [alice.id, bob.id],
        bossBotId: alice.id,
        workspace: { kind: 'chat-home', projectId: home!.projectId },
      });
      if (!chat) throw new Error('chat');
      probeResult = {
        ok: true,
        fallback: {
          model: { providerId: 'p', modelId: 'default' },
          label: 'Default',
          reason: '模型 member：鉴权失败',
        },
      };
      const first = await host.deliver(chat.id, alice.id, 'hi');
      if (!first.ok) throw new Error(first.error);
      expect(chats.readEntries(chat.id)).toMatchObject([
        {
          kind: 'system',
          text: 'Alice 的模型不可用，本次改用默认模型 Default（模型 member：鉴权失败）',
        },
      ]);
      host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
      await flush();
      probeResult = { ok: true };
      await host.deliver(chat.id, alice.id, 'backup healthy');
      expect(chats.readEntries(chat.id)).toHaveLength(1);
    });

    it('实测失败时拒绝投递并透出模型原因，不拉起会话', async () => {
      const alice = bot('Alice');
      const chat = direct(alice.id);
      probeResult = { ok: false, error: '模型 gpt-5：鉴权失败' };
      expect(await host.deliver(chat.id, alice.id, 'hi')).toEqual({
        ok: false,
        error: '模型 gpt-5：鉴权失败',
      });
      expect(runtime.spawns).toHaveLength(0);
      expect(runtime.prompts).toHaveLength(0);
    });

    it('改配后实测失败同样拒绝；实测通过才投递', async () => {
      const alice = bot('Alice');
      const chat = direct(alice.id);
      const first = await host.deliver(chat.id, alice.id, 'hi');
      if (!first.ok) throw new Error(first.error);
      host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
      await flush();
      bots.update(alice.id, { engine: { providerId: 'next', modelId: 'new' } }, []);
      probeResult = { ok: false, error: '模型 new：网络连接失败' };
      expect(await host.deliver(chat.id, alice.id, 'next')).toEqual({
        ok: false,
        error: '模型 new：网络连接失败',
      });
      expect(runtime.prompts).toHaveLength(1);
      probeResult = { ok: true };
      expect((await host.deliver(chat.id, alice.id, 'again')).ok).toBe(true);
      expect(probeCalls).toHaveLength(3);
    });
  });

  it('catches up with a second save while a model update is in flight', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const update = runtime.updateEngine.bind(runtime);
    runtime.updateEngine = async (id, engine) => {
      if (engine?.modelId === 'first') await blocked;
      return update(id, engine);
    };
    bots.update(alice.id, { engine: { providerId: 'p', modelId: 'first' } }, []);
    const saving = host.refreshModel(alice.id);
    await flush();
    const latest = { providerId: 'p', modelId: 'second', thinkingLevel: 'low' as const };
    bots.update(alice.id, { engine: latest }, []);
    resume();
    await saving;
    expect(runtime.engines.map((item) => item.engine?.modelId)).toEqual(['first', 'second']);
    expect(host.effectiveBot(first.conversationId)?.engine).toEqual(latest);
  });

  it('synchronizes the model before retrying a failed response', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    host.observe(ev({ type: 'turn-failed', turnId: 't1', error: 'offline' }, first.conversationId));
    await flush();
    const engine = { providerId: 'p', modelId: 'new' };
    bots.update(alice.id, { engine }, []);
    let retried = false;
    const port: BotRuntimePort = runtime;
    port.retry = (id) => {
      expect(runtime.engines.at(-1)).toEqual({ id, engine });
      retried = true;
      return { ok: true };
    };
    expect(await host.retryConversation(first.conversationId)).toMatchObject({ ok: true });
    expect(retried).toBe(true);
    expect(runtime.spawns).toHaveLength(1);
  });

  it('updates the member across chats without changing another member or resending unchanged models', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const personal = direct(alice.id);
    const group = chats.create({
      kind: 'group',
      title: 'team',
      members: [alice.id, bob.id],
      bossBotId: alice.id,
      workspace: { kind: 'chat-home', projectId: 'home' },
    });
    if (!group) throw new Error('chat');
    const ids: string[] = [];
    for (const [chatId, botId] of [
      [personal.id, alice.id],
      [group.id, alice.id],
      [group.id, bob.id],
    ]) {
      const sent = await host.deliver(chatId, botId, 'hi');
      if (!sent.ok) throw new Error(sent.error);
      ids.push(sent.conversationId);
      host.observe(ev({ type: 'turn-completed', turnId: 't1' }, sent.conversationId));
    }
    await flush();
    const engine = { providerId: 'p', modelId: 'new' };
    bots.update(alice.id, { engine }, []);
    await host.refreshModel(alice.id);
    expect(runtime.engines.map((item) => item.id).sort()).toEqual(ids.slice(0, 2).sort());
    bots.update(alice.id, { title: 'Lead' }, []);
    await host.refreshModel(alice.id);
    expect(runtime.engines).toHaveLength(2);
    expect(host.effectiveBot(ids[2])?.engine).toBeUndefined();
  });
  it('injects notes into the system prompt and announces later updates once per conversation', async () => {
    let snap: { version: string; section: string; update: string } | undefined = {
      version: 'v1',
      section: '<member-notes>\nlikes tea\n</member-notes>',
      update: '<notes-updated>v1</notes-updated>',
    };
    const asked: Array<[string, string | null]> = [];
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: () => {},
      notes: {
        snapshot: (botId, chatId) => {
          asked.push([botId, chatId]);
          return snap;
        },
      },
    });
    const alice = bot('Alice', 'Be kind.');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    expect(runtime.spawns[0].systemPrompt).toMatch(/Be kind\.\n\n<member-notes>/);
    expect(asked[0]).toEqual([alice.id, null]);
    await host.deliver(chat.id, alice.id, 'same notes', { deliveryId: 'n1' });
    host.observe(ev({ type: 'delivery-settled', deliveryId: 'n1' }, first.conversationId));
    snap = { ...snap, version: 'v2', update: '<notes-updated>v2</notes-updated>' };
    await host.deliver(chat.id, alice.id, 'after update', { deliveryId: 'n2' });
    host.observe(ev({ type: 'delivery-settled', deliveryId: 'n2' }, first.conversationId));
    await host.deliver(chat.id, alice.id, 'again', { deliveryId: 'n3' });
    host.observe(ev({ type: 'delivery-settled', deliveryId: 'n3' }, first.conversationId));
    snap = undefined;
    await host.deliver(chat.id, alice.id, 'memory off');
    expect(runtime.steers.map((item) => item.text)).toEqual([
      'same notes',
      '<notes-updated>v2</notes-updated>\n\nafter update',
      'again',
      'memory off',
    ]);
    expect(runtime.spawns).toHaveLength(1);
  });
  it('passes group notes scope and leaves the system prompt alone when memory is off', async () => {
    const asked: Array<[string, string | null]> = [];
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: () => {},
      notes: {
        snapshot: (botId, chatId) => {
          asked.push([botId, chatId]);
          return undefined;
        },
      },
    });
    const alice = bot('Alice', 'Be kind.');
    const bob = bot('Bob');
    const group = chats.create({
      kind: 'group',
      title: 'Team',
      members: [alice.id, bob.id],
      bossBotId: alice.id,
      workspace: { kind: 'chat-home', projectId: 'home' },
    });
    if (!group) throw new Error('chat');
    const sent = await host.deliver(group.id, alice.id, 'hi');
    if (!sent.ok) throw new Error(sent.error);
    expect(asked[0]).toEqual([alice.id, group.id]);
    expect(runtime.spawns[0].systemPrompt.endsWith('Be kind.')).toBe(true);
  });
  it('recognizes persisted delegation results behind a notes update block', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'first');
    if (!sent.ok) throw new Error(sent.error);
    const file = join(root, 'notes-session.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<notes-updated>\nx\n</notes-updated>\n\n<delegation-result id="d1" from="Bob">done</delegation-result>',
            },
          ],
        },
      })
    );
    const conversation = registry.conversation(sent.conversationId)!;
    const original = registry.conversation.bind(registry);
    registry.conversation = (id) =>
      id === sent.conversationId ? { ...conversation, sessionFile: file } : original(id);
    expect(host.hasStartedDelivery(sent.conversationId, 'd1')).toBe(true);
  });
  it('deduplicates queued delivery IDs and recognizes delegation results persisted in user messages', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!sent.ok) throw new Error(sent.error);
    await host.deliver(chat.id, alice.id, 'later', { deliveryId: 'later', queueIfBusy: true });
    await host.deliver(chat.id, alice.id, 'later', { deliveryId: 'later', queueIfBusy: true });
    expect(host.queueState()).toHaveLength(1);
    const file = join(root, 'session.jsonl');
    writeFileSync(
      file,
      [
        '<delegation-result id="persisted" from="Bob">done</delegation-result>',
        '<delegation-results id="batch">\n<delegation-result id="x" from="Bob">done</delegation-result>\n</delegation-results>',
      ]
        .map((text) =>
          JSON.stringify({
            type: 'message',
            message: { role: 'user', content: [{ type: 'text', text }] },
          })
        )
        .join('\n')
    );
    const conversation = registry.conversation(sent.conversationId)!;
    const original = registry.conversation.bind(registry);
    registry.conversation = (id) =>
      id === sent.conversationId ? { ...conversation, sessionFile: file } : original(id);
    expect(host.hasStartedDelivery(sent.conversationId, 'persisted')).toBe(true);
    expect(host.hasStartedDelivery(sent.conversationId, 'batch')).toBe(true);
    expect(host.hasStartedDelivery(sent.conversationId, 'absent')).toBe(false);
    await host.deliver(chat.id, alice.id, 'do not replay', { deliveryId: 'persisted' });
    expect(runtime.steers).toHaveLength(0);
    expect(
      await host.deliver(chat.id, alice.id, 'do not replay', { deliveryId: 'persisted' })
    ).toMatchObject({ ok: true, duplicate: true });
  });
  it('after a crash a fresh host still refuses to replay results the session already received', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!sent.ok) throw new Error(sent.error);
    const file = join(root, 'crash-session.jsonl');
    const persisted = (id: string) =>
      `${JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `<delegation-result id="${id}">ok</delegation-result>` }],
        },
      })}\n`;
    writeFileSync(file, persisted('before'));
    const conversation = registry.conversation(sent.conversationId)!;
    const original = registry.conversation.bind(registry);
    registry.conversation = (id) =>
      id === sent.conversationId ? { ...conversation, sessionFile: file } : original(id);
    expect(host.hasStartedDelivery(sent.conversationId, 'after')).toBe(false);
    // worker 已把结果写进 jsonl，但 Main 在收到确认前崩溃
    appendFileSync(file, persisted('after'));
    const restarted = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime: new FakeRuntime(),
      emit: () => {},
    });
    for (const id of ['before', 'after'])
      expect(
        await restarted.deliver(chat.id, alice.id, 'replay', { deliveryId: id })
      ).toMatchObject({ ok: true, duplicate: true });
    expect(host.hasStartedDelivery(sent.conversationId, 'after')).toBe(true);
    restarted.dispose();
  });
  it('gives each host-started turn a fresh key reported on its finish event', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: Array<string | undefined> = [];
    host.onTurnFinished((event) => finished.push(event.turnKey));
    const sent = await host.deliver(chat.id, alice.id, 'first');
    if (!sent.ok) throw new Error(sent.error);
    const first = host.turnKey(sent.conversationId);
    expect(first).toBeTruthy();
    host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, sent.conversationId));
    expect(finished).toEqual([first]);
    expect(host.turnKey(sent.conversationId)).toBeUndefined();
    await host.deliver(chat.id, alice.id, 'second');
    const second = host.turnKey(sent.conversationId);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
  it('settles a turn that ends with only idle/failed status and sends work queued behind it', async () => {
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: () => {},
      settleGraceMs: 5,
    });
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const first = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!first.ok) throw new Error(first.error);
    await host.deliver(chat.id, alice.id, 'next', { queueIfBusy: true, deliveryId: 'next' });
    host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
    // 中断：worker 只发 idle，不发 turn-completed
    host.observe(ev({ type: 'status', status: 'idle' }, first.conversationId));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(results).toMatchObject([{ deliveryId: 'first', ok: false, error: 'interrupted' }]);
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first', 'next']);
    // worker 命令失败：只有 failed 状态，没有 running 也没有 turn-failed
    host.observe(ev({ type: 'status', status: 'failed', error: 'boom' }, first.conversationId));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(results.at(-1)).toMatchObject({ deliveryId: 'next', ok: false, error: 'boom' });
    expect(host.runningCount()).toBe(0);
    expect(host.isBusy(first.conversationId)).toBe(false);
  });
  it('an idle session without a host turn sends deliveries queued behind its autonomous run', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const session = host.ensureSession(chat.id, alice.id);
    if (!session.ok) throw new Error(session.error);
    host.observe(ev({ type: 'status', status: 'running' }, session.conversationId));
    await host.deliver(chat.id, alice.id, 'routine', { queueIfBusy: true, deliveryId: 'r' });
    expect(runtime.prompts).toHaveLength(0);
    host.observe(ev({ type: 'status', status: 'idle' }, session.conversationId));
    await flush();
    expect(runtime.prompts.map((item) => item.text)).toEqual(['routine']);
  });
  it('idle does not start queued routines or misattribute the completed result', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const first = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!first.ok) throw new Error(first.error);
    await host.deliver(chat.id, alice.id, 'routine', { queueIfBusy: true, deliveryId: 'routine' });
    host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
    host.observe(
      ev(
        {
          type: 'message-upsert',
          index: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
        },
        first.conversationId
      )
    );
    host.observe(ev({ type: 'status', status: 'idle' }, first.conversationId));
    await flush();
    expect(runtime.prompts).toHaveLength(1);
    expect(host.runningCount()).toBe(1);
    host.observe(ev({ type: 'turn-completed', turnId: 'first-turn' }, first.conversationId));
    await flush();
    expect(results).toMatchObject([{ deliveryId: 'first', text: 'first answer' }]);
    expect(runtime.prompts).toHaveLength(2);
  });

  it('reports the model of the final assistant message', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const first = await host.deliver(chat.id, alice.id, 'hi');
    if (!first.ok) throw new Error(first.error);
    host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
    host.observe(
      ev(
        {
          type: 'message-upsert',
          index: 1,
          message: { role: 'assistant', model: 'glm-5.3', content: [{ type: 'text', text: 'ok' }] },
        },
        first.conversationId
      )
    );
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    expect(results).toMatchObject([{ text: 'ok', model: 'glm-5.3' }]);
  });

  it('retiring a session settles queued deliveries exactly once as canceled', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const first = await host.deliver(chat.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    await host.deliver(chat.id, alice.id, 'routine', { queueIfBusy: true, deliveryId: 'routine' });
    host.retireSession(first.conversationId);
    host.retireSession(first.conversationId);
    expect(results.filter((event) => event.deliveryId === 'routine')).toMatchObject([
      { ok: false, error: 'canceled' },
    ]);
    await flush();
    expect(host.runningCount()).toBe(0);
  });

  it('disabling the host rejects new delivery and cancels queued work', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    await host.deliver(chat.id, alice.id, 'first');
    await host.deliver(chat.id, alice.id, 'routine', { queueIfBusy: true, deliveryId: 'routine' });
    host.dispose();
    expect(await host.deliver(chat.id, alice.id, 'later')).toEqual({
      ok: false,
      error: 'disabled',
    });
    expect(results.filter((event) => event.deliveryId === 'routine')).toMatchObject([
      { ok: false, error: 'canceled' },
    ]);
    expect(host.runningCount()).toBe(0);
  });
  it('queues autonomous deliveries behind an active turn rather than steering', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = await host.deliver(chat.id, alice.id, 'first');
    if (!first.ok) throw new Error(first.error);
    await host.deliver(chat.id, alice.id, 'routine', {
      queueIfBusy: true,
      deliveryId: 'routine-1',
    });
    expect(runtime.steers).toHaveLength(0);
    expect(runtime.prompts).toHaveLength(1);
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first', 'routine']);
  });
  it('成员 home：登记隐藏项目、写入 Main 绑定并记录 cursor；幂等；fresh 开新会话并结束旧会话', () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const first = host.ensureSession(chat.id, alice.id);
    if (!first.ok) throw new Error(first.error);
    const conversation = registry.conversation(first.conversationId);
    expect(conversation?.bot).toEqual({ botId: alice.id, chatId: chat.id });
    const project = registry.project(conversation!.projectId);
    expect(project).toMatchObject({ kind: 'bot-home', canonicalPath: bots.homeDir(alice.id) });
    expect(existsSync(bots.homeDir(alice.id))).toBe(true);
    expect(chats.get(chat.id)?.sessions[alice.id]).toEqual({
      conversationId: first.conversationId,
      cursor: 0,
    });

    expect(host.ensureSession(chat.id, alice.id)).toEqual(first);
    const fresh = host.ensureSession(chat.id, alice.id, { fresh: true });
    expect(fresh.ok && fresh.conversationId).not.toBe(first.conversationId);
    expect(registry.conversation(first.conversationId)?.lifecycle).toBe('ended');
    expect(host.sessionsOf(chat.id).map((s) => s.current)).toEqual([false, true]);
  });

  it('私聊切回旧对话：重新打开原会话续写，当前会话结束只读；不属于本聊天或工作区已换的拒绝', async () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const chat = direct(alice.id);
    const other = direct(bob.id);
    const first = await host.deliver(chat.id, alice.id, 'one');
    if (!first.ok) throw new Error(first.error);
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    registry.markReady(first.conversationId, join(root, 'first.jsonl'), {
      providerId: 'p',
      modelId: 'm',
    });
    const second = host.ensureSession(chat.id, alice.id, { fresh: true });
    if (!second.ok) throw new Error(second.error);
    const bobSession = host.ensureSession(other.id, bob.id);
    if (!bobSession.ok) throw new Error(bobSession.error);

    expect(host.switchSession(chat.id, alice.id, bobSession.conversationId)).toEqual({
      ok: false,
      error: 'session-not-found',
    });
    expect(host.switchSession(chat.id, alice.id, first.conversationId)).toEqual({ ok: true });
    expect(chats.get(chat.id)?.sessions[alice.id].conversationId).toBe(first.conversationId);
    expect(registry.conversation(first.conversationId)?.lifecycle).toBe('ready');
    expect(registry.conversation(second.conversationId)?.lifecycle).toBe('ended');
    expect(
      host
        .sessionsOf(chat.id)
        .filter((s) => s.current)
        .map((s) => s.conversationId)
    ).toEqual([first.conversationId]);
    expect(events).toContainEqual({ kind: 'chat', chatId: chat.id });
    expect(host.switchSession(chat.id, alice.id, first.conversationId)).toEqual({ ok: true });
    expect(host.sessionsOf(chat.id).map((s) => s.resumable)).toEqual([true, true]);

    await flush();
    const again = await host.deliver(chat.id, alice.id, 'two');
    expect(again.ok && again.conversationId).toBe(first.conversationId);
    await flush();
    expect(runtime.spawns.at(-1)).toMatchObject({
      conversationId: first.conversationId,
      resumeFile: join(root, 'first.jsonl'),
    });

    const code = join(root, 'code');
    mkdirSync(code);
    const project = registry.createProject({ requestId: 'p', path: code });
    if (!project.accepted) throw new Error('project');
    const moved = chats.update(chat.id, (draft) => {
      draft.workspace = { kind: 'project', projectId: project.value.projectId };
      return draft;
    });
    expect(moved?.workspace.kind).toBe('project');
    expect(host.sessionsOf(chat.id).map((s) => s.resumable)).toEqual([false, false]);
    expect(host.canSwitch(chat.id, alice.id, second.conversationId)).toEqual({
      ok: false,
      error: 'workspace-changed',
    });
    expect(host.switchSession(chat.id, alice.id, second.conversationId)).toEqual({
      ok: false,
      error: 'workspace-changed',
    });
    expect(registry.conversation(second.conversationId)?.lifecycle).toBe('ended');
  });

  it('Code 项目工作区：cwd 取项目路径；项目移除或 ssh 时报错', () => {
    const alice = bot('Alice');
    const code = join(root, 'code');
    mkdirSync(code);
    const project = registry.createProject({ requestId: 'p', path: code });
    if (!project.accepted) throw new Error('project');
    const chat = direct(alice.id, { kind: 'project', projectId: project.value.projectId });
    const session = host.ensureSession(chat.id, alice.id);
    expect(session.ok && registry.conversation(session.conversationId)?.projectId).toBe(
      project.value.projectId
    );
    expect(host.workspacePath(chat.id)).toBe(code);

    registry.removeProject({ requestId: 'r', projectId: project.value.projectId, version: 1 });
    expect(host.ensureSession(chat.id, alice.id)).toEqual({
      ok: false,
      error: 'workspace-unavailable',
    });
  });

  it('群独立工作区：建目录并登记为 bot-home；归档成员与非成员被拒绝', () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const chatId = '55555555-5555-4555-8555-555555555555';
    const home = registry.ensureBotHomeProject(chats.workspaceDir(chatId));
    const chat = chats.create(
      {
        kind: 'group',
        title: 'g',
        members: [alice.id, bob.id],
        bossBotId: alice.id,
        workspace: { kind: 'chat-home', projectId: home!.projectId },
      },
      chatId
    );
    const session = host.ensureSession(chat!.id, bob.id);
    expect(session.ok && registry.conversation(session.conversationId)?.projectId).toBe(
      home!.projectId
    );
    bots.setArchived(alice.id, true);
    expect(host.ensureSession(chat!.id, alice.id)).toEqual({ ok: false, error: 'bot-archived' });
    const carol = bot('Carol');
    expect(host.ensureSession(chat!.id, carol.id)).toEqual({ ok: false, error: 'not-member' });
  });
});

describe('BotSessionHost.deliver', () => {
  it('未运行 → spawn（带人设）后 prompt；运行中 → steer；释放后带 sessionFile 恢复', async () => {
    const alice = bot('Alice', 'Be kind.');
    const chat = direct(alice.id);
    const result = await host.deliver(chat.id, alice.id, 'hi');
    if (!result.ok) throw new Error(result.error);
    expect(runtime.spawns).toHaveLength(1);
    expect(runtime.spawns[0]).toMatchObject({
      conversationId: result.conversationId,
      cwd: bots.homeDir(alice.id),
    });
    expect(runtime.spawns[0].resumeFile).toBeUndefined();
    expect(runtime.spawns[0].systemPrompt).toContain('Be kind.');
    expect(runtime.spawns[0].instructionText).toContain('Bot mode');
    expect(runtime.spawns[0]).not.toHaveProperty('groupTasks');
    expect(runtime.spawns[0]).toMatchObject({ routines: true });
    expect(runtime.prompts).toEqual([{ id: result.conversationId, text: 'hi' }]);

    await host.deliver(chat.id, alice.id, 'more');
    expect(runtime.steers).toEqual([{ id: result.conversationId, text: 'more' }]);

    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, result.conversationId));
    registry.markReady(result.conversationId, join(root, 's.jsonl'), {
      providerId: 'p',
      modelId: 'm',
    });
    host.observe(
      ev(
        {
          type: 'parent-ended',
          reason: 'idle',
          instanceId: runtime.instanceOf(result.conversationId),
        },
        result.conversationId
      )
    );
    await host.deliver(chat.id, alice.id, 'again');
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.spawns[1].resumeFile).toBe(join(root, 's.jsonl'));
  });

  it('spawn 失败返回错误且不 prompt、不占并发位', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    runtime.spawnResult = { ok: false, error: 'no model' };
    expect(await host.deliver(chat.id, alice.id, 'hi')).toEqual({ ok: false, error: 'no model' });
    expect(runtime.prompts).toHaveLength(0);
    expect(host.runningCount()).toBe(0);
  });

  it('全局最多 4 轮并发，超出 FIFO 排队并推送 queue 事件；一轮结束后补位', async () => {
    const chatIds: string[] = [];
    const conversationIds: string[] = [];
    for (const name of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) {
      const member = bot(name);
      const chat = direct(member.id);
      chatIds.push(chat.id);
      const result = await host.deliver(chat.id, member.id, name);
      if (!result.ok) throw new Error(result.error);
      conversationIds.push(result.conversationId);
      expect(result.queued === true).toBe(chatIds.length > 4);
    }
    expect(runtime.prompts.map((p) => p.text)).toEqual(['A1', 'A2', 'A3', 'A4']);
    expect(events).toContainEqual({ kind: 'queue', chatId: chatIds[4] });
    expect(host.queueState().map((q) => q.chatId)).toEqual([chatIds[4], chatIds[5]]);

    host.observe(ev({ type: 'turn-failed', turnId: 't', error: 'x' }, conversationIds[1]));
    await flush();
    expect(runtime.prompts.map((p) => p.text)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
    expect(host.queueState().map((q) => q.position)).toEqual([0]);
  });

  it('worker 退出后清空运行态，下一次投递重新 spawn', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    await host.deliver(chat.id, alice.id, 'hi');
    host.observe({ type: 'worker-exited' });
    expect(host.runningCount()).toBe(0);
    await host.deliver(chat.id, alice.id, 'again');
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.steers).toHaveLength(0);
  });

  it.each(['turn-completed', 'turn-failed', 'parent-ended'] as const)(
    '宿主没占位的运行（如续跑晚于结算宽限才开始）以 %s 结束时补一次出队：同成员同聊天的排队投递开始',
    async (type) => {
      const alice = bot('Alice');
      const bob = bot('Bob');
      const chat = direct(alice.id);
      const parent = host.ensureSession(chat.id, alice.id);
      if (!parent.ok) throw new Error(parent.error);
      const projectId = registry.conversation(parent.conversationId)!.projectId;
      const child = (delegationId: string) => {
        const created = registry.createBotConversation(projectId, {
          botId: bob.id,
          chatId: null,
          delegationId,
        })!;
        const origin = { parentConversationId: parent.conversationId, chatId: chat.id };
        expect(host.registerDelegation(created.conversationId, bob, origin)).toBe(true);
        return created.conversationId;
      };
      const orphan = child('d1');
      const next = child('d2');
      host.observe(ev({ type: 'status', status: 'running' }, orphan));
      expect(host.turnKey(orphan)).toBeUndefined();
      expect(
        await host.deliverConversation(next, 'task two', { deliveryId: 'd2', queueIfBusy: true })
      ).toMatchObject({ ok: true, queued: true });
      expect(host.queueState()).toMatchObject([{ conversationId: next, reason: 'member-serial' }]);
      const ended = {
        'turn-completed': { type, turnId: 't' },
        'turn-failed': { type, turnId: 't', error: 'boom' },
        'parent-ended': { type, reason: 'released' },
      }[type];
      host.observe(ev(ended, orphan));
      await flush();
      expect(runtime.prompts.map((item) => item.text)).toEqual(['task two']);
      expect(host.queueState()).toEqual([]);
    }
  );

  it('stop aborts the active turn, drops queued work and preserves the resumable conversation', async () => {
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: () => {},
      maxRunningTurns: 1,
    });
    const alice = bot('Alice');
    const bob = bot('Bob');
    const aliceChat = direct(alice.id);
    const bobChat = direct(bob.id);
    const first = await host.deliver(aliceChat.id, alice.id, 'active');
    const second = await host.deliver(bobChat.id, bob.id, 'queued');
    if (!first.ok || !second.ok) throw new Error('fixture');
    await host.stopTurn(bobChat.id, bob.id);
    expect(host.queueState()).toEqual([]);
    await host.stopTurn(aliceChat.id, alice.id);
    expect(runtime.aborted).toContain(first.conversationId);
    expect(host.runningCount()).toBe(0);
    expect(registry.conversation(first.conversationId)?.lifecycle).not.toBe('ended');
    expect(runtime.prompts.map((p) => p.text)).toEqual(['active']);
    await host.deliver(aliceChat.id, alice.id, 'next');
    expect(runtime.spawns).toHaveLength(2);
    expect(runtime.prompts.at(-1)?.text).toBe('next');
  });

  it('同会话排队的后续消息在它 spawn + prompt 之后才 steer', async () => {
    const order: string[] = [];
    const slow = new FakeRuntime();
    slow.spawn = async (spec) => {
      order.push('spawn');
      await flush();
      return FakeRuntime.prototype.spawn.call(slow, spec);
    };
    slow.prompt = (_id, text) => {
      order.push(`prompt:${text}`);
      return { ok: true };
    };
    slow.steer = (_id, text) => {
      order.push(`steer:${text}`);
      return { ok: true };
    };
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime: slow,
      emit: () => {},
      maxRunningTurns: 1,
    });
    const alice = bot('Alice');
    const bob = bot('Bob');
    const first = await host.deliver(direct(alice.id).id, alice.id, 'a');
    const bobChat = direct(bob.id);
    expect(await host.deliver(bobChat.id, bob.id, 'b1')).toMatchObject({ queued: true });
    expect(await host.deliver(bobChat.id, bob.id, 'b2')).toMatchObject({ queued: true });
    if (!first.ok) throw new Error(first.error);
    host.observe(ev({ type: 'turn-completed', turnId: 't' }, first.conversationId));
    await flush();
    await flush();
    expect(order.slice(2)).toEqual(['spawn', 'prompt:b1', 'steer:b2']);
  });
});

describe('BotSessionHost turn results', () => {
  it('turn-completed 回调这一轮最后一条 assistant 文本；中断记为失败；Code 会话不回调', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const finished: BotTurnFinished[] = [];
    host.onTurnFinished((event) => finished.push(event));
    const result = await host.deliver(chat.id, alice.id, 'hi');
    if (!result.ok) throw new Error(result.error);
    const id = result.conversationId;
    host.observe(ev({ type: 'status', status: 'running' }, id));
    const assistant = (index: number, text: string, extra = {}) =>
      ev(
        {
          type: 'message-upsert',
          index,
          message: { role: 'assistant', content: [{ type: 'text', text }], ...extra },
        },
        id
      );
    host.observe(assistant(1, 'thinking about it'));
    host.observe(assistant(3, 'Done: '));
    host.observe(assistant(3, 'Done: shipped.'));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, id));
    expect(finished).toEqual([
      {
        chatId: chat.id,
        botId: alice.id,
        conversationId: id,
        turnId: 't1',
        text: 'Done: shipped.',
        ok: true,
        turnKey: expect.any(String),
      },
    ]);

    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(assistant(5, 'partial', { stopReason: 'aborted' }));
    host.observe(ev({ type: 'turn-completed', turnId: 't2' }, id));
    expect(finished[1]).toMatchObject({ turnId: 't2', ok: false, text: 'partial' });

    host.observe(ev({ type: 'turn-completed', turnId: 'x' }, crypto.randomUUID()));
    expect(finished).toHaveLength(2);
  });
});

describe('BotSessionHost cleanup', () => {
  it('resetSessions 结束旧会话并清空 sessions；discardChat 删除会话、文件与聊天目录', async () => {
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const result = await host.deliver(chat.id, alice.id, 'hi');
    if (!result.ok) throw new Error(result.error);
    host.resetSessions(chat.id);
    expect(chats.get(chat.id)?.sessions).toEqual({});
    expect(registry.conversation(result.conversationId)?.lifecycle).toBe('ended');
    await flush();
    expect(runtime.released).toContain(result.conversationId);

    const next = host.ensureSession(chat.id, alice.id);
    host.discardChat(chat.id);
    expect(chats.get(chat.id)).toBeUndefined();
    expect(registry.conversation(result.conversationId)).toBeUndefined();
    expect(next.ok && registry.conversation(next.conversationId)).toBeUndefined();
    expect(runtime.removedFiles).toHaveLength(2);
  });

  it('discardBot 级联删除私聊与成员 home，群主被拒绝', () => {
    const alice = bot('Alice');
    const bob = bot('Bob');
    const chat = direct(alice.id);
    host.ensureSession(chat.id, alice.id);
    const code = join(root, 'code');
    mkdirSync(code);
    const project = registry.createProject({ requestId: 'p', path: code });
    if (!project.accepted) throw new Error('project');
    const group = chats.create({
      kind: 'group',
      title: 'g',
      members: [alice.id, bob.id],
      bossBotId: bob.id,
      workspace: { kind: 'project', projectId: project.value.projectId },
    });
    expect(host.discardBot(bob.id)).toEqual({ ok: false, reason: 'boss', chatIds: [group!.id] });
    expect(host.discardBot(alice.id)).toEqual({ ok: true });
    expect(chats.get(chat.id)).toBeUndefined();
    expect(bots.get(alice.id)).toBeUndefined();
    expect(existsSync(bots.homeDir(alice.id))).toBe(false);
    expect(chats.get(group!.id)?.members).toEqual([alice.id, bob.id]);
  });
});

it('群聊成员会话挂群任务看板，私聊不挂', async () => {
  const alice = bot('Alice');
  const bob = bot('Bob');
  const code = join(root, 'code');
  mkdirSync(code);
  const project = registry.createProject({ requestId: 'p', path: code });
  if (!project.accepted) throw new Error('project');
  const group = chats.create({
    kind: 'group',
    title: 'g',
    members: [alice.id, bob.id],
    bossBotId: alice.id,
    workspace: { kind: 'project', projectId: project.value.projectId },
  })!;
  const result = await host.deliver(group.id, alice.id, 'hi');
  if (!result.ok) throw new Error(result.error);
  expect(runtime.spawns[0]).toMatchObject({ groupTasks: true, routines: true });
  expect(runtime.spawns[0].instructionText).toContain('group_tasks');
});

describe('BotSessionHost budget gate', () => {
  function budgeted(over: Set<string>) {
    const checked: string[] = [];
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      budget: {
        prepare: async (botId) => {
          checked.push(botId);
        },
        verdict: (botId) => (over.has(botId) ? 'tokens' : null),
      },
    });
    return checked;
  }

  it('rejects a delivery before it reaches the worker and announces it', async () => {
    const over = new Set<string>();
    budgeted(over);
    const alice = bot('Alice');
    const chat = direct(alice.id);
    over.add(alice.id);
    expect(await host.deliver(chat.id, alice.id, 'hi')).toEqual({
      ok: false,
      error: 'budget-exceeded',
    });
    expect(runtime.spawns).toHaveLength(0);
    expect(runtime.prompts).toHaveLength(0);
    expect(events).toContainEqual({ kind: 'budget', chatId: chat.id });
  });

  it('checks a delegation child against the target member', async () => {
    const over = new Set<string>();
    const checked = budgeted(over);
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
    expect(host.registerDelegation(child.conversationId, bob)).toBe(true);
    over.add(bob.id);
    expect(await host.deliverConversation(child.conversationId, 'task')).toEqual({
      ok: false,
      error: 'budget-exceeded',
    });
    expect(checked).toEqual([bob.id]);
  });

  it('settles a queued delivery with the budget error when it would start', async () => {
    const over = new Set<string>();
    budgeted(over);
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const first = await host.deliver(chat.id, alice.id, 'first', { deliveryId: 'first' });
    if (!first.ok) throw new Error(first.error);
    await host.deliver(chat.id, alice.id, 'routine', { queueIfBusy: true, deliveryId: 'r' });
    over.add(alice.id);
    host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
    host.observe(ev({ type: 'turn-completed', turnId: 't1' }, first.conversationId));
    await flush();
    await flush();
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first']);
    expect(results.at(-1)).toMatchObject({ deliveryId: 'r', ok: false, error: 'budget-exceeded' });
  });

  it('stops the running turn once a finished assistant message pushes usage over the cap', async () => {
    const over = new Set<string>();
    budgeted(over);
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const sent = await host.deliver(chat.id, alice.id, 'work', { deliveryId: 'w' });
    if (!sent.ok) throw new Error(sent.error);
    host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
    const upsert = (index: number) =>
      host.observe(
        ev(
          {
            type: 'message-upsert',
            index,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'step' }],
              stopReason: 'toolUse',
              usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
            },
          },
          sent.conversationId
        )
      );
    upsert(1);
    await flush();
    expect(runtime.aborted).toEqual([]);
    over.add(alice.id);
    upsert(3);
    await flush();
    await flush();
    expect(runtime.aborted).toEqual([sent.conversationId]);
    expect(results).toMatchObject([{ deliveryId: 'w', ok: false, error: 'budget-exceeded' }]);
    expect(events).toContainEqual({ kind: 'budget', chatId: chat.id });
    expect(host.isBusy(sent.conversationId)).toBe(false);
  });
});

describe('BotSessionHost budget reservation and per-turn cap', () => {
  function reserving(limit: number) {
    const asked: number[] = [];
    const recorded: Array<[string, string, number]> = [];
    let used = 0;
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      budget: {
        prepare: async () => {},
        verdict: (_botId, reserved) => {
          asked.push(reserved);
          return used + reserved >= limit ? 'tokens' : null;
        },
        record: (botId, conversationId, index, message) => {
          recorded.push([botId, conversationId, index]);
          const u = message.usage!;
          used += u.input + u.output + u.cacheRead + u.cacheWrite;
        },
      },
    });
    return { asked, recorded };
  }
  const usage = (id: string, index: number, input: number, stopReason?: string) =>
    host.observe(
      ev(
        {
          type: 'message-upsert',
          index,
          message: {
            role: 'assistant',
            content: [],
            timestamp: index,
            ...(stopReason ? { stopReason } : {}),
            usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
        id
      )
    );
  async function twoChats() {
    const alice = bot('Alice');
    const one = direct(alice.id);
    const two = direct(alice.id);
    return { alice, one, two };
  }

  it('holds 32k per running turn of the member so concurrent turns cannot all pass the cap', async () => {
    const { asked } = reserving(50_000);
    const { alice, one, two } = await twoChats();
    const first = await host.deliver(one.id, alice.id, 'a');
    if (!first.ok) throw new Error(first.error);
    expect(asked).toEqual([0]);
    host.observe(ev({ type: 'status', status: 'running' }, first.conversationId));
    // 本回合已用的部分从预留里扣掉
    usage(first.conversationId, 1, 20_000, 'toolUse');
    await flush();
    expect(asked.at(-1)).toBe(0);
    const second = await host.deliver(two.id, alice.id, 'b');
    expect(second.ok).toBe(true);
    expect(asked.at(-1)).toBe(12_000);
    host.observe(ev({ type: 'turn-completed', turnId: 't' }, first.conversationId));
    await flush();
    // 回合结束即释放；另一回合的预留仍在
    usage(second.ok ? second.conversationId : '', 1, 5_000, 'toolUse');
    await flush();
    expect(asked.at(-1)).toBe(0);
  });

  it('lets only one of two simultaneous turns start when both together would pass the cap', async () => {
    reserving(30_000);
    const { alice, one, two } = await twoChats();
    const results = await Promise.all([
      host.deliver(one.id, alice.id, 'a'),
      host.deliver(two.id, alice.id, 'b'),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(results[1]).toMatchObject({ error: 'budget-exceeded' });
    expect(runtime.prompts).toHaveLength(1);
  });

  it('caps the reservation by maxTokensPerTurn', async () => {
    const { asked } = reserving(1_000_000);
    const { alice, one, two } = await twoChats();
    bots.update(alice.id, { maxTokensPerTurn: 10_000 }, []);
    const first = await host.deliver(one.id, alice.id, 'a');
    if (!first.ok) throw new Error(first.error);
    usage(first.conversationId, 1, 4_000, 'toolUse');
    await host.deliver(two.id, alice.id, 'b');
    expect(asked.at(-1)).toBe(6_000);
  });

  it('records each finished assistant message once into the ledger, streaming parts not', async () => {
    const { recorded } = reserving(1_000_000);
    const { alice, one } = await twoChats();
    const sent = await host.deliver(one.id, alice.id, 'a');
    if (!sent.ok) throw new Error(sent.error);
    usage(sent.conversationId, 1, 10);
    host.observe(
      ev(
        {
          type: 'message-upsert',
          index: 1,
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'stop',
            timing: { stepStartMs: 1 },
            usage: { input: 15, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
        sent.conversationId
      )
    );
    expect(recorded).toEqual([]);
    usage(sent.conversationId, 1, 20, 'stop');
    expect(recorded).toEqual([[alice.id, sent.conversationId, 1]]);
  });

  it('stops a turn whose streamed usage passes maxTokensPerTurn, and resets for the next turn', async () => {
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
    });
    const alice = bot('Alice');
    bots.update(alice.id, { maxTokensPerTurn: 1_000 }, []);
    const chat = direct(alice.id);
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const sent = await host.deliver(chat.id, alice.id, 'a', { deliveryId: 'a' });
    if (!sent.ok) throw new Error(sent.error);
    host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
    usage(sent.conversationId, 1, 600, 'toolUse');
    usage(sent.conversationId, 3, 300);
    usage(sent.conversationId, 3, 400);
    await flush();
    expect(runtime.aborted).toEqual([]);
    usage(sent.conversationId, 3, 401);
    await flush();
    await flush();
    expect(runtime.aborted).toEqual([sent.conversationId]);
    expect(results).toEqual([
      expect.objectContaining({ deliveryId: 'a', ok: false, error: 'turn-token-limit' }),
    ]);
    expect(results[0]).not.toHaveProperty('stopped');
    const next = await host.deliver(chat.id, alice.id, 'b');
    if (!next.ok) throw new Error(next.error);
    usage(next.conversationId, 5, 900, 'toolUse');
    await flush();
    expect(runtime.aborted).toHaveLength(1);
  });

  it('flags user stops but not budget stops as stopped', async () => {
    reserving(100);
    const { alice, one } = await twoChats();
    const results: BotTurnFinished[] = [];
    host.onTurnFinished((event) => results.push(event));
    const sent = await host.deliver(one.id, alice.id, 'a');
    if (!sent.ok) throw new Error(sent.error);
    usage(sent.conversationId, 1, 200, 'toolUse');
    await flush();
    await flush();
    expect(results.at(-1)).toMatchObject({ ok: false, error: 'budget-exceeded' });
    expect(results.at(-1)).not.toHaveProperty('stopped');
  });

  it('estimates streamed output (~4 chars per token) when the provider reports usage only at the end', async () => {
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
    });
    const alice = bot('Alice');
    bots.update(alice.id, { maxTokensPerTurn: 1_000 }, []);
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'a');
    if (!sent.ok) throw new Error(sent.error);
    const stream = (text: string, args: unknown) =>
      host.observe(
        ev(
          {
            type: 'message-upsert',
            index: 1,
            // pi 的流式中间态也带 stopReason，只有 message_end 才有 completedMs
            message: {
              role: 'assistant',
              stopReason: 'stop',
              timing: { stepStartMs: 1 },
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              content: [
                { type: 'thinking', text },
                { type: 'toolCall', id: 'c', name: 'write', arguments: args },
              ],
            },
          },
          sent.conversationId
        )
      );
    stream('x'.repeat(2_000), { body: 'y'.repeat(1_900) });
    await flush();
    expect(runtime.aborted).toEqual([]);
    stream('x'.repeat(2_000), { body: 'y'.repeat(2_100) });
    await flush();
    await flush();
    expect(runtime.aborted).toEqual([sent.conversationId]);
  });

  it('does not double count: the reported usage replaces the estimate once the message ends', async () => {
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
    });
    const alice = bot('Alice');
    bots.update(alice.id, { maxTokensPerTurn: 1_000 }, []);
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'a');
    if (!sent.ok) throw new Error(sent.error);
    host.observe(
      ev(
        {
          type: 'message-upsert',
          index: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(2_800) }] },
        },
        sent.conversationId
      )
    );
    usage(sent.conversationId, 1, 300, 'toolUse');
    usage(sent.conversationId, 3, 600, 'toolUse');
    await flush();
    expect(runtime.aborted).toEqual([]);
  });

  describe('OpenAI-compatible stream without usage until message_end', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const meta = (id: string, used: number) =>
      host.observe(ev({ type: 'session-meta', occupancy: { used } }, id));
    const stream = (
      id: string,
      index: number,
      text: string,
      reported: Partial<typeof zero> = {},
      final = false
    ) =>
      host.observe(
        ev(
          {
            type: 'message-upsert',
            index,
            message: {
              role: 'assistant',
              stopReason: 'stop',
              timing: final ? { stepStartMs: 1, completedMs: 2 } : { stepStartMs: 1 },
              usage: { ...zero, ...reported },
              content: [{ type: 'text', text }],
            },
          },
          id
        )
      );
    async function cappedTurn(cap?: number) {
      if (cap === undefined) reserving(10_000);
      else
        host = new BotSessionHost({
          bots,
          chats,
          authority: registry,
          runtime,
          emit: (event) => events.push(event),
        });
      const alice = bot('Alice');
      if (cap !== undefined) bots.update(alice.id, { maxTokensPerTurn: cap }, []);
      const chat = direct(alice.id);
      const results: BotTurnFinished[] = [];
      host.onTurnFinished((event) => results.push(event));
      const sent = await host.deliver(chat.id, alice.id, 'write a long essay');
      if (!sent.ok) throw new Error(sent.error);
      host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
      return { id: sent.conversationId, results };
    }

    it('stops mid-stream once context + streamed Chinese text passes the cap', async () => {
      const { id, results } = await cappedTurn(3_000);
      meta(id, 2_000);
      stream(id, 1, '字'.repeat(1_200));
      await flush();
      expect(runtime.aborted).toEqual([]);
      stream(id, 1, '字'.repeat(1_800));
      await flush();
      await flush();
      expect(runtime.aborted).toEqual([id]);
      expect(results).toEqual([
        expect.objectContaining({ ok: false, error: 'turn-token-limit', estimated: true }),
      ]);
    });

    it('trusts reported usage over the estimate and only flags estimated stops', async () => {
      const { id, results } = await cappedTurn(3_000);
      meta(id, 2_900);
      stream(id, 1, '字'.repeat(1_200), { input: 1_000 });
      await flush();
      expect(runtime.aborted).toEqual([]);
      stream(id, 1, '字'.repeat(1_200), { input: 1_000, output: 300 }, true);
      meta(id, 2_400);
      await flush();
      expect(runtime.aborted).toEqual([]);
      stream(id, 3, 'ok', { input: 2_500, output: 10 }, true);
      await flush();
      await flush();
      expect(runtime.aborted).toEqual([id]);
      expect(results[0]).toMatchObject({ error: 'turn-token-limit' });
      expect(results[0]).not.toHaveProperty('estimated');
    });

    it('does not stop a normal short turn', async () => {
      const { id, results } = await cappedTurn(3_000);
      meta(id, 2_000);
      stream(id, 1, '你好，我是 Alice。');
      stream(id, 1, '你好，我是 Alice。', { input: 2_050, output: 12 }, true);
      host.observe(ev({ type: 'turn-completed', turnId: 't' }, id));
      await flush();
      expect(runtime.aborted).toEqual([]);
      expect(results).toEqual([expect.objectContaining({ ok: true })]);
    });

    it('checks the daily budget while streaming with the same estimate', async () => {
      const { id, results } = await cappedTurn();
      meta(id, 2_000);
      stream(id, 1, 'a'.repeat(4_000));
      await flush();
      expect(runtime.aborted).toEqual([]);
      stream(id, 1, 'a'.repeat(40_000));
      await flush();
      await flush();
      expect(runtime.aborted).toEqual([id]);
      expect(results).toEqual([expect.objectContaining({ ok: false, error: 'budget-exceeded' })]);
    });
  });
});

describe('BotSessionHost silence watchdog', () => {
  let clock: number;
  const make = () => {
    clock = 1_000;
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      silenceMs: 90_000,
      now: () => clock,
    });
  };
  const silenceEvents = () => events.filter((event) => event.kind === 'silence');

  it('defaults to 5 minutes so long quiet commands are not flagged early', async () => {
    clock = 1_000;
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime,
      emit: (event) => events.push(event),
      now: () => clock,
    });
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'sleep');
    if (!sent.ok) throw new Error(sent.error);
    host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
    clock += 299_000;
    host.checkSilence();
    expect(host.silences()).toEqual([]);
    clock += 2_000;
    host.checkSilence();
    expect(host.silences()).toHaveLength(1);
  });

  it('flags a running turn after 90s without output and clears it when output resumes', async () => {
    make();
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'sleep');
    if (!sent.ok) throw new Error(sent.error);
    host.observe(ev({ type: 'status', status: 'running' }, sent.conversationId));
    clock += 89_000;
    host.checkSilence();
    expect(host.silences()).toEqual([]);
    clock += 2_000;
    host.checkSilence();
    host.checkSilence();
    expect(host.silences()).toEqual([
      { conversationId: sent.conversationId, chatId: chat.id, botId: alice.id, since: 1_000 },
    ]);
    expect(silenceEvents()).toEqual([
      { kind: 'silence', chatId: chat.id, conversationId: sent.conversationId },
    ]);
    // 子代理进度也算输出
    host.observe({
      type: 'tool-output',
      seq: 2,
      toolCallId: 'x',
      output: '.',
      identity: {
        sessionId: `${sent.conversationId}::c1`,
        generation: 'g',
        parent: { sessionId: sent.conversationId, generation: 'g' },
        instanceId: 'c1',
        instanceName: 'c1',
        typeKey: 'general',
      },
    } as unknown as AgentWorkerEvent);
    expect(host.silences()).toEqual([]);
    expect(silenceEvents()).toHaveLength(2);
    clock += 90_000;
    host.checkSilence();
    expect(host.silences()).toHaveLength(1);
    host.observe(ev({ type: 'turn-completed', turnId: 't' }, sent.conversationId));
    expect(host.silences()).toEqual([]);
    expect(silenceEvents()).toHaveLength(4);
  });

  it('does not flag a turn that is waiting for approval and restarts the clock when answered', async () => {
    make();
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'go');
    if (!sent.ok) throw new Error(sent.error);
    host.observe(
      ev({ type: 'approval-request', request: { requestId: 'r1' } }, sent.conversationId)
    );
    clock += 200_000;
    host.checkSilence();
    expect(host.silences()).toEqual([]);
    host.observe(ev({ type: 'approval-resolved', requestId: 'r1' }, sent.conversationId));
    clock += 60_000;
    host.checkSilence();
    expect(host.silences()).toEqual([]);
    clock += 31_000;
    host.checkSilence();
    expect(host.silences()).toHaveLength(1);
  });

  it('ignores idle sessions and forgets silence when the session stops', async () => {
    make();
    const alice = bot('Alice');
    const chat = direct(alice.id);
    const sent = await host.deliver(chat.id, alice.id, 'go');
    if (!sent.ok) throw new Error(sent.error);
    clock += 100_000;
    host.checkSilence();
    expect(host.silences()).toHaveLength(1);
    await host.stopTurn(chat.id, alice.id);
    expect(host.silences()).toEqual([]);
    clock += 100_000;
    host.checkSilence();
    expect(host.silences()).toEqual([]);
  });
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

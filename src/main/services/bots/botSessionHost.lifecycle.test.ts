import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BotRuntimePort, BotSessionHost, type BotTurnFinished } from './botSessionHost';
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
  invalidated,
  probeCalls,
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

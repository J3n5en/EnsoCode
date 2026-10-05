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
import type { BotChat, BotEngine } from '../../../shared/types/bot';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import {
  type BotRuntimePort,
  BotSessionHost,
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

class FakeRuntime implements BotRuntimePort {
  engines: Array<{ id: string; engine?: BotEngine }> = [];
  modelResult = { ok: true } as { ok: boolean; error?: string };
  async updateEngine(id: string, engine?: BotEngine) {
    if (this.modelResult.ok) this.engines.push({ id, engine });
    return this.modelResult;
  }
  spawns: BotSpawnSpec[] = [];
  prompts: Array<{ id: string; text: string }> = [];
  steers: Array<{ id: string; text: string }> = [];
  released: string[] = [];
  aborted: string[] = [];
  removedFiles: string[] = [];
  spawnResult = { ok: true } as { ok: boolean; error?: string };
  async spawn(spec: BotSpawnSpec) {
    this.spawns.push(spec);
    return this.spawnResult;
  }
  prompt(id: string, text: string) {
    this.prompts.push({ id, text });
    return { ok: true };
  }
  steer(id: string, text: string) {
    this.steers.push({ id, text });
    return { ok: true };
  }
  async release(id: string) {
    this.released.push(id);
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
  host = new BotSessionHost({
    bots,
    chats,
    authority: registry,
    runtime,
    emit: (event) => events.push(event),
  });
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
    await host.deliver(chat.id, alice.id, 'same notes');
    snap = { ...snap, version: 'v2', update: '<notes-updated>v2</notes-updated>' };
    await host.deliver(chat.id, alice.id, 'after update');
    await host.deliver(chat.id, alice.id, 'again');
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
    host.observe(ev({ type: 'parent-ended', reason: 'idle' }, result.conversationId));
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
  const make = () => {
    control = new ControlRuntime();
    host = new BotSessionHost({
      bots,
      chats,
      authority: registry,
      runtime: control,
      emit: () => {},
    });
  };

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

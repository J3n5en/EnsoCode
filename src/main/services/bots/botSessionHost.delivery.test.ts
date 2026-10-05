import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wrapInterjection } from '../../../shared/bots/interject';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import {
  type BotRuntimePort,
  BotSessionHost,
  type BotSessionHostDeps,
  type BotSpawnSpec,
} from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';

let root: string;
let registry: SourceAuthorityRegistry;
let bots: BotStore;
let chats: BotChatStore;
let runtime: FakeRuntime;
let host: BotSessionHost;

class FakeRuntime implements BotRuntimePort {
  prompts: Array<{ id: string; text: string }> = [];
  steers: Array<{ id: string; text: string }> = [];
  async spawn(_spec: BotSpawnSpec) {
    return { ok: true };
  }
  prompt(id: string, text: string) {
    this.prompts.push({ id, text });
    return { ok: true };
  }
  steer(id: string, text: string) {
    this.steers.push({ id, text });
    return { ok: true };
  }
  async release() {}
  abort() {}
  removeSessionFiles() {}
}

function make(extra: Partial<BotSessionHostDeps> = {}) {
  host = new BotSessionHost({
    bots,
    chats,
    authority: registry,
    runtime,
    emit: () => {},
    ...extra,
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-delivery-')));
  registry = new SourceAuthorityRegistry({ registryFile: join(root, 'registry.json') });
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'bot-chats'));
  runtime = new FakeRuntime();
  make();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function direct(name: string) {
  const created = bots.create({ name, title: 'Dev', scope: name, persona: '' }, []);
  if (!created.ok) throw new Error(created.reason);
  const chat = chats.create({
    kind: 'direct',
    title: '',
    members: [created.bot.id],
    bossBotId: null,
    workspace: { kind: 'member-home' },
  });
  if (!chat) throw new Error('chat');
  return { chatId: chat.id, botId: created.bot.id };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const ev = (event: Record<string, unknown>, sessionId: string) =>
  ({ seq: 1, identity: { sessionId, generation: 'g' }, ...event }) as AgentWorkerEvent;

async function started(name = 'Alice') {
  const { chatId, botId } = direct(name);
  const first = await host.deliver(chatId, botId, 'first', { source: 'human' });
  if (!first.ok) throw new Error(first.error);
  return { chatId, botId, id: first.conversationId };
}

describe('BotSessionHost 插话', () => {
  it('人类插话进活轮时加补充说明，非人类来源原样 steer', async () => {
    const { chatId, botId, id } = await started();
    await host.deliver(chatId, botId, 'also tests', { source: 'human' });
    await host.deliver(chatId, botId, '<group-message>relay</group-message>', { source: 'bot' });
    await host.deliver(chatId, botId, 'routine', { source: 'background' });
    expect(runtime.steers).toEqual([
      { id, text: wrapInterjection('also tests', 'zh') },
      { id, text: '<group-message>relay</group-message>' },
      { id, text: 'routine' },
    ]);
  });

  it('补充说明按界面语言，笔记更新块仍在最前', async () => {
    let version = 'v1';
    make({
      language: () => 'en',
      notes: {
        snapshot: () => ({
          version,
          section: '',
          update: `<notes-updated>${version}</notes-updated>`,
        }),
      },
    });
    const { chatId, botId } = await started();
    version = 'v2';
    await host.deliver(chatId, botId, 'more', { source: 'human' });
    expect(runtime.steers.map((item) => item.text)).toEqual([
      `<notes-updated>v2</notes-updated>\n\n${wrapInterjection('more', 'en')}`,
    ]);
  });

  it('自动重试倒计时中人类插话排到下一轮，不打断重试', async () => {
    const { chatId, botId, id } = await started();
    host.observe(ev({ type: 'status', status: 'running' }, id));
    host.observe(
      ev({ type: 'turn-retry', attempt: 1, maxAttempts: 3, delayMs: 2000, error: '503' }, id)
    );
    expect(await host.deliver(chatId, botId, 'wait', { source: 'human' })).toMatchObject({
      ok: true,
      queued: true,
    });
    expect(runtime.steers).toEqual([]);
    host.observe(ev({ type: 'turn-completed', turnId: 't' }, id));
    await flush();
    expect(runtime.prompts.map((item) => item.text)).toEqual(['first', 'wait']);
    expect(runtime.steers).toEqual([]);
  });

  it('重试结束回到运行后插话恢复 steer', async () => {
    const { chatId, botId, id } = await started();
    host.observe(
      ev({ type: 'turn-retry', attempt: 1, maxAttempts: 3, delayMs: 2000, error: '503' }, id)
    );
    host.observe(ev({ type: 'status', status: 'running' }, id));
    await host.deliver(chatId, botId, 'now', { source: 'human' });
    expect(runtime.steers).toEqual([{ id, text: wrapInterjection('now', 'zh') }]);
  });
});

describe('BotSessionHost 排队优先级', () => {
  it('出队按人 > bot > 例行任务，同级先来先出', async () => {
    make({ maxRunningTurns: 1 });
    const { id } = await started('Busy');
    const deliver = async (name: string, source: 'human' | 'bot' | 'background') => {
      const { chatId, botId } = direct(name);
      const sent = await host.deliver(chatId, botId, name, { source });
      expect(sent).toMatchObject({ ok: true, queued: true });
      return sent.ok ? sent.conversationId : '';
    };
    const order = [
      await deliver('routine', 'background'),
      await deliver('relay', 'bot'),
      await deliver('human1', 'human'),
      await deliver('result', 'bot'),
      await deliver('human2', 'human'),
    ];
    expect(host.queueState().map((item) => order.indexOf(item.conversationId))).toEqual([
      2, 4, 1, 3, 0,
    ]);
    let current = id;
    for (const _ of order) {
      host.observe(ev({ type: 'turn-completed', turnId: 't' }, current));
      await flush();
      current = runtime.prompts.at(-1)!.id;
    }
    expect(runtime.prompts.map((item) => item.text)).toEqual([
      'first',
      'human1',
      'human2',
      'relay',
      'result',
      'routine',
    ]);
  });
});

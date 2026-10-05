import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import type { BotChat } from '../../../shared/types/bot';
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
  specs: BotSpawnSpec[] = [];
  async spawn(spec: BotSpawnSpec) {
    this.specs.push(spec);
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-lock-')));
  registry = new SourceAuthorityRegistry({ registryFile: join(root, 'registry.json') });
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'bot-chats'));
  runtime = new FakeRuntime();
  make();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bot(name: string, tools: 'all' | 'readonly' = 'all') {
  const result = bots.create({ name, title: 'Dev', scope: name, persona: '', tools }, []);
  if (!result.ok) throw new Error(result.reason);
  return result.bot;
}

function project(dir = 'code') {
  const path = join(root, dir);
  mkdirSync(path, { recursive: true });
  const created = registry.createProject({ requestId: dir, path });
  if (!created.accepted) throw new Error('project');
  return created.value.projectId;
}

function chat(members: string[], projectId: string, kind: BotChat['kind'] = 'direct'): BotChat {
  const created = chats.create({
    kind,
    title: kind === 'group' ? 'Team' : '',
    members,
    bossBotId: kind === 'group' ? members[0] : null,
    workspace: { kind: 'project', projectId },
  });
  if (!created) throw new Error('chat');
  return created;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const ev = (event: Record<string, unknown>, sessionId: string) =>
  ({ seq: 1, identity: { sessionId, generation: 'g' }, ...event }) as AgentWorkerEvent;
const complete = (id: string) => host.observe(ev({ type: 'turn-completed', turnId: 't' }, id));
const prompted = () => runtime.prompts.map((item) => item.text);

async function send(chatId: string, botId: string, text: string) {
  const result = await host.deliver(chatId, botId, text);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function delegate(parentId: string, botId: string, delegationId: string) {
  const parent = registry.conversation(parentId)!;
  const child = registry.createBotConversation(parent.projectId, {
    botId,
    chatId: null,
    delegationId,
  })!;
  expect(
    host.registerDelegation(child.conversationId, bots.get(botId)!, {
      parentConversationId: parentId,
      chatId: parent.bot?.chatId ?? null,
    })
  ).toBe(true);
  return child.conversationId;
}

describe('BotSessionHost 同工作区写协调（交给 worker 按文件占用）', () => {
  it('同一工作区的写成员不再整轮排队，各自直接开跑', async () => {
    const projectId = project();
    const [a, b, c] = ['A', 'B', 'C'].map((name) => bot(name));
    for (const [member, text] of [
      [a, 'a'],
      [b, 'b'],
      [c, 'c'],
    ] as const)
      expect((await send(chat([member.id], projectId).id, member.id, text)).queued).toBeUndefined();
    expect(prompted()).toEqual(['a', 'b', 'c']);
    expect(host.queueState()).toEqual([]);
  });

  it('写成员 spawn 时带名字与委派链祖先；只读成员不带', async () => {
    const projectId = project();
    const a = bot('Alice');
    const b = bot('Bob');
    const c = bot('Carol');
    const reader = bot('Reader', 'readonly');
    const parent = await send(chat([a.id], projectId).id, a.id, 'a');
    await send(chat([reader.id], projectId).id, reader.id, 'r');
    const child = delegate(parent.conversationId, b.id, 'd1');
    await host.deliverConversation(child, 'task', { queueIfBusy: true });
    const grandchild = delegate(child, c.id, 'd2');
    await host.deliverConversation(grandchild, 'sub', { queueIfBusy: true });
    const lockOf = (id: string) =>
      runtime.specs.find((spec) => spec.conversationId === id)?.writeLock;
    expect(lockOf(parent.conversationId)).toEqual({ label: 'Alice', ancestors: [] });
    expect(runtime.specs.find((spec) => spec.bot.id === reader.id)?.writeLock).toBeUndefined();
    expect(lockOf(child)).toEqual({ label: 'Bob', ancestors: [parent.conversationId] });
    expect(lockOf(grandchild)).toEqual({
      label: 'Carol',
      ancestors: [child, parent.conversationId],
    });
    expect(prompted()).toEqual(['a', 'r', 'task', 'sub']);
  });

  it('onlyIfIdle 投递与私聊重试不因别的写成员在跑而拒绝', async () => {
    const retries: string[] = [];
    runtime = Object.assign(new FakeRuntime(), {
      retry: (id: string) => {
        retries.push(id);
        return { ok: true };
      },
    });
    make();
    const projectId = project();
    const a = bot('A');
    const b = bot('B');
    const c = bot('C');
    await send(chat([a.id], projectId).id, a.id, 'a');
    expect(
      await host.deliver(chat([b.id], projectId).id, b.id, 'result', { onlyIfIdle: true })
    ).toMatchObject({ ok: true });
    const session = host.ensureSession(chat([c.id], projectId).id, c.id);
    if (!session.ok) throw new Error(session.error);
    expect(await host.retryConversation(session.conversationId)).toMatchObject({ ok: true });
    expect(retries).toEqual([session.conversationId]);
  });
});

describe('BotSessionHost 排队原因', () => {
  it('等同会话上一轮时为 turn', async () => {
    const projectId = project();
    const a = bot('A');
    const direct = chat([a.id], projectId);
    await send(direct.id, a.id, 'a');
    await host.deliver(direct.id, a.id, 'next', { queueIfBusy: true });
    expect(host.queueState().map(({ botId, reason }) => [botId, reason])).toEqual([[a.id, 'turn']]);
  });

  it('并发名额满时为 capacity；出队后补发 queue 事件', async () => {
    const events: Array<{ kind: string; chatId?: string }> = [];
    make({ maxRunningTurns: 1, emit: (event) => events.push(event as never) });
    const projectId = project();
    const [a, b] = ['A', 'B'].map((name) => bot(name));
    const first = await send(chat([a.id], projectId).id, a.id, 'a');
    const second = chat([b.id], projectId);
    await send(second.id, b.id, 'b');
    expect(host.queueState().map((item) => item.reason)).toEqual(['capacity']);
    events.length = 0;
    complete(first.conversationId);
    await flush();
    expect(prompted()).toEqual(['a', 'b']);
    expect(host.queueState()).toEqual([]);
    expect(events).toContainEqual({ kind: 'queue', chatId: second.id });
  });
});

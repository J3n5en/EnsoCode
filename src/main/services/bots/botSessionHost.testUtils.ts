import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import type { BotChat, BotEngine, BotProfile } from '../../../shared/types/bot';
import { SourceAuthorityRegistry } from '../sourceAuthorityRegistry';
import { type BotRuntimePort, BotSessionHost, type BotSpawnSpec } from './botSessionHost';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';

export type BotProbeResult =
  | {
      ok: true;
      model?: BotEngine;
      fallback?: { model: BotEngine; label: string; reason: string };
    }
  | { ok: false; error: string };

export interface BotHarnessBridge {
  host: BotSessionHost;
  probeResult: BotProbeResult;
}

let bridge: BotHarnessBridge;

export function bindBotHarness(next: BotHarnessBridge) {
  bridge = next;
}

export class FakeRuntime implements BotRuntimePort {
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

export let root!: string;
export let registry!: SourceAuthorityRegistry;
export let bots!: BotStore;
export let chats!: BotChatStore;
export let runtime!: FakeRuntime;
export let events!: Array<{ kind: string; chatId?: string }>;
export let probeCalls: BotProfile[] = [];
export let invalidated: Array<BotEngine | undefined> = [];

export function bot(name: string, persona = '') {
  const result = bots.create({ name, title: 'Dev', scope: `${name} scope`, persona }, []);
  if (!result.ok) throw new Error(result.reason);
  return result.bot;
}

export function direct(botId: string, workspace: BotChat['workspace'] = { kind: 'member-home' }) {
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

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export function ev(event: Record<string, unknown>, sessionId: string): AgentWorkerEvent {
  return { seq: 1, identity: { sessionId, generation: 'g' }, ...event } as AgentWorkerEvent;
}

export function resetBotHarness() {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-host-')));
  registry = new SourceAuthorityRegistry({ registryFile: join(root, 'registry.json') });
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'bot-chats'));
  runtime = new FakeRuntime();
  events = [];
  bridge.probeResult = { ok: true };
  probeCalls = [];
  invalidated = [];
  bridge.host = new BotSessionHost({
    bots,
    chats,
    authority: registry,
    runtime,
    emit: (event) => events.push(event),
    probe: async (botProfile) => {
      probeCalls.push(botProfile);
      return bridge.probeResult;
    },
    invalidateProbe: (botProfile) => invalidated.push(botProfile.engine),
  });
  // 默认像真实 agentHost：release 等 worker 回 parent-ended 才返回
  runtime.observer = (event) => bridge.host.observe(event);
}

export function cleanupBotHarness() {
  rmSync(root, { recursive: true, force: true });
}

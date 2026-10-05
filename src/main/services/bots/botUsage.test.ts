import { describe, expect, it } from 'vitest';
import type { ConversationAuthority } from '../../../shared/types/agent';
import type { BotProfile } from '../../../shared/types/bot';
import type { UsageRecord } from '../../../shared/usage/types';
import { BotUsageService } from './botUsage';

const NOW = new Date(2026, 9, 4, 12).getTime();
const TODAY = new Date(2026, 9, 4).getTime();
const DAY = 86_400_000;

function rec(id: string, ts: number, tokens = 100): UsageRecord {
  return {
    id,
    ts,
    model: 'm',
    provider: 'p',
    project: '',
    sessionId: `s-${id}`,
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
}

function conv(id: string, bot?: ConversationAuthority['bot']): ConversationAuthority {
  return {
    conversationId: id,
    projectId: 'p',
    kind: 'root',
    lifecycle: 'ready',
    version: 1,
    sessionFile: `/s/${id}.jsonl`,
    ...(bot ? { bot } : {}),
  };
}

function profile(id: string, budget?: BotProfile['budget'], modelId?: string): BotProfile {
  return {
    id,
    name: id.toUpperCase(),
    title: '',
    scope: '',
    avatar: { color: '#000000' },
    approvalMode: 'full',
    tools: 'all',
    skillIds: [],
    mcpServerIds: [],
    delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
    memory: { enabled: true },
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...(budget ? { budget } : {}),
    ...(modelId ? { engine: { providerId: 'p', modelId } } : {}),
  };
}

function setup(budgets: Record<string, BotProfile['budget']> = {}, clock = { now: NOW }) {
  const files: Record<string, UsageRecord[]> = {
    '/s/dm.jsonl': [rec('a1', TODAY + 1000), rec('a2', TODAY - 1)],
    '/s/group.jsonl': [rec('a3', TODAY - 3 * DAY, 50)],
    '/s/child.jsonl': [rec('b1', TODAY + 5, 300)],
    '/s/code.jsonl': [rec('c1', TODAY + 5, 999)],
  };
  const loaded: string[] = [];
  const bots = [profile('alice', budgets.alice), profile('bob', budgets.bob, 'm')];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const gate = { hold: false };
  const service = new BotUsageService({
    bots: { get: (id) => bots.find((b) => b.id === id), list: () => bots },
    conversations: () => [
      conv('dm', { botId: 'alice', chatId: 'chat-dm' }),
      conv('group', { botId: 'alice', chatId: 'chat-group' }),
      // 委派子会话：binding 记目标成员
      conv('child', { botId: 'bob', chatId: null, delegationId: 'd' }),
      conv('code'),
    ],
    load: async (file) => {
      loaded.push(file);
      if (gate.hold) await held;
      return files[file] ? { records: files[file] } : null;
    },
    pricing: async () => ({ m: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    now: () => clock.now,
  });
  return { service, loaded, gate, release: () => release() };
}

const assistant = (timestamp: number, input: number) => ({
  role: 'assistant',
  content: [],
  stopReason: 'stop',
  model: 'm',
  timestamp,
  usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
});

describe('BotUsageService', () => {
  it('ranks members over the selected range and leaves Code sessions out', async () => {
    const { service } = setup();
    const rows = await service.summary(7);
    expect(rows.map((row) => [row.botId, row.name, row.tokens, row.sessions])).toEqual([
      ['bob', 'BOB', 300, 1],
      ['alice', 'ALICE', 250, 3],
    ]);
    expect((await service.summary(1)).find((row) => row.botId === 'alice')?.tokens).toBe(100);
  });

  it('reports today / 7 / 30 day windows per member', async () => {
    const { service } = setup({ alice: { dailyTokens: 100 } });
    const overview = await service.overview();
    expect(overview.bots.alice.today.tokens).toBe(100);
    expect(overview.bots.alice.week.tokens).toBe(250);
    expect(overview.bots.alice.today.cost).toBeCloseTo(100 / 1_000_000);
    expect(overview.bots.alice.exhausted).toBe('tokens');
    expect(overview.bots.bob.exhausted).toBeUndefined();
  });

  it('checks only today against the budget and skips reads when unlimited', async () => {
    const { service, loaded } = setup({ bob: { dailyTokens: 301 } });
    expect(await service.exceeded('alice')).toBeNull();
    expect(loaded).toEqual([]);
    expect(await service.exceeded('bob')).toBeNull();
    expect(loaded).toEqual(['/s/child.jsonl']);
    const tight = setup({ bob: { dailyTokens: 300 }, alice: { dailyTokens: 101 } });
    expect(await tight.service.exceeded('bob')).toBe('tokens');
    // 昨天 23:59:59 的用量不计入今天
    expect(await tight.service.exceeded('alice')).toBeNull();
  });

  it('reads a member’s sessions once, then counts finished messages in memory without double counting', async () => {
    const { service, loaded } = setup({ alice: { dailyTokens: 300 } });
    // 账本未建立前的消息不记（之后从 jsonl 读到）
    service.record('alice', 'dm', 7, assistant(TODAY + 1000, 100));
    await service.prepare('alice');
    expect(loaded).toEqual(['/s/dm.jsonl', '/s/group.jsonl']);
    expect(service.verdict('alice', 0)).toBeNull();
    // 同一条消息（jsonl 已有 / 重复 upsert）只计一次
    service.record('alice', 'dm', 7, assistant(TODAY + 1000, 100));
    service.record('alice', 'group', 3, assistant(TODAY + 2000, 150));
    service.record('alice', 'group', 3, assistant(TODAY + 2000, 150));
    expect(service.verdict('alice', 0)).toBeNull();
    service.record('alice', 'group', 4, assistant(TODAY + 3000, 50));
    expect(service.verdict('alice', 0)).toBe('tokens');
    await service.prepare('alice');
    expect(await service.exceeded('alice')).toBe('tokens');
    expect(loaded).toHaveLength(2);
  });

  it('counts messages that finish while the first read is in flight', async () => {
    const { service, gate, release } = setup({ alice: { dailyTokens: 201 } });
    gate.hold = true;
    const ready = service.prepare('alice');
    await Promise.resolve();
    service.record('alice', 'dm', 9, assistant(TODAY + 4000, 100));
    release();
    await ready;
    expect(service.verdict('alice', 0)).toBeNull();
    service.record('alice', 'dm', 10, assistant(TODAY + 5000, 1));
    expect(service.verdict('alice', 0)).toBe('tokens');
  });

  it('rolls over at local midnight without rereading files', async () => {
    const clock = { now: NOW };
    const { service, loaded } = setup({ alice: { dailyTokens: 150 } }, clock);
    await service.prepare('alice');
    service.record('alice', 'dm', 7, assistant(TODAY + 2000, 100));
    expect(service.verdict('alice', 0)).toBe('tokens');
    clock.now = NOW + DAY;
    await service.prepare('alice');
    expect(service.verdict('alice', 0)).toBeNull();
    service.record('alice', 'dm', 8, assistant(TODAY + DAY + 1, 150));
    expect(service.verdict('alice', 0)).toBe('tokens');
    // 迟到的昨日消息不算今天
    service.record('alice', 'dm', 6, assistant(TODAY + 10, 999));
    expect(loaded).toHaveLength(2);
  });

  it('adds reserved tokens (and their estimated cost) to today’s usage', async () => {
    const { service } = setup({
      alice: { dailyTokens: 1000 },
      bob: { dailyCostUsd: 0.01 },
    });
    await service.prepare('alice');
    expect(service.verdict('alice', 899)).toBeNull();
    expect(service.verdict('alice', 900)).toBe('tokens');
    await service.prepare('bob');
    // 今日 300 tokens 按 m 定价 = 0.0003 USD；预留按同一费率估算
    expect(service.verdict('bob', 9000)).toBeNull();
    expect(service.verdict('bob', 9800)).toBe('cost');
  });
});

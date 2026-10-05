import { describe, expect, it } from 'vitest';
import {
  BOT_ROUTING_DEFAULTS,
  checkBotName,
  parseBotBudget,
  parseBotChat,
  parseBotProfile,
  parseGroupEntry,
} from './bot';

const BOT_A = '11111111-1111-4111-8111-111111111111';
const BOT_B = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';

const profile = {
  id: BOT_A,
  name: '林经理',
  title: '项目经理',
  scope: '拆分任务、协调进度',
  avatar: { color: '#7c5cff' },
  approvalMode: 'full',
  tools: 'readonly',
  skillIds: ['s1'],
  mcpServerIds: [],
  delegation: { canDelegateTo: 'any', acceptFrom: [BOT_B] },
  memory: { enabled: true },
  createdAt: 1,
  updatedAt: 2,
  version: 1,
};

describe('parseBotProfile', () => {
  it('accepts a complete profile', () => {
    expect(parseBotProfile(profile)).toEqual(profile);
  });

  it('fills defaults for optional fields', () => {
    const parsed = parseBotProfile({ id: BOT_A, name: 'Alice', createdAt: 1, updatedAt: 1 });
    expect(parsed).toMatchObject({
      title: '',
      scope: '',
      approvalMode: 'full',
      tools: 'all',
      skillIds: [],
      mcpServerIds: [],
      delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
      memory: { enabled: true },
      version: 0,
    });
    expect(parsed?.avatar.color).toMatch(/^#[0-9a-f]{6}$/u);
    expect(parsed?.engine).toBeUndefined();
  });

  it('treats legacy profiles without budget as unlimited', () => {
    expect(parseBotProfile(profile)?.budget).toBeUndefined();
  });

  it('keeps a positive integer delegation timeout within a day and drops the rest', () => {
    expect(parseBotProfile({ ...profile, delegationTimeoutMinutes: 30 })).toMatchObject({
      delegationTimeoutMinutes: 30,
    });
    for (const bad of [0, -1, 1.5, 1441, '30', null])
      expect(parseBotProfile({ ...profile, delegationTimeoutMinutes: bad })).not.toHaveProperty(
        'delegationTimeoutMinutes'
      );
  });

  it('keeps a positive integer per-turn token cap and drops the rest', () => {
    expect(parseBotProfile({ ...profile, maxTokensPerTurn: 50_000 })).toMatchObject({
      maxTokensPerTurn: 50_000,
    });
    for (const bad of [0, -1, 1.5, '100', null, Number.MAX_VALUE])
      expect(parseBotProfile({ ...profile, maxTokensPerTurn: bad })).not.toHaveProperty(
        'maxTokensPerTurn'
      );
  });

  it('keeps a positive daily budget and drops invalid caps', () => {
    expect(
      parseBotProfile({ ...profile, budget: { dailyCostUsd: 0.5, dailyTokens: 2000 } })?.budget
    ).toEqual({ dailyCostUsd: 0.5, dailyTokens: 2000 });
    expect(parseBotProfile({ ...profile, budget: { dailyTokens: 1.5 } })?.budget).toBeUndefined();
    expect(parseBotBudget({ dailyCostUsd: -1, dailyTokens: 10 })).toEqual({ dailyTokens: 10 });
    for (const bad of [null, 'x', [], {}, { dailyCostUsd: 0 }, { dailyTokens: Number.NaN }])
      expect(parseBotBudget(bad)).toBeUndefined();
  });

  it('keeps a valid engine and drops an invalid thinking level', () => {
    expect(
      parseBotProfile({
        ...profile,
        engine: { providerId: 'p', modelId: 'm', thinkingLevel: 'high' },
      })?.engine
    ).toEqual({ providerId: 'p', modelId: 'm', thinkingLevel: 'high' });
    expect(
      parseBotProfile({ ...profile, engine: { providerId: 'p', modelId: 'm', thinkingLevel: 'x' } })
        ?.engine
    ).toEqual({ providerId: 'p', modelId: 'm' });
    expect(
      parseBotProfile({ ...profile, engine: { providerId: '', modelId: 'm' } })?.engine
    ).toBeUndefined();
  });

  it('rejects dirty input', () => {
    for (const bad of [
      null,
      1,
      'x',
      [],
      {},
      { ...profile, id: 'nope' },
      { ...profile, name: 'a b' },
    ]) {
      expect(parseBotProfile(bad)).toBeUndefined();
    }
  });

  it('falls back on bad enum and list values instead of rejecting', () => {
    const parsed = parseBotProfile({
      ...profile,
      approvalMode: 'yolo',
      tools: 'some',
      skillIds: ['ok', 3, null],
      delegation: { canDelegateTo: ['not-a-uuid', BOT_B], acceptFrom: 5 },
      archivedAt: 'yesterday',
    });
    expect(parsed).toMatchObject({
      approvalMode: 'full',
      tools: 'all',
      skillIds: ['ok'],
      delegation: { canDelegateTo: [BOT_B], acceptFrom: 'any' },
    });
    expect(parsed?.archivedAt).toBeUndefined();
  });
});

describe('checkBotName', () => {
  const others = [{ id: BOT_B, name: 'Alice' }];

  it('normalizes and accepts unique names', () => {
    expect(checkBotName('  林经理 ', others, [])).toEqual({ ok: true, name: '林经理' });
    expect(checkBotName('dev_ops-2', others, [])).toEqual({ ok: true, name: 'dev_ops-2' });
  });

  it('rejects malformed names', () => {
    for (const bad of ['', '   ', 'a b', '@alice', 'a'.repeat(25), 'x\ny']) {
      expect(checkBotName(bad, others, [])).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('rejects duplicates case-insensitively but allows renaming self', () => {
    expect(checkBotName('ALICE', others, [])).toEqual({ ok: false, reason: 'duplicate' });
    expect(checkBotName('alice', others, [], BOT_B)).toEqual({ ok: true, name: 'alice' });
  });

  it('rejects reserved mentions and agent type names', () => {
    expect(checkBotName('所有人', [], [])).toEqual({ ok: false, reason: 'reserved' });
    expect(checkBotName('Everyone', [], [])).toEqual({ ok: false, reason: 'reserved' });
    expect(checkBotName('Scout', [], ['scout'])).toEqual({ ok: false, reason: 'reserved' });
  });
});

describe('parseBotChat', () => {
  const group = {
    id: CHAT,
    kind: 'group',
    title: '发布小组',
    members: [BOT_A, BOT_B],
    bossBotId: BOT_A,
    workspace: { kind: 'project', projectId: 'p1' },
    routing: { mode: 'smart', maxHops: 4, maxTurnsPerBot: 2 },
    pinned: false,
    sessions: { [BOT_A]: { conversationId: 'c1', cursor: 3 } },
    createdAt: 1,
    updatedAt: 1,
    version: 2,
  };

  it('accepts a group chat', () => {
    expect(parseBotChat(group)).toEqual(group);
  });

  it('keeps settle / snooze times and the pin order only while pinned', () => {
    expect(parseBotChat({ ...group, settledAt: 5, snoozedUntil: 9, pinOrder: 2 })).toMatchObject({
      settledAt: 5,
      snoozedUntil: 9,
    });
    expect(parseBotChat({ ...group, pinOrder: 2 })?.pinOrder).toBeUndefined();
    expect(parseBotChat({ ...group, pinned: true, pinOrder: 2 })?.pinOrder).toBe(2);
    const dirty = parseBotChat({ ...group, pinned: true, pinOrder: -1, settledAt: 'x' });
    expect(dirty?.pinOrder).toBeUndefined();
    expect(dirty?.settledAt).toBeUndefined();
  });

  it('accepts a direct chat with member home', () => {
    const direct = {
      ...group,
      kind: 'direct',
      members: [BOT_A],
      bossBotId: null,
      workspace: { kind: 'member-home' },
      sessions: {},
    };
    expect(parseBotChat(direct)).toMatchObject({ kind: 'direct', members: [BOT_A] });
  });

  it('rejects structurally inconsistent chats', () => {
    const bad = [
      { ...group, members: [BOT_A] },
      { ...group, members: [BOT_A, BOT_A] },
      { ...group, bossBotId: '44444444-4444-4444-8444-444444444444' },
      { ...group, workspace: { kind: 'member-home' } },
      { ...group, kind: 'direct' },
      {
        ...group,
        kind: 'direct',
        members: [BOT_A],
        bossBotId: null,
        workspace: { kind: 'chat-home', projectId: 'p' },
      },
      { ...group, id: 'x' },
      { ...group, workspace: { kind: 'project', projectId: '' } },
    ];
    for (const value of bad) expect(parseBotChat(value)).toBeUndefined();
  });

  it('clamps routing and drops bad session entries', () => {
    const parsed = parseBotChat({
      ...group,
      routing: { maxHops: 999, maxTurnsPerBot: 'x' },
      sessions: {
        [BOT_A]: { conversationId: 'c1', cursor: -5 },
        [BOT_B]: { conversationId: '', cursor: 1 },
        stranger: { conversationId: 'c3', cursor: 1 },
      },
    });
    expect(parsed?.routing).toEqual({
      mode: 'boss',
      maxHops: 20,
      maxTurnsPerBot: BOT_ROUTING_DEFAULTS.maxTurnsPerBot,
    });
    expect(parsed?.sessions).toEqual({ [BOT_A]: { conversationId: 'c1', cursor: 0 } });
  });

  it('routing.mode 缺省或非法时为 boss（旧数据不变）', () => {
    expect(parseBotChat({ ...group, routing: { maxHops: 4 } })?.routing.mode).toBe('boss');
    expect(parseBotChat({ ...group, routing: { mode: 'x' } })?.routing.mode).toBe('boss');
    expect(parseBotChat({ ...group, routing: undefined })?.routing.mode).toBe('boss');
  });

  it('routing.muted 只保留在群的非群主成员并去重，为空时省略', () => {
    const parse = (muted: unknown) =>
      parseBotChat({ ...group, routing: { ...group.routing, muted } });
    expect(parse([BOT_B, BOT_B, BOT_A, 'ghost', 3])?.routing.muted).toEqual([BOT_B]);
    expect(parse([BOT_A])?.routing).not.toHaveProperty('muted');
    expect(parse('x')?.routing).not.toHaveProperty('muted');
    expect(parseBotChat(group)?.routing).not.toHaveProperty('muted');
  });

  it('preserves valid distillation watermarks and drops malformed ones', () => {
    for (const distilledTo of ['entry-7', '', 42, null]) {
      const parsed = parseBotChat({
        ...group,
        sessions: { [BOT_A]: { conversationId: 'c1', cursor: 3, distilledTo } },
      });
      expect(parsed?.sessions[BOT_A]).toEqual({
        conversationId: 'c1',
        cursor: 3,
        ...(distilledTo === 'entry-7' ? { distilledTo } : {}),
      });
    }
  });
});

describe('parseGroupEntry', () => {
  it('accepts each entry kind', () => {
    const entries = [
      { seq: 1, id: 'e1', at: 1, kind: 'human', text: 'hi', mentions: [BOT_A] },
      {
        seq: 2,
        id: 'e2',
        at: 2,
        kind: 'bot',
        botId: BOT_A,
        text: 'yo',
        conversationId: 'c1',
        turnId: 't1',
      },
      {
        seq: 3,
        id: 'e3',
        at: 3,
        kind: 'delegation',
        delegationId: 'd1',
        from: BOT_A,
        to: BOT_B,
        state: 'running',
      },
      { seq: 4, id: 'e4', at: 4, kind: 'system', text: 'limit reached' },
      { seq: 5, id: 'e5', at: 5, kind: 'system', text: '新对话', newConversation: true },
    ];
    for (const entry of entries) expect(parseGroupEntry(entry)).toEqual(entry);
    expect(
      parseGroupEntry({ seq: 6, id: 'e6', at: 6, kind: 'system', text: 'x', newConversation: 1 })
    ).toEqual({ seq: 6, id: 'e6', at: 6, kind: 'system', text: 'x' });
  });

  it('rejects dirty entries', () => {
    for (const bad of [
      null,
      { seq: -1, id: 'e', at: 1, kind: 'system', text: 'x' },
      { seq: 1.5, id: 'e', at: 1, kind: 'system', text: 'x' },
      { seq: 1, id: '', at: 1, kind: 'system', text: 'x' },
      { seq: 1, id: 'e', at: 1, kind: 'bot', text: 'x' },
      {
        seq: 1,
        id: 'e',
        at: 1,
        kind: 'delegation',
        delegationId: 'd',
        from: BOT_A,
        to: BOT_B,
        state: 'weird',
      },
      { seq: 1, id: 'e', at: 1, kind: 'nope', text: 'x' },
    ]) {
      expect(parseGroupEntry(bad)).toBeUndefined();
    }
  });

  it('drops non-string mentions', () => {
    expect(
      parseGroupEntry({ seq: 1, id: 'e', at: 1, kind: 'human', text: 'x', mentions: [BOT_A, 2] })
    ).toMatchObject({ mentions: [BOT_A] });
  });

  it('human 条目只保留合法的 media 图片 id', () => {
    const id = `${'a'.repeat(64)}.png`;
    expect(
      parseGroupEntry({
        seq: 1,
        id: 'e',
        at: 1,
        kind: 'human',
        text: '',
        mentions: [],
        images: [id, '../x.png', 3],
      })
    ).toMatchObject({ images: [id] });
    expect(
      parseGroupEntry({
        seq: 1,
        id: 'e',
        at: 1,
        kind: 'human',
        text: 'x',
        mentions: [],
        images: [],
      })
    ).not.toHaveProperty('images');
  });

  it('bot 条目保留 routedBy: smart，其余值丢弃', () => {
    const base = {
      seq: 2,
      id: 'e2',
      at: 2,
      kind: 'bot',
      botId: BOT_A,
      text: 'yo',
      conversationId: 'c1',
      turnId: 't1',
    };
    expect(parseGroupEntry({ ...base, routedBy: 'smart' })).toEqual({ ...base, routedBy: 'smart' });
    expect(parseGroupEntry({ ...base, routedBy: 'other' })).toEqual(base);
    for (const routedBy of ['smart:build', 'smart:answer', 'smart:discuss', 'summary'])
      expect(parseGroupEntry({ ...base, routedBy })).toEqual({ ...base, routedBy });
    expect(parseGroupEntry({ ...base, routedBy: 'smart:x' })).toEqual(base);
  });

  it('bot 条目保留非空 model，其余丢弃', () => {
    const base = {
      seq: 2,
      id: 'e2',
      at: 2,
      kind: 'bot',
      botId: BOT_A,
      text: 'yo',
      conversationId: 'c1',
      turnId: 't1',
    };
    expect(parseGroupEntry({ ...base, model: 'glm-5.3' })).toEqual({ ...base, model: 'glm-5.3' });
    expect(parseGroupEntry({ ...base, model: '' })).toEqual(base);
    expect(parseGroupEntry({ ...base, model: 3 })).toEqual(base);
  });
});

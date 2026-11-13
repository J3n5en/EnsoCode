import { describe, expect, it } from 'vitest';
import { parseDispatchFile, parseProfile, parseSchedules, parseTodos } from './parse';

describe('parseProfile', () => {
  it('treats a missing or non-object value as not configured', () => {
    expect(parseProfile(undefined)).toBeNull();
    expect(parseProfile([])).toBeNull();
    expect(parseProfile('{}')).toBeNull();
  });

  it('fills every default for an empty record', () => {
    expect(parseProfile({})).toEqual({
      version: 1,
      name: '秘书',
      avatar: { color: '#7c5cff' },
      autonomy: 'ask-first',
      autoApproveProjectIds: [],
      visibleProjectIds: 'all',
      dispatchModel: { mode: 'project' },
      dispatchWorktree: 'auto',
      maxRunningDispatches: 3,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'needs-user',
      updatedAt: 0,
    });
  });

  it('keeps valid values and drops unknown keys', () => {
    const profile = parseProfile({
      name: '小秘',
      avatar: { color: '#0EA5E9', imageVersion: 2 },
      model: { providerId: 'openai', modelId: 'gpt', thinkingLevel: 'max' },
      autonomy: 'full',
      autoApproveProjectIds: ['p1', 'p1', 7],
      visibleProjectIds: ['p1'],
      dispatchModel: {
        mode: 'fixed',
        model: { providerId: 'anthropic', modelId: 'claude', thinkingLevel: 'high' },
      },
      dispatchWorktree: 'always',
      maxRunningDispatches: 5,
      addressAs: '老板',
      replyLanguage: 'zh',
      style: 'detailed',
      notify: 'off',
      dailyBriefAt: '09:05',
      updatedAt: 1700000000000,
      unknown: true,
    });
    expect(profile).toEqual({
      version: 1,
      name: '小秘',
      avatar: { color: '#0EA5E9', imageVersion: 2 },
      model: { providerId: 'openai', modelId: 'gpt', thinkingLevel: 'max' },
      autonomy: 'full',
      autoApproveProjectIds: ['p1'],
      visibleProjectIds: ['p1'],
      dispatchModel: {
        mode: 'fixed',
        model: { providerId: 'anthropic', modelId: 'claude' },
      },
      dispatchWorktree: 'always',
      maxRunningDispatches: 5,
      addressAs: '老板',
      replyLanguage: 'zh',
      style: 'detailed',
      notify: 'off',
      dailyBriefAt: '09:05',
      updatedAt: 1700000000000,
    });
  });

  it('normalizes out-of-range and mistyped values', () => {
    const profile = parseProfile({
      name: '   ',
      avatar: { color: 'red', imageVersion: 0 },
      model: { providerId: '', modelId: 'claude' },
      autonomy: 'boss',
      visibleProjectIds: 'none',
      dispatchModel: { mode: 'fixed' },
      dispatchWorktree: 'sometimes',
      maxRunningDispatches: 99,
      replyLanguage: 'fr',
      style: 'verbose',
      notify: 'always',
      dailyBriefAt: '9:5',
      updatedAt: 'now',
    });
    expect(profile).toMatchObject({
      name: '秘书',
      avatar: { color: '#7c5cff' },
      autonomy: 'ask-first',
      visibleProjectIds: 'all',
      dispatchModel: { mode: 'project' },
      dispatchWorktree: 'auto',
      maxRunningDispatches: 10,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'needs-user',
      updatedAt: 0,
    });
    expect(profile).not.toHaveProperty('model');
    expect(profile).not.toHaveProperty('dailyBriefAt');
    expect(profile?.avatar).not.toHaveProperty('imageVersion');
  });

  it('clamps the concurrency limit into 1..10', () => {
    expect(parseProfile({ maxRunningDispatches: 0 })?.maxRunningDispatches).toBe(1);
    expect(parseProfile({ maxRunningDispatches: -3 })?.maxRunningDispatches).toBe(1);
    expect(parseProfile({ maxRunningDispatches: 2.6 })?.maxRunningDispatches).toBe(3);
    expect(parseProfile({ maxRunningDispatches: Number.NaN })?.maxRunningDispatches).toBe(3);
  });

  it('falls back to project mode for unusable dispatch model choices', () => {
    expect(
      parseProfile({ dispatchModel: { mode: 'choose', candidates: [] } })?.dispatchModel
    ).toEqual({ mode: 'project' });
    expect(
      parseProfile({
        dispatchModel: {
          mode: 'choose',
          candidates: [{ providerId: 'a', modelId: 'b' }, { providerId: 'a' }],
        },
      })?.dispatchModel
    ).toEqual({ mode: 'choose', candidates: [{ providerId: 'a', modelId: 'b' }] });
  });
});

describe('parseDispatchFile', () => {
  it('returns an empty file for garbage input', () => {
    expect(parseDispatchFile(undefined)).toEqual({
      version: 1,
      dispatched: {},
      named: [],
      proposals: {},
      outbox: [],
    });
    expect(parseDispatchFile({ dispatched: [], proposals: 'x', outbox: {} })).toEqual({
      version: 1,
      dispatched: {},
      named: [],
      proposals: {},
      outbox: [],
    });
  });

  it('keeps valid records and drops the broken ones one by one', () => {
    const file = parseDispatchFile({
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 's1',
          createdAt: 10,
          turn: 2,
          lastState: 'running',
          lastEventAt: 20,
          lastResult: { kind: 'goal-complete', turn: 2, at: 30 },
        },
        c2: { conversationId: 'c2', lastState: 'sleeping' },
      },
      named: ['c1', 'c1', '', 5],
      proposals: {
        ok: {
          id: 'ok',
          secretaryConversationId: 's1',
          createdAt: 1,
          updatedAt: 2,
          status: 'pending',
          kind: 'dispatch',
          draft: { projectId: 'p1', prompt: '写测试', worktree: true },
        },
        badStatus: {
          id: 'badStatus',
          secretaryConversationId: 's1',
          createdAt: 1,
          updatedAt: 2,
          status: 'done',
          kind: 'dispatch',
          draft: { projectId: 'p1', prompt: 'x', worktree: false },
        },
        noDraft: {
          id: 'noDraft',
          secretaryConversationId: 's1',
          createdAt: 1,
          updatedAt: 2,
          status: 'pending',
          kind: 'dispatch',
        },
      },
      outbox: [
        { key: 'k1', at: 5, text: '完成', kind: 'goal-complete', conversationId: 'c1' },
        { key: 'k2', at: 6, text: '提案', kind: 'proposal', proposalId: 'ok', status: 'pending' },
        { key: 'k3', at: 7, text: '没有目标', kind: 'proposal' },
        { key: 'k4', at: 8, text: '未知类型', kind: 'nope' },
      ],
    });
    expect(Object.keys(file.dispatched)).toEqual(['c1']);
    expect(file.dispatched.c1).toMatchObject({ turn: 2, lastState: 'running' });
    expect(file.named).toEqual(['c1']);
    expect(Object.keys(file.proposals)).toEqual(['ok']);
    expect(file.outbox.map((update) => update.key)).toEqual(['k1', 'k2']);
  });

  it('normalizes counters and keeps the in-flight delivery within bounds', () => {
    const file = parseDispatchFile({
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 's1',
          createdAt: 10,
          turn: -4,
          lastState: 'idle',
          lastEventAt: 20,
          stalledTurn: 0,
        },
      },
      inflight: {
        deliveryId: 'd1',
        secretaryConversationId: 's1',
        keys: ['k1', 'k1'],
        attempt: 9,
        nextAttemptAt: 30,
        settled: true,
      },
    });
    expect(file.dispatched.c1?.turn).toBe(0);
    expect(file.dispatched.c1).not.toHaveProperty('stalledTurn');
    expect(file.inflight).toEqual({
      deliveryId: 'd1',
      secretaryConversationId: 's1',
      keys: ['k1'],
      attempt: 6,
      nextAttemptAt: 30,
      settled: true,
    });
    expect(parseDispatchFile({ inflight: { attempt: 0 } }).inflight).toBeUndefined();
    expect(
      parseDispatchFile({
        inflight: { deliveryId: 'd', secretaryConversationId: 's', attempt: 0 },
      }).inflight?.attempt
    ).toBe(1);
  });
});

describe('parseTodos', () => {
  it('returns an empty list for garbage input', () => {
    expect(parseTodos(undefined)).toEqual([]);
    expect(parseTodos({ todos: [] })).toEqual([]);
  });

  it('drops items without an id or text', () => {
    expect(
      parseTodos([
        { id: 'a', text: '写周报', createdAt: 1, updatedAt: 2, dueAt: 3, projectId: 'p1' },
        { id: '', text: '没有 id', createdAt: 1, updatedAt: 2 },
        { id: 'b', text: '   ', createdAt: 1, updatedAt: 2 },
        { id: 'c', text: '坏时间', createdAt: 'x', updatedAt: 2 },
        null,
      ])
    ).toEqual([
      {
        id: 'a',
        text: '写周报',
        createdAt: 1,
        updatedAt: 2,
        dueAt: 3,
        projectId: 'p1',
      },
    ]);
  });
});

describe('parseSchedules', () => {
  it('drops entries without a name, prompt or trigger', () => {
    expect(
      parseSchedules([
        { id: 's1', name: '日报', prompt: '总结今天', cron: '0 9 * * *', createdAt: 1 },
        { id: 's1', name: '日报', prompt: '总结今天', cron: '0 9 * * *', createdAt: 1 },
        { id: 's2', name: '', prompt: 'x', at: '2026-11-13T09:00:00.000Z', createdAt: 1 },
        { id: 's3', name: 'a', prompt: 'x', createdAt: 1 },
        { id: 's4', name: 'a', prompt: 'x', at: '明天', createdAt: 1 },
        {
          id: 's5',
          name: '待办提醒',
          prompt: '提醒',
          at: '2026-11-13T09:00:00.000Z',
          createdAt: 1,
          lastFiredAt: 2,
          system: { todoId: 't1' },
        },
        {
          id: 's6',
          name: '简报',
          prompt: '简报',
          cron: '0 9 * * *',
          createdAt: 1,
          system: 'daily-brief',
        },
        {
          id: 's7',
          name: '坏系统',
          prompt: 'x',
          cron: '0 9 * * *',
          createdAt: 1,
          system: 'weekly',
        },
      ])
    ).toEqual([
      { id: 's1', name: '日报', prompt: '总结今天', cron: '0 9 * * *', createdAt: 1 },
      {
        id: 's5',
        name: '待办提醒',
        prompt: '提醒',
        at: '2026-11-13T09:00:00.000Z',
        createdAt: 1,
        lastFiredAt: 2,
        system: { todoId: 't1' },
      },
      {
        id: 's6',
        name: '简报',
        prompt: '简报',
        cron: '0 9 * * *',
        createdAt: 1,
        system: 'daily-brief',
      },
      { id: 's7', name: '坏系统', prompt: 'x', cron: '0 9 * * *', createdAt: 1 },
    ]);
  });
});

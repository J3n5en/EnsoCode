import { describe, expect, it } from 'vitest';
import {
  parseDispatchFile,
  parseProfile,
  parseProfileDraft,
  parseSchedules,
  parseTodos,
} from './parse';

describe('parseProfileDraft', () => {
  it('rejects a non-object draft', () => {
    expect(parseProfileDraft(undefined)).toEqual({ ok: false, error: 'invalid profile' });
    expect(parseProfileDraft([])).toEqual({ ok: false, error: 'invalid profile' });
  });

  it('rejects out-of-range enum values instead of falling back to defaults', () => {
    expect(parseProfileDraft({ notify: 'always' })).toEqual({
      ok: false,
      error: 'invalid notify',
    });
    expect(parseProfileDraft({ replyLanguage: 'fr' })).toEqual({
      ok: false,
      error: 'invalid replyLanguage',
    });
  });

  it('rejects malformed nested values', () => {
    expect(parseProfileDraft({ avatar: { color: 'red' } })).toEqual({
      ok: false,
      error: 'invalid avatar',
    });
    expect(parseProfileDraft({ dailyBriefAt: '9:00' })).toEqual({
      ok: false,
      error: 'invalid dailyBriefAt',
    });
    expect(parseProfileDraft({ maxRunningDispatches: 0 })).toEqual({
      ok: false,
      error: 'invalid maxRunningDispatches',
    });
    expect(parseProfileDraft({ patrolEnabled: 'yes' })).toEqual({
      ok: false,
      error: 'invalid patrolEnabled',
    });
    expect(parseProfileDraft({ visibleProjectIds: 'some' })).toEqual({
      ok: false,
      error: 'invalid visibleProjectIds',
    });
    expect(parseProfileDraft({ takeoverScope: { mode: 'everyone' } })).toEqual({
      ok: false,
      error: 'invalid takeoverScope',
    });
    expect(parseProfileDraft({ takeoverScope: { mode: 'projects' } })).toEqual({
      ok: false,
      error: 'invalid takeoverScope',
    });
  });

  const scopeOf = (value: unknown) => parseProfile(value)?.takeoverScope;

  it('接管范围缺省是「勾选的项目」且一个都不勾，等价于逐个授权', () => {
    expect(scopeOf({})).toEqual({ mode: 'projects', projectIds: [] });
    // 脏值同样回默认，不会把权限悄悄放大成「所有可见项目」
    expect(scopeOf({ takeoverScope: { mode: 'all-ish' } })).toEqual({
      mode: 'projects',
      projectIds: [],
    });
    expect(scopeOf({ takeoverScope: 'all' })).toEqual({ mode: 'projects', projectIds: [] });
  });

  it('接管范围读回三种取值，草案越界当场拒绝', () => {
    expect(scopeOf({ takeoverScope: { mode: 'explicit' } })).toEqual({ mode: 'explicit' });
    expect(scopeOf({ takeoverScope: { mode: 'all' } })).toEqual({ mode: 'all' });
    expect(scopeOf({ takeoverScope: { mode: 'projects', projectIds: ['p1', 'p1', 3] } })).toEqual({
      mode: 'projects',
      projectIds: ['p1'],
    });
    expect(parseProfileDraft({ takeoverScope: { mode: 'all' } })).toEqual({
      ok: true,
      draft: { takeoverScope: { mode: 'all' } },
    });
    expect(parseProfileDraft({ takeoverScope: { mode: 'projects', projectIds: ['p1'] } })).toEqual({
      ok: true,
      draft: { takeoverScope: { mode: 'projects', projectIds: ['p1'] } },
    });
  });

  it('已删除的设置项出现在草案里一律忽略，不报错也不写进档案', () => {
    expect(
      parseProfileDraft({
        name: '小秘',
        model: { providerId: 'gone', modelId: 'm' },
        autonomy: 'god',
        autoApproveProjectIds: [7],
        dispatchModel: { mode: 'fixed' },
        dispatchWorktree: 'sometimes',
        patrolIntervalMinutes: 999,
        patrolIdleGoalMinutes: 0,
        orphanTaskPatrol: 'no',
        dispatchMuted: false,
        dispatchUnattended: false,
      })
    ).toEqual({ ok: true, draft: { name: '小秘' } });
  });

  it('keeps only known keys and allows null to clear optional ones', () => {
    expect(
      parseProfileDraft({
        name: ' 小秘 ',
        patrolEnabled: false,
        dailyBriefAt: null,
        addressAs: null,
        junk: 1,
      })
    ).toEqual({
      ok: true,
      draft: { name: '小秘', patrolEnabled: false, dailyBriefAt: null, addressAs: null },
    });
  });

  it('drops avatar image paths and versions from a draft', () => {
    expect(
      parseProfileDraft({
        avatar: { color: '#ABCDEF', imageVersion: 4, image: '/etc/passwd', path: '../a.png' },
      })
    ).toEqual({ ok: true, draft: { avatar: { color: '#ABCDEF' } } });
    expect(parseProfileDraft({ avatar: { image: '/etc/passwd' } })).toEqual({
      ok: true,
      draft: {},
    });
  });

  it('narrows the checked plugin ids to a deduped string list', () => {
    expect(parseProfileDraft({ pluginIds: ['enso.tgclient', 'enso.tgclient'] })).toEqual({
      ok: true,
      draft: { pluginIds: ['enso.tgclient'] },
    });
    expect(parseProfileDraft({ pluginIds: ['enso.tgclient', 7] })).toEqual({
      ok: false,
      error: 'invalid pluginIds',
    });
  });

  it('narrows the checked skill ids the same way', () => {
    expect(parseProfileDraft({ skillIds: ['s1', 's1'] })).toEqual({
      ok: true,
      draft: { skillIds: ['s1'] },
    });
    expect(parseProfileDraft({ skillIds: [7] })).toEqual({
      ok: false,
      error: 'invalid skillIds',
    });
  });
});

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
      takeoverScope: { mode: 'projects', projectIds: [] },
      pluginIds: [],
      skillIds: [],
      visibleProjectIds: 'all',
      maxRunningDispatches: 3,
      patrolEnabled: true,
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
      visibleProjectIds: ['p1'],
      maxRunningDispatches: 5,
      patrolEnabled: false,
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
      takeoverScope: { mode: 'projects', projectIds: [] },
      pluginIds: [],
      skillIds: [],
      visibleProjectIds: ['p1'],
      maxRunningDispatches: 5,
      patrolEnabled: false,
      addressAs: '老板',
      replyLanguage: 'zh',
      style: 'detailed',
      notify: 'off',
      dailyBriefAt: '09:05',
      updatedAt: 1700000000000,
    });
  });

  it('旧档案里已删除的设置项读进来不报错，直接丢掉', () => {
    const old = {
      name: '小秘',
      model: { providerId: 'removed-provider', modelId: 'gpt', thinkingLevel: 'max' },
      autonomy: 'ask-first',
      autoApproveProjectIds: ['p1'],
      dispatchModel: { mode: 'fixed', model: { providerId: 'a', modelId: 'b' } },
      dispatchWorktree: 'never',
      patrolEnabled: true,
      patrolIntervalMinutes: 60,
      patrolIdleGoalMinutes: 10,
      orphanTaskPatrol: false,
      dispatchMuted: false,
      dispatchUnattended: false,
    };
    const profile = parseProfile(old);
    expect(profile).toMatchObject({ name: '小秘', patrolEnabled: true });
    for (const key of [
      'model',
      'autonomy',
      'autoApproveProjectIds',
      'dispatchModel',
      'dispatchWorktree',
      'patrolIntervalMinutes',
      'patrolIdleGoalMinutes',
      'orphanTaskPatrol',
      'dispatchMuted',
      'dispatchUnattended',
    ]) {
      expect(profile).not.toHaveProperty(key);
    }
  });

  it('normalizes out-of-range and mistyped values', () => {
    const profile = parseProfile({
      name: '   ',
      avatar: { color: 'red', imageVersion: 0 },
      visibleProjectIds: 'none',
      maxRunningDispatches: 99,
      patrolEnabled: 'nope',
      replyLanguage: 'fr',
      style: 'verbose',
      notify: 'always',
      dailyBriefAt: '9:5',
      updatedAt: 'now',
    });
    expect(profile).toMatchObject({
      name: '秘书',
      avatar: { color: '#7c5cff' },
      visibleProjectIds: 'all',
      maxRunningDispatches: 10,
      patrolEnabled: true,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'needs-user',
      updatedAt: 0,
    });
    expect(profile).not.toHaveProperty('dailyBriefAt');
    expect(profile?.avatar).not.toHaveProperty('imageVersion');
  });

  it('keeps only a well-formed avatar hash, and only with a version', () => {
    expect(
      parseProfile({ avatar: { color: '#0EA5E9', imageVersion: 2, imageHash: 'a1b2c3d4' } })?.avatar
    ).toEqual({ color: '#0EA5E9', imageVersion: 2, imageHash: 'a1b2c3d4' });
    // 脏值丢掉，不影响版本号本身
    expect(
      parseProfile({ avatar: { color: '#0EA5E9', imageVersion: 2, imageHash: '../x.png' } })?.avatar
    ).toEqual({ color: '#0EA5E9', imageVersion: 2 });
    // 没有版本号就没有图，指纹也一起丢掉
    expect(parseProfile({ avatar: { color: '#0EA5E9', imageHash: 'a1b2c3d4' } })?.avatar).toEqual({
      color: '#0EA5E9',
    });
  });

  it('clamps the concurrency limit into 1..10', () => {
    expect(parseProfile({ maxRunningDispatches: 0 })?.maxRunningDispatches).toBe(1);
    expect(parseProfile({ maxRunningDispatches: -3 })?.maxRunningDispatches).toBe(1);
    expect(parseProfile({ maxRunningDispatches: 2.6 })?.maxRunningDispatches).toBe(3);
    expect(parseProfile({ maxRunningDispatches: Number.NaN })?.maxRunningDispatches).toBe(3);
  });

  it('keeps the checked plugin ids, dropping junk and repeats', () => {
    expect(
      parseProfile({ pluginIds: ['enso.tgclient', 'enso.tgclient', 7, '', null] })?.pluginIds
    ).toEqual(['enso.tgclient']);
    expect(parseProfile({ pluginIds: 'enso.tgclient' })?.pluginIds).toEqual([]);
  });

  it('keeps the checked skill ids and defaults an old profile to none', () => {
    expect(parseProfile({ skillIds: ['s1', 's1', 7] })?.skillIds).toEqual(['s1']);
    expect(parseProfile({ name: '旧档案' })?.skillIds).toEqual([]);
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

  it('自动归档标记读回来还在：重启后仍分得清自动归档与手动归档', () => {
    const file = parseDispatchFile({
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 's1',
          createdAt: 10,
          lastEventAt: 10,
          lastState: 'idle',
          autoArchivedAt: 30,
          autoArchiveResultAt: 20,
        },
      },
    });
    expect(file.dispatched.c1).toMatchObject({ autoArchivedAt: 30, autoArchiveResultAt: 20 });
  });

  it('秘书归档的来源读回来还在，来源不认识的整条丢掉', () => {
    const record = (secretaryArchived: unknown) => ({
      conversationId: 'c1',
      projectId: 'p1',
      secretaryConversationId: 's1',
      createdAt: 10,
      lastEventAt: 10,
      lastState: 'idle',
      secretaryArchived,
    });
    const file = parseDispatchFile({
      dispatched: {
        c1: record({ at: 30, via: 'cleanup_apply' }),
        c2: { ...record({ at: 30, via: 'user' }), conversationId: 'c2' },
      },
    });
    expect(file.dispatched.c1?.secretaryArchived).toEqual({ at: 30, via: 'cleanup_apply' });
    expect(file.dispatched.c2).toBeDefined();
    expect(file.dispatched.c2?.secretaryArchived).toBeUndefined();
  });

  it('手动标记、重新打开、撤销与收掉的目标读回来还在：重启后撤销标记与追加跟踪照常', () => {
    const base = {
      conversationId: 'c1',
      projectId: 'p1',
      secretaryConversationId: 's1',
      createdAt: 10,
      lastEventAt: 10,
      lastState: 'idle',
    };
    const file = parseDispatchFile({
      dispatched: {
        c1: {
          ...base,
          lastResult: { kind: 'goal-complete', turn: 1, at: 20, manual: true },
          closedGoal: { text: '旧目标', status: 'blocked', note: '缺 token' },
        },
        c2: {
          ...base,
          conversationId: 'c2',
          reopenedAt: 30,
          manualUndoneAt: 25,
          failurePending: { at: 40, detail: 'boom' },
        },
        c3: { ...base, conversationId: 'c3', closedGoal: { text: '旧目标', status: 'active' } },
      },
    });
    expect(file.dispatched.c1).toMatchObject({
      lastResult: { kind: 'goal-complete', turn: 1, at: 20, manual: true },
      closedGoal: { text: '旧目标', status: 'blocked', note: '缺 token' },
    });
    expect(file.dispatched.c2).toMatchObject({
      reopenedAt: 30,
      manualUndoneAt: 25,
      failurePending: { at: 40, detail: 'boom' },
    });
    // 只收受阻与暂停的目标：别的状态不认
    expect(file.dispatched.c3.closedGoal).toBeUndefined();
  });

  it('派发记录与提案草案里的模型（含思考档位）读回来还在', () => {
    const file = parseDispatchFile({
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 's1',
          createdAt: 10,
          turn: 1,
          lastState: 'idle',
          lastEventAt: 20,
          model: { providerId: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
        },
        c2: {
          conversationId: 'c2',
          projectId: 'p1',
          secretaryConversationId: 's1',
          createdAt: 10,
          turn: 1,
          lastState: 'idle',
          lastEventAt: 20,
          model: { providerId: 'anthropic' },
        },
      },
      proposals: {
        pr1: {
          id: 'pr1',
          secretaryConversationId: 's1',
          createdAt: 1,
          updatedAt: 2,
          status: 'pending',
          kind: 'dispatch',
          draft: {
            projectId: 'p1',
            prompt: '写测试',
            worktree: false,
            model: { providerId: 'anthropic', modelId: 'opus', thinkingLevel: 'low' },
          },
        },
      },
    });
    expect(file.dispatched.c1.model).toEqual({
      providerId: 'anthropic',
      modelId: 'opus',
      thinkingLevel: 'high',
    });
    // 缺 modelId 的模型整条丢掉，不留下半截引用
    expect(file.dispatched.c2.model).toBeUndefined();
    const proposal = file.proposals.pr1;
    expect(proposal?.kind === 'dispatch' ? proposal.draft.model : undefined).toEqual({
      providerId: 'anthropic',
      modelId: 'opus',
      thinkingLevel: 'low',
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
          stateSince: 15,
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
    expect(file.dispatched.c1).toMatchObject({ turn: 2, lastState: 'running', stateSince: 15 });
    expect(file.named).toEqual(['c1']);
    expect(Object.keys(file.proposals)).toEqual(['ok']);
    expect(file.outbox.map((update) => update.key)).toEqual(['k1', 'k2']);
  });

  it('keeps the untracked list, dropping blanks and duplicates', () => {
    const file = parseDispatchFile({ untracked: ['c1', 'c1', '', 5, 'c2'] });
    expect(file.untracked).toEqual(['c1', 'c2']);
    // 空名单不落字段，旧文件读出来还是原来的形状
    expect(parseDispatchFile({ untracked: [] }).untracked).toBeUndefined();
  });

  it('keeps a skill proposal with its previous content and drops a bad one', () => {
    const base = {
      secretaryConversationId: 's1',
      createdAt: 1,
      updatedAt: 2,
      status: 'pending',
      kind: 'skill',
    };
    const file = parseDispatchFile({
      proposals: {
        ok: {
          ...base,
          id: 'ok',
          draft: { name: 'deploy-check', description: '发布前检查', body: '# 步骤' },
          previous: { description: '旧描述', body: '# 旧步骤' },
        },
        traversal: {
          ...base,
          id: 'traversal',
          draft: { name: '../escape', description: 'x', body: 'y' },
        },
      },
    });
    expect(Object.keys(file.proposals)).toEqual(['ok']);
    expect(file.proposals.ok).toMatchObject({
      kind: 'skill',
      draft: { name: 'deploy-check' },
      previous: { description: '旧描述' },
    });
  });

  it('keeps a tool proposal with its previous draft and drops a bad one', () => {
    const base = {
      secretaryConversationId: 's1',
      createdAt: 1,
      updatedAt: 2,
      status: 'pending',
      kind: 'tool',
    };
    const toolDraft = {
      name: 'upper-text',
      description: '把文本转成大写',
      runtime: 'node',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      readOnly: true,
      code: 'process.stdout.write("x")',
    };
    const file = parseDispatchFile({
      proposals: {
        ok: {
          ...base,
          id: 'ok',
          draft: toolDraft,
          previous: { ...toolDraft, code: 'old' },
        },
        traversal: { ...base, id: 'traversal', draft: { ...toolDraft, name: '../escape' } },
        badRuntime: { ...base, id: 'badRuntime', draft: { ...toolDraft, runtime: 'ruby' } },
      },
    });
    expect(Object.keys(file.proposals)).toEqual(['ok']);
    expect(file.proposals.ok).toMatchObject({
      kind: 'tool',
      draft: { name: 'upper-text', readOnly: true },
      previous: { code: 'old' },
    });
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
        started: true,
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
      started: true,
    });
    expect(parseDispatchFile({ inflight: { attempt: 0 } }).inflight).toBeUndefined();
    expect(
      parseDispatchFile({
        inflight: { deliveryId: 'd', secretaryConversationId: 's', attempt: 0 },
      }).inflight?.attempt
    ).toBe(1);
  });

  it('keeps the dismissed mark on a result', () => {
    const file = parseDispatchFile({
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 's1',
          createdAt: 10,
          turn: 2,
          lastState: 'error',
          lastEventAt: 20,
          lastResult: { kind: 'failed', turn: 1, at: 30, dismissed: true },
        },
      },
    });
    expect(file.dispatched.c1?.lastResult).toEqual({
      kind: 'failed',
      turn: 1,
      at: 30,
      dismissed: true,
    });
  });

  it('keeps a valid takeover mark and a takeover proposal, drops broken ones', () => {
    const record = (conversationId: string, takeover: unknown) => ({
      conversationId,
      projectId: 'p1',
      secretaryConversationId: 's1',
      createdAt: 10,
      turn: 0,
      lastState: 'idle',
      lastEventAt: 10,
      takeover,
    });
    const proposal = (id: string, draft: unknown) => ({
      id,
      secretaryConversationId: 's1',
      createdAt: 1,
      updatedAt: 1,
      status: 'pending',
      kind: 'takeover',
      draft,
    });
    const file = parseDispatchFile({
      dispatched: {
        a: record('a', { grantedAt: 5, via: 'user' }),
        b: record('b', { grantedAt: 5, via: 'secretary' }),
      },
      proposals: {
        ok: proposal('ok', {
          conversationId: 'c9',
          projectId: 'p1',
          title: ' 修 bug ',
          reason: '',
        }),
        bad: proposal('bad', { conversationId: 'c9' }),
      },
    });
    expect(file.dispatched.a?.takeover).toEqual({ grantedAt: 5, via: 'user' });
    // 标记坏了整条不认，不能退化成撤不掉的派出记录
    expect(file.dispatched.b).toBeUndefined();
    expect(file.proposals.ok).toMatchObject({
      kind: 'takeover',
      draft: { conversationId: 'c9', projectId: 'p1', title: '修 bug' },
    });
    expect(file.proposals.ok?.kind === 'takeover' && 'reason' in file.proposals.ok.draft).toBe(
      false
    );
    expect(file.proposals.bad).toBeUndefined();
  });

  it('结构化目标结果往返保留，坏的核验项丢掉，坏的整段不丢记录', () => {
    const goalResult = {
      result: { summary: 'shipped', commits: ['AbC1234'] },
      at: 20,
      checks: [
        { kind: 'commit', ref: 'abc1234', status: 'verified' },
        { kind: 'nope', ref: 'x', status: 'verified' },
      ],
    };
    const base = {
      conversationId: 'c1',
      projectId: 'p1',
      secretaryConversationId: 's1',
      createdAt: 10,
      lastEventAt: 10,
      lastState: 'idle',
    };
    const file = parseDispatchFile({
      dispatched: { c1: { ...base, goalResult } },
      outbox: [
        {
          key: 'c1|goal-complete|1',
          at: 20,
          text: '完成',
          kind: 'goal-complete',
          conversationId: 'c1',
          goalResult,
        },
        {
          key: 'c1|failed|1',
          at: 21,
          text: '失败',
          kind: 'failed',
          conversationId: 'c1',
          goalResult: { result: { commits: ['nope'] }, at: 1 },
        },
      ],
    });
    expect(file.dispatched.c1?.goalResult).toEqual({
      result: { summary: 'shipped', commits: ['abc1234'] },
      at: 20,
      checks: [{ kind: 'commit', ref: 'abc1234', status: 'verified' }],
    });
    expect(file.outbox[0]).toMatchObject({
      goalResult: { result: { commits: ['abc1234'] } },
    });
    expect(file.outbox[1]).toMatchObject({ kind: 'failed' });
    expect(file.outbox[1]).not.toHaveProperty('goalResult');
  });

  it('动态的 needsUser 和 summary 读回来，坏字段丢掉但不丢条目', () => {
    const extra = Array.from({ length: 22 }, (_, index) => `事项${index}`);
    const file = parseDispatchFile({
      activity: [
        {
          at: 1,
          conversationId: 'c1',
          kind: 'goal-complete',
          text: 'noise',
          needsUser: [' 确认 ', '', '   ', 1, '发版', ...extra],
          summary: ' 已完成 ',
        },
        {
          at: 2,
          conversationId: 'c1',
          kind: 'goal-complete',
          text: 'plain',
          needsUser: 'nope',
          summary: '   ',
        },
        { at: 3, conversationId: 'c2', kind: 'not-a-kind', text: 'drop' },
      ],
    });
    expect(file.activity).toHaveLength(2);
    expect(file.activity?.[0]).toEqual({
      at: 1,
      conversationId: 'c1',
      kind: 'goal-complete',
      text: 'noise',
      needsUser: ['确认', '发版', ...extra.slice(0, 18)],
      summary: '已完成',
    });
    expect(file.activity?.[1]).toEqual({
      at: 2,
      conversationId: 'c1',
      kind: 'goal-complete',
      text: 'plain',
    });
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

  it('keeps a known problem code and drops anything else', () => {
    expect(
      parseTodos([
        {
          id: 'a',
          text: '看构建',
          createdAt: 1,
          updatedAt: 2,
          conversationId: 'c1',
          problem: 'failed',
        },
        {
          id: 'b',
          text: '看发布',
          createdAt: 1,
          updatedAt: 2,
          problem: 'nope',
        },
      ])
    ).toEqual([
      {
        id: 'a',
        text: '看构建',
        createdAt: 1,
        updatedAt: 2,
        conversationId: 'c1',
        problem: 'failed',
      },
      { id: 'b', text: '看发布', createdAt: 1, updatedAt: 2 },
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

  it('drops entries that set both at and cron', () => {
    expect(
      parseSchedules([
        {
          id: 'both',
          name: 'a',
          prompt: 'x',
          at: '2026-11-13T09:00:00.000Z',
          cron: '0 9 * * *',
          createdAt: 1,
        },
      ])
    ).toEqual([]);
  });
});

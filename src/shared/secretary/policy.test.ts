import { describe, expect, it } from 'vitest';
import type { ProjectAuthority } from '../types/agent';
import type {
  DispatchDraft,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryProposal,
} from '../types/secretary';
import {
  canOperate,
  dispatchDecision,
  inTakeoverScope,
  operateSource,
  PROPOSAL_TTL_MS,
  pendingProposalMatch,
  pendingProposalNote,
  proposalSignature,
  takeoverRefusal,
  transitionProposal,
  validateDispatch,
  validateDispatchBase,
} from './policy';

function profile(overrides: Partial<SecretaryProfile> = {}): SecretaryProfile {
  return {
    version: 1,
    name: '秘书',
    avatar: { color: '#7c5cff' },
    autonomy: 'ask-first',
    autoApproveProjectIds: [],
    takeoverScope: { mode: 'projects', projectIds: [] },
    visibleProjectIds: 'all',
    dispatchModel: { mode: 'project' },
    dispatchWorktree: 'auto',
    maxRunningDispatches: 3,
    patrolEnabled: true,
    patrolIntervalMinutes: 15,
    dispatchMuted: true,
    dispatchUnattended: true,
    replyLanguage: 'ui',
    style: 'concise',
    notify: 'needs-user',
    updatedAt: 0,
    ...overrides,
  };
}

function project(overrides: Partial<ProjectAuthority> = {}): ProjectAuthority {
  return { projectId: 'p1', canonicalPath: '/p1', state: 'active', version: 1, ...overrides };
}

function draft(overrides: Partial<DispatchDraft> = {}): DispatchDraft {
  return { projectId: 'p1', prompt: '跑一下测试', worktree: false, ...overrides };
}

function proposal(overrides: Partial<SecretaryProposal> = {}): SecretaryProposal {
  return {
    id: 'prop1',
    secretaryConversationId: 'sec1',
    createdAt: 1_000,
    updatedAt: 1_000,
    status: 'pending',
    kind: 'dispatch',
    draft: draft(),
    ...overrides,
  } as SecretaryProposal;
}

function dispatchFile(): SecretaryDispatchFile {
  return {
    version: 1,
    dispatched: {
      conv1: {
        conversationId: 'conv1',
        projectId: 'p1',
        secretaryConversationId: 'sec1',
        createdAt: 1,
        turn: 0,
        lastState: 'running',
        lastEventAt: 1,
      },
    },
    named: ['conv2'],
    proposals: {},
    outbox: [],
  };
}

describe('dispatchDecision', () => {
  it('asks before creating under ask-first even for approved projects', () => {
    const p = profile({ autonomy: 'ask-first', autoApproveProjectIds: ['p1'] });
    expect(dispatchDecision(p, 'p1')).toBe('confirm');
    expect(dispatchDecision(p, 'p2')).toBe('confirm');
  });

  it('creates directly and tells afterwards only for approved projects under tell-after', () => {
    const p = profile({ autonomy: 'tell-after', autoApproveProjectIds: ['p1'] });
    expect(dispatchDecision(p, 'p1')).toBe('direct-tell');
    expect(dispatchDecision(p, 'p2')).toBe('confirm');
  });

  it('creates directly for approved projects under full autonomy', () => {
    const p = profile({ autonomy: 'full', autoApproveProjectIds: ['p1'] });
    expect(dispatchDecision(p, 'p1')).toBe('direct');
    expect(dispatchDecision(p, 'p2')).toBe('confirm');
  });
});

describe('canOperate', () => {
  it('allows dispatched and named conversations only', () => {
    const file = dispatchFile();
    expect(canOperate(file, 'conv1')).toBe(true);
    expect(canOperate(file, 'conv2')).toBe(true);
    expect(canOperate(file, 'conv3')).toBe(false);
  });
});

describe('inTakeoverScope', () => {
  it('treats a missing scope, explicit and an empty selection as one-by-one', () => {
    expect(inTakeoverScope(undefined, 'p1')).toBe(false);
    expect(inTakeoverScope({ mode: 'explicit' }, 'p1')).toBe(false);
    expect(inTakeoverScope({ mode: 'projects', projectIds: [] }, 'p1')).toBe(false);
  });

  it('covers the selected projects only, and every project when set to all', () => {
    const scope = { mode: 'projects' as const, projectIds: ['p1'] };
    expect(inTakeoverScope(scope, 'p1')).toBe(true);
    expect(inTakeoverScope(scope, 'p2')).toBe(false);
    expect(inTakeoverScope(scope, undefined)).toBe(false);
    expect(inTakeoverScope({ mode: 'all' }, 'p2')).toBe(true);
  });
});

describe('operateSource', () => {
  const scope = { mode: 'projects' as const, projectIds: ['p1'] };

  it('reports dispatched, granted and scope, and null without permission', () => {
    const file = dispatchFile();
    expect(operateSource(file, 'conv1', undefined, 'p1')).toBe('dispatched');
    expect(operateSource(file, 'conv2', undefined, 'p1')).toBe('granted');
    expect(operateSource(file, 'conv3', scope, 'p1')).toBe('scope');
    expect(operateSource(file, 'conv3', scope, 'p2')).toBeNull();
    expect(operateSource(file, 'conv3', undefined, 'p1')).toBeNull();
  });

  it('reports a takeover record as granted, not as dispatched', () => {
    const file = dispatchFile();
    file.dispatched.conv1.takeover = { grantedAt: 1, via: 'scope' };
    expect(operateSource(file, 'conv1', undefined, 'p1')).toBe('granted');
  });

  it('不再跟踪的会话失去范围权限，逐个授权的仍然有效', () => {
    const file = dispatchFile();
    file.untracked = ['conv3'];
    expect(operateSource(file, 'conv3', scope, 'p1')).toBeNull();
    // 派出的与点名的授权不受名单影响
    expect(operateSource(file, 'conv1', scope, 'p1')).toBe('dispatched');
    expect(operateSource(file, 'conv2', scope, 'p1')).toBe('granted');
    // 名单只作用于自己，别的会话照旧按范围
    expect(operateSource(file, 'conv4', scope, 'p1')).toBe('scope');
  });
});

describe('takeoverRefusal', () => {
  const target = (overrides: Partial<Parameters<typeof takeoverRefusal>[1]> = {}) => ({
    conversationId: 'conv9',
    conversation: {
      conversationId: 'conv9',
      projectId: 'p1',
      kind: 'root' as const,
      lifecycle: 'ready' as const,
      version: 1,
    },
    project: project(),
    row: { id: 'conv9', projectId: 'p1' } as Record<string, unknown>,
    visible: true,
    ...overrides,
  });

  it('accepts a plain visible root session the user created', () => {
    expect(takeoverRefusal(dispatchFile(), target())).toBeNull();
  });

  it('refuses secretary, bot, child, archived, invisible and already managed sessions', () => {
    const file = dispatchFile();
    const base = target();
    expect(takeoverRefusal(file, target({ conversation: undefined }))).toBe('not-found');
    expect(takeoverRefusal(file, target({ row: undefined }))).toBe('not-found');
    expect(
      takeoverRefusal(
        file,
        target({ conversation: { ...base.conversation, bot: { botId: 'b', chatId: null } } })
      )
    ).toBe('bot-session');
    expect(takeoverRefusal(file, target({ project: project({ kind: 'secretary' }) }))).toBe(
      'secretary-session'
    );
    expect(takeoverRefusal(file, target({ row: { ...base.row, parentId: 'x' } }))).toBe(
      'child-session'
    );
    expect(takeoverRefusal(file, target({ row: { ...base.row, btwParentId: 'x' } }))).toBe(
      'child-session'
    );
    expect(takeoverRefusal(file, target({ row: { ...base.row, archived: true } }))).toBe(
      'archived'
    );
    expect(takeoverRefusal(file, target({ visible: false }))).toBe('not-visible');
    expect(takeoverRefusal(file, target({ conversationId: 'conv1' }))).toBe('already-managed');
    expect(
      takeoverRefusal(
        file,
        target({ row: { ...base.row, secretaryOrigin: { secretaryConversationId: 's' } } })
      )
    ).toBe('already-managed');
  });
});

describe('transitionProposal', () => {
  it('moves pending to executing once', () => {
    const first = transitionProposal(proposal(), { type: 'confirm' }, 2_000);
    expect(first.changed).toBe(true);
    expect(first.proposal.status).toBe('executing');
    expect(first.proposal.updatedAt).toBe(2_000);

    const second = transitionProposal(first.proposal, { type: 'confirm' }, 3_000);
    expect(second.changed).toBe(false);
    expect(second.proposal).toBe(first.proposal);
  });

  it('rejects only from pending', () => {
    const rejected = transitionProposal(proposal(), { type: 'reject' }, 2_000);
    expect(rejected.changed).toBe(true);
    expect(rejected.proposal.status).toBe('rejected');

    const executing = transitionProposal(
      proposal({ status: 'executing' }),
      { type: 'reject' },
      2_000
    );
    expect(executing.changed).toBe(false);
  });

  it('expires pending proposals only after 24 hours', () => {
    const early = transitionProposal(proposal(), { type: 'expire' }, 1_000 + PROPOSAL_TTL_MS - 1);
    expect(early.changed).toBe(false);

    const late = transitionProposal(proposal(), { type: 'expire' }, 1_000 + PROPOSAL_TTL_MS);
    expect(late.changed).toBe(true);
    expect(late.proposal.status).toBe('expired');

    const executing = transitionProposal(
      proposal({ status: 'executing' }),
      { type: 'expire' },
      1_000 + PROPOSAL_TTL_MS * 2
    );
    expect(executing.changed).toBe(false);
  });

  it('finishes an executing dispatch proposal with its conversation id', () => {
    const done = transitionProposal(
      proposal({ status: 'executing' }),
      { type: 'finish', ok: true, conversationId: 'conv9' },
      2_000
    );
    expect(done.changed).toBe(true);
    expect(done.proposal.status).toBe('succeeded');
    expect(done.proposal.kind === 'dispatch' && done.proposal.conversationId).toBe('conv9');
  });

  it('records the failure reason when execution fails', () => {
    const failed = transitionProposal(
      proposal({ status: 'executing' }),
      { type: 'finish', ok: false, error: 'project-removed' },
      2_000
    );
    expect(failed.proposal.status).toBe('failed');
    expect(failed.proposal.error).toBe('project-removed');
  });

  it('ignores finish outside executing and drops the stale error on success', () => {
    const pending = transitionProposal(proposal(), { type: 'finish', ok: true }, 2_000);
    expect(pending.changed).toBe(false);

    const done = transitionProposal(
      proposal({ status: 'succeeded' }),
      { type: 'finish', ok: false, error: 'late' },
      2_000
    );
    expect(done.changed).toBe(false);

    const retried = transitionProposal(
      proposal({ status: 'executing', error: 'boom' }),
      { type: 'finish', ok: true },
      2_000
    );
    expect(retried.proposal.error).toBeUndefined();
  });

  it('finishes a profile proposal without a conversation id', () => {
    const done = transitionProposal(
      {
        ...proposal(),
        status: 'executing',
        kind: 'profile',
        draft: { name: '小秘' },
      } as SecretaryProposal,
      { type: 'finish', ok: true, conversationId: 'conv9' },
      2_000
    );
    expect(done.proposal.status).toBe('succeeded');
    expect(done.proposal.kind).toBe('profile');
  });
});

describe('validateDispatch', () => {
  const ctx = {
    project: project(),
    visible: true,
    running: 0,
    max: 3,
    worktreeMode: 'auto' as const,
  };

  it('accepts a visible local project under the limit', () => {
    expect(validateDispatch(draft(), ctx)).toEqual({ ok: true, draft: draft() });
  });

  it('rejects a missing, removed or non-local project', () => {
    expect(validateDispatch(draft(), { ...ctx, project: undefined })).toEqual({
      ok: false,
      error: 'project-missing',
    });
    expect(validateDispatch(draft(), { ...ctx, project: project({ state: 'removed' }) })).toEqual({
      ok: false,
      error: 'project-removed',
    });
    for (const kind of ['ssh', 'bot-home', 'scratch'] as const) {
      expect(validateDispatch(draft(), { ...ctx, project: project({ kind }) })).toEqual({
        ok: false,
        error: 'project-not-local',
      });
    }
    expect(validateDispatch(draft(), { ...ctx, project: project({ kind: undefined }) }).ok).toBe(
      true
    );
  });

  it('rejects an invisible project and a full dispatch queue', () => {
    expect(validateDispatch(draft(), { ...ctx, visible: false })).toEqual({
      ok: false,
      error: 'project-not-visible',
    });
    expect(validateDispatch(draft(), { ...ctx, running: 3 })).toEqual({
      ok: false,
      error: 'dispatch-limit',
    });
  });

  it('forces the worktree flag from the profile mode', () => {
    const never = validateDispatch(draft({ worktree: true }), { ...ctx, worktreeMode: 'never' });
    expect(never.ok && never.draft.worktree).toBe(false);

    const always = validateDispatch(draft({ worktree: false }), { ...ctx, worktreeMode: 'always' });
    expect(always.ok && always.draft.worktree).toBe(true);

    const auto = validateDispatch(draft({ worktree: true }), ctx);
    expect(auto.ok && auto.draft.worktree).toBe(true);
  });

  it('带 after 的派发不占运行名额，真正开始时才查上限', () => {
    const deferred = validateDispatch(draft({ worktree: true, after: ['c1'] }), {
      ...ctx,
      running: 3,
      deferred: true,
    });
    expect(deferred.ok).toBe(true);
    expect(
      validateDispatch(draft({ worktree: true, after: ['c1'] }), { ...ctx, running: 3 })
    ).toEqual({ ok: false, error: 'dispatch-limit' });
  });

  it('基线只在真的建 worktree 时才有意义', () => {
    expect(
      validateDispatch(draft({ worktree: false, baseRef: 'main' }), {
        ...ctx,
        worktreeMode: 'never',
      })
    ).toEqual({ ok: false, error: 'base-requires-worktree' });
  });
});

describe('validateDispatchBase', () => {
  const facts = {
    knownCheckout: true,
    sameRepo: true,
    baseRefExists: true,
    branchExists: false,
    branchValid: true,
  };

  it('没指定基线时直接通过', () => {
    expect(validateDispatchBase(draft({ worktree: true }), facts)).toEqual({ ok: true });
  });

  it('checkout 越界或不是同一个仓库时拒绝', () => {
    const base = draft({ worktree: true, checkout: '/repo/other' });
    expect(validateDispatchBase(base, { ...facts, knownCheckout: false })).toEqual({
      ok: false,
      error: 'checkout-not-in-project',
    });
    expect(validateDispatchBase(base, { ...facts, sameRepo: false })).toEqual({
      ok: false,
      error: 'checkout-other-repo',
    });
    expect(validateDispatchBase(base, facts)).toEqual({ ok: true });
  });

  it('baseRef 不存在时拒绝', () => {
    expect(
      validateDispatchBase(draft({ worktree: true, baseRef: 'feat/nope' }), {
        ...facts,
        baseRefExists: false,
      })
    ).toEqual({ ok: false, error: 'base-ref-missing' });
  });

  it('分支重名或名字非法时拒绝，不覆盖已有分支', () => {
    const base = draft({ worktree: true, branch: 'feat/x' });
    expect(validateDispatchBase(base, { ...facts, branchExists: true })).toEqual({
      ok: false,
      error: 'branch-exists',
    });
    expect(validateDispatchBase(base, { ...facts, branchValid: false })).toEqual({
      ok: false,
      error: 'branch-invalid',
    });
    expect(validateDispatchBase(base, facts)).toEqual({ ok: true });
  });
});

describe('提案去重', () => {
  const cleanup = (id: string, names: string[], status: 'pending' | 'succeeded' = 'pending') =>
    ({
      id,
      secretaryConversationId: 'sec1',
      createdAt: 1,
      updatedAt: 1,
      status,
      kind: 'cleanup',
      draft: { items: names.map((name) => ({ id: `branch|${name}`, kind: 'branch', name })) },
    }) as SecretaryProposal;

  it('清理只比 id 集合：顺序与大小不影响指纹', () => {
    expect(proposalSignature(cleanup('a', ['x', 'y']))).toBe(
      proposalSignature(cleanup('b', ['y', 'x']))
    );
    expect(proposalSignature(cleanup('a', ['x']))).not.toBe(proposalSignature(cleanup('b', ['y'])));
  });

  it('参数一致就是同一张卡，参数不同只算同类', () => {
    const existing = cleanup('a', ['x']);
    const same = pendingProposalMatch({ a: existing }, 'sec1', {
      kind: 'cleanup',
      signature: proposalSignature(cleanup('b', ['x'])),
    });
    expect(same.same?.id).toBe('a');
    expect(same.other).toBeUndefined();

    const other = pendingProposalMatch({ a: existing }, 'sec1', {
      kind: 'cleanup',
      signature: proposalSignature(cleanup('b', ['y'])),
    });
    expect(other.same).toBeUndefined();
    expect(other.other?.id).toBe('a');
  });

  it('只看同一秘书会话、只看还没处理的卡', () => {
    const done = cleanup('a', ['x'], 'succeeded');
    const elsewhere = { ...cleanup('b', ['x']), secretaryConversationId: 'sec2' };
    expect(
      pendingProposalMatch({ a: done, b: elsewhere }, 'sec1', {
        kind: 'cleanup',
        signature: proposalSignature(cleanup('c', ['x'])),
      })
    ).toEqual({});
  });

  it('正在执行的卡同样算还没处理完', () => {
    const running = { ...cleanup('a', ['x']), status: 'executing' as const };
    const match = pendingProposalMatch({ a: running }, 'sec1', {
      kind: 'cleanup',
      signature: proposalSignature(cleanup('b', ['x'])),
    });
    expect(match.same?.id).toBe('a');
    expect(pendingProposalNote(match)).toContain('already running');
  });

  it('提示语点名 proposalId，没有待处理的卡就没有提示', () => {
    expect(pendingProposalNote({ same: { id: 'p1' } })).toContain('proposalId=p1');
    expect(pendingProposalNote({ other: { id: 'p2' } })).toContain('proposalId=p2');
    expect(pendingProposalNote({})).toBeUndefined();
  });
});

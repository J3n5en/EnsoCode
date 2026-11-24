import { describe, expect, it } from 'vitest';
import {
  formatGoalResultChecks,
  formatGoalResultClaims,
  GOAL_RESULT_SCHEMA,
  NEEDS_USER_TRIAGE_MS,
  needsUserTriageDeadline,
  parseGoalResult,
  parseGoalResultView,
  shownNeedsUser,
} from './goalResult';

describe('shownNeedsUser：升级的条目答完后', () => {
  const view = {
    at: 0,
    result: { needsUser: ['删临时文件', '是否清理孤儿进程'] },
    escalations: [{ index: 1, at: 10 * 60_000 }],
    answers: [{ index: 1, answer: '清理', at: 20 * 60_000 }],
  };

  it('还有没升级也没答的条目：回到秘书手里，截止时间从最后一次处理算', () => {
    expect(needsUserTriageDeadline(view)).toBe(20 * 60_000 + NEEDS_USER_TRIAGE_MS);
    expect(shownNeedsUser(view, true, 45 * 60_000)).toEqual({
      triaging: true,
      items: [],
      answers: [],
    });
    expect(shownNeedsUser(view, true, 51 * 60_000)).toEqual({
      triaging: false,
      items: ['删临时文件', '是否清理孤儿进程'],
      answers: [{ index: 1, answer: '清理', at: 20 * 60_000 }],
    });
  });

  it('升级的还没答：超时也只给升级的条目', () => {
    const pending = { ...view, answers: undefined };
    expect(shownNeedsUser(pending, true, 120 * 60_000).items).toEqual(['是否清理孤儿进程']);
  });
});

const full = {
  summary: 'shipped',
  prs: [
    {
      repo: 'owner/x',
      number: 123,
      state: 'merged',
      squashSha: 'ABC1234',
      remoteBranchDeleted: true,
    },
  ],
  commits: ['AbC1234def'],
  checks: {
    typecheck: 'pass',
    lint: 'fail',
    tests: { passed: 12, failed: 0, failuresUnrelated: false, note: 'unit' },
    ci: { runId: 99, conclusion: 'success', repo: 'owner/x' },
  },
  screenshots: [{ path: '/tmp/a.png', caption: 'home' }],
  followUps: ['docs'],
  needsUser: ['ship?'],
  deploy: { needed: true, phone: false, relay: true, note: 'later' },
  worktree: { path: '/tmp/wt', branch: 'feat/x' },
};

describe('parseGoalResult', () => {
  it('收下完整结果，并把 sha 收成小写', () => {
    const parsed = parseGoalResult(full);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.prs?.[0]?.squashSha).toBe('abc1234');
    expect(parsed.value.commits).toEqual(['abc1234def']);
    expect(parsed.value.summary).toBe('shipped');
    expect(parsed.value.checks?.ci?.runId).toBe(99);
    expect(parsed.value.screenshots).toEqual([{ path: '/tmp/a.png', caption: 'home' }]);
  });

  it('只给部分字段也能过', () => {
    expect(parseGoalResult({ summary: 'done' })).toEqual({
      ok: true,
      value: { summary: 'done' },
    });
    expect(parseGoalResult({})).toEqual({ ok: true, value: {} });
  });

  it('坏 sha、坏状态、类型错、未知键都带字段路径', () => {
    expect(parseGoalResult({ commits: ['zzzzzzz'] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('commits.0'),
    });
    expect(
      parseGoalResult({ prs: [{ repo: 'owner/x', number: 1, state: 'landed' }] })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('prs.0.state'),
    });
    expect(parseGoalResult({ summary: 1 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('summary'),
    });
    expect(parseGoalResult({ extra: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('extra'),
    });
    expect(parseGoalResult({ prs: [{ repo: 'not a repo', number: 1 }] }).ok).toBe(false);
    expect(parseGoalResult({ prs: [{ repo: 'owner/x', number: 0 }] }).ok).toBe(false);
    expect(parseGoalResult({ screenshots: [{ path: 'relative.png' }] }).ok).toBe(false);
  });

  it('schema 与解析器同一套字段，且每个属性都有类型', () => {
    expect(GOAL_RESULT_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    const properties = GOAL_RESULT_SCHEMA.properties as Record<string, { type?: string }>;
    for (const schema of Object.values(properties)) expect(schema.type).toBeTruthy();
    expect(Object.keys(properties).sort()).toEqual(
      [
        'checks',
        'commits',
        'deploy',
        'followUps',
        'needsUser',
        'prs',
        'screenshots',
        'summary',
        'worktree',
      ].sort()
    );
  });
});

describe('goal result 格式化', () => {
  const parsed = parseGoalResult(full);
  if (!parsed.ok) throw new Error('fixture');
  const result = parsed.value;

  it('核验摘要只用受约束的 token', () => {
    const line = formatGoalResultChecks({
      result,
      at: 1,
      checks: [
        { kind: 'pr-state', ref: 'owner/x#123', status: 'verified' },
        { kind: 'pr-squash', ref: 'owner/x#123', status: 'verified' },
        { kind: 'pr-branch', ref: 'owner/x#123', status: 'verified' },
        { kind: 'commit', ref: 'abc1234def', status: 'verified' },
        { kind: 'screenshot', ref: '/tmp/a.png', status: 'verified' },
        { kind: 'screenshot', ref: '/tmp/b.png', status: 'verified' },
        { kind: 'ci', ref: '99', status: 'verified' },
      ],
    });
    expect(line).toBe(
      '核验：PR owner/x#123 merged ✓ · squash abc1234 ✓ · 远端分支已删 ✓ · sha abc1234 在 main ✓ · 截图 2 张 ✓ · CI 99 ✓'
    );
    expect(
      formatGoalResultChecks({
        result,
        at: 1,
        checks: [{ kind: 'pr-state', ref: 'owner/x#123', status: 'mismatch', detail: 'open' }],
      })
    ).toBe('核验：PR owner/x#123 merged ✗ open');
    expect(
      formatGoalResultChecks({
        result,
        at: 1,
        checks: [{ kind: 'commit', ref: 'abc1234def', status: 'unverifiable', detail: '核验超时' }],
      })
    ).toBe('核验：sha abc1234 在 main ?');
  });

  it('会话自述按字段分行', () => {
    expect(formatGoalResultClaims(result)).toBe(
      [
        'shipped',
        'PR owner/x#123 merged squash abc1234 远端分支已删',
        'commits abc1234def',
        'typecheck pass',
        'lint fail',
        'tests 12 passed, 0 failed',
        'unit',
        'CI 99 success owner/x',
        '截图 /tmp/a.png home',
        'follow-up: docs',
        'needs-user[0]: ship?',
        'deploy needed relay later',
        'worktree feat/x /tmp/wt',
      ].join('\n')
    );
  });
});

describe('parseGoalResultView', () => {
  it('坏的核验项丢掉，整段结果还在', () => {
    const view = parseGoalResultView({
      result: { summary: 'done', commits: ['abc1234'] },
      at: 5,
      checks: [
        { kind: 'commit', ref: 'abc1234', status: 'verified' },
        { kind: 'nope', ref: 'x', status: 'verified' },
      ],
    });
    expect(view).toEqual({
      result: { summary: 'done', commits: ['abc1234'] },
      at: 5,
      checks: [{ kind: 'commit', ref: 'abc1234', status: 'verified' }],
    });
    expect(parseGoalResultView({ result: { commits: ['nope'] }, at: 1 })).toBeUndefined();
    expect(parseGoalResultView({ result: { summary: 'done' } })).toBeUndefined();
  });
});

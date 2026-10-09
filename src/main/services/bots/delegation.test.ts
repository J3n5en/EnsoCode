import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Delegation, parseBotProfile, parseDelegation } from '../../../shared/types/bot';
import { delegatedBotPermissions, delegationPolicy } from './delegationPolicy';
import { DelegationStore } from './delegationStore';

const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const profile = (id: string) =>
  parseBotProfile({ id, name: id === a ? 'Alice' : 'Bob', createdAt: 1, updatedAt: 1 })!;
const record: Delegation = {
  id: a,
  parentConversationId: 'parent',
  parentBotId: a,
  targetBotId: b,
  chatId: null,
  task: 'work',
  context: '',
  childConversationId: 'child',
  state: 'queued',
  depth: 1,
  createdAt: 1,
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('delegation policy', () => {
  it('rejects corrupt delivery timestamps instead of turning a delivered record into a pending one', () => {
    expect(parseDelegation({ ...record, deliveredAt: 'broken' })).toBeUndefined();
    expect(parseDelegation({ ...record, finishedAt: -1 })).toBeUndefined();
  });
  it('keeps a string retryOf and drops malformed ones', () => {
    expect(parseDelegation({ ...record, retryOf: b })?.retryOf).toBe(b);
    expect(parseDelegation({ ...record, retryOf: 3 })).not.toHaveProperty('retryOf');
    expect(parseDelegation({ ...record, retryOf: '' })).not.toHaveProperty('retryOf');
  });
  it('keeps keep only when it is literally true', () => {
    expect(parseDelegation({ ...record, keep: true })?.keep).toBe(true);
    expect(parseDelegation({ ...record, keep: 'true' })).not.toHaveProperty('keep');
    expect(parseDelegation({ ...record, keep: false })).not.toHaveProperty('keep');
  });
  it('keeps retry chain / auto-retry / result fields and drops malformed values', () => {
    const parsed = parseDelegation({
      ...record,
      retryBy: 'delegator',
      retryNote: 'n'.repeat(3000),
      autoRetryAt: 5,
      transient: true,
      resultSeq: 7,
    });
    expect(parsed).toMatchObject({
      retryBy: 'delegator',
      autoRetryAt: 5,
      transient: true,
      resultSeq: 7,
    });
    expect(parsed?.retryNote).toHaveLength(2000);
    const bad = parseDelegation({
      ...record,
      retryBy: 'robot',
      retryNote: '',
      autoRetryAt: -1,
      transient: 'yes',
      resultSeq: 0,
    });
    for (const key of ['retryBy', 'retryNote', 'autoRetryAt', 'transient', 'resultSeq'])
      expect(bad).not.toHaveProperty(key);
  });
  it('keeps the waiting-for-downstream marker (the stashed turn output) and drops malformed ones', () => {
    expect(
      parseDelegation({
        ...record,
        state: 'running',
        waiting: { since: 5, text: '等复审', turnId: 't1' },
      })?.waiting
    ).toEqual({ since: 5, text: '等复审', turnId: 't1' });
    expect(parseDelegation({ ...record, waiting: { since: 5, text: '' } })?.waiting).toEqual({
      since: 5,
      text: '',
    });
    for (const bad of [true, { since: -1, text: '' }, { since: 5 }, { since: 5, text: 3 }])
      expect(parseDelegation({ ...record, waiting: bad })).not.toHaveProperty('waiting');
  });
  it('keeps the pending group-result marker (with optional turnId) and drops malformed ones', () => {
    expect(
      parseDelegation({ ...record, pendingResultEntry: { turnId: 't1' } })?.pendingResultEntry
    ).toEqual({ turnId: 't1' });
    expect(parseDelegation({ ...record, pendingResultEntry: {} })?.pendingResultEntry).toEqual({});
    expect(
      parseDelegation({ ...record, pendingResultEntry: { turnId: 3 } })?.pendingResultEntry
    ).toEqual({});
    for (const bad of [true, 'yes', null, []])
      expect(parseDelegation({ ...record, pendingResultEntry: bad })).not.toHaveProperty(
        'pendingResultEntry'
      );
  });
  it('rejects self, archived, denied, out-of-group, depth and concurrency', () => {
    const parent = profile(a),
      target = profile(b);
    expect(delegationPolicy(parent, parent, 1, 0)).toBeDefined();
    expect(delegationPolicy(parent, { ...target, archivedAt: 1 }, 1, 0)).toBeDefined();
    expect(
      delegationPolicy(
        { ...parent, delegation: { canDelegateTo: [], acceptFrom: 'any' } },
        target,
        1,
        0
      )
    ).toBeDefined();
    expect(
      delegationPolicy(
        parent,
        { ...target, delegation: { canDelegateTo: 'any', acceptFrom: [] } },
        1,
        0
      )
    ).toBeDefined();
    expect(delegationPolicy(parent, target, 1, 0, [a])).toBeDefined();
    expect(delegationPolicy(parent, target, 3, 0)).toBeDefined();
    expect(delegationPolicy(parent, target, 2, 3)).toBeDefined();
    expect(delegationPolicy(parent, target, 2, 2, [a, b])).toBeUndefined();
  });
  it("runs with the target's own tools and assets under the stricter approval mode", () => {
    expect(
      delegatedBotPermissions(
        {
          ...profile(a),
          tools: 'readonly',
          approvalMode: 'supervised',
          skillIds: ['shared', 'parent'],
          mcpServerIds: ['common', 'private'],
        },
        { ...profile(b), skillIds: ['target', 'shared'], mcpServerIds: ['mcp', 'common'] }
      )
    ).toMatchObject({
      id: b,
      tools: 'all',
      approvalMode: 'supervised',
      skillIds: ['target', 'shared'],
      mcpServerIds: ['mcp', 'common'],
    });
    expect(
      delegatedBotPermissions(
        { ...profile(a), tools: 'all' },
        { ...profile(b), tools: 'readonly', approvalMode: 'full' }
      )
    ).toMatchObject({ tools: 'readonly', approvalMode: profile(a).approvalMode });
    expect(
      delegatedBotPermissions(
        { ...profile(a), approvalMode: 'assistant' },
        { ...profile(b), approvalMode: 'auto-edits' }
      ).approvalMode
    ).toBe('supervised');
  });
  it('persists effective permissions and rejects malformed permission snapshots', () => {
    const effectivePermissions = {
      tools: 'readonly',
      approvalMode: 'supervised',
      skillIds: ['shared'],
      mcpServerIds: [],
    };
    expect(parseDelegation({ ...record, effectivePermissions })).toMatchObject({
      effectivePermissions,
    });
    expect(
      parseDelegation({
        ...record,
        effectivePermissions: { ...effectivePermissions, skillIds: 'all' },
      })
    ).toBeUndefined();
  });
});

it('rebuilds last valid record per id, skips malformed lines, and validates records', () => {
  const root = mkdtempSync(join(tmpdir(), 'delegation-'));
  roots.push(root);
  const file = join(root, 'delegations.jsonl');
  const store = new DelegationStore(file);
  store.save(record);
  store.save({ ...record, state: 'completed', result: 'done', finishedAt: 2 });
  appendFileSync(file, '\nnot-json\n{"id":"bad"}\n');
  expect(new DelegationStore(file).list()).toEqual([
    { ...record, state: 'completed', result: 'done', finishedAt: 2 },
  ]);
});

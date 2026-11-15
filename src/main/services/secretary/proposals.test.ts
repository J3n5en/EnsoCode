import type { SecretaryDispatchFile, SecretaryProposal } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { saveProposalRecord } from './proposals';

const file = (): SecretaryDispatchFile => ({
  version: 1,
  dispatched: {},
  named: [],
  proposals: {},
  outbox: [],
});

const cleanup = (
  id: string,
  names: string[],
  secretaryConversationId = 'sec-1'
): SecretaryProposal =>
  ({
    id,
    secretaryConversationId,
    createdAt: 1,
    updatedAt: 1,
    status: 'pending',
    kind: 'cleanup',
    draft: { items: names.map((name) => ({ id: `branch|${name}`, kind: 'branch', name })) },
  }) as SecretaryProposal;

describe('saveProposalRecord', () => {
  it('同类同参的卡已经在等就复用，不新建', () => {
    const target = file();
    const first = saveProposalRecord(target, cleanup('p1', ['feat/a']));
    const second = saveProposalRecord(target, cleanup('p2', ['feat/a']));

    expect(first.changed).toBe(true);
    expect(first.saved).toEqual({ proposalId: 'p1', reused: false });
    expect(second.changed).toBe(false);
    expect(second.saved.proposalId).toBe('p1');
    expect(second.saved.reused).toBe(true);
    expect(second.saved.note).toContain('proposalId=p1');
    expect(Object.keys(target.proposals)).toEqual(['p1']);
  });

  it('参数不同就另开一张，并提示上一张还没处理', () => {
    const target = file();
    saveProposalRecord(target, cleanup('p1', ['feat/a']));
    const second = saveProposalRecord(target, cleanup('p2', ['feat/b']));

    expect(second.changed).toBe(true);
    expect(second.saved.proposalId).toBe('p2');
    expect(second.saved.reused).toBe(false);
    expect(second.saved.otherPendingId).toBe('p1');
    expect(second.saved.note).toContain('proposalId=p1');
    expect(Object.keys(target.proposals).sort()).toEqual(['p1', 'p2']);
  });

  it('已处理完的卡不再拦新卡', () => {
    const target = file();
    target.proposals.p1 = { ...cleanup('p1', ['feat/a']), status: 'succeeded' };

    const saved = saveProposalRecord(target, cleanup('p2', ['feat/a']));

    expect(saved.changed).toBe(true);
    expect(saved.saved).toEqual({ proposalId: 'p2', reused: false });
  });

  it('卡已经在执行时也复用，并说明正在跑', () => {
    const target = file();
    target.proposals.p1 = { ...cleanup('p1', ['feat/a']), status: 'executing' };

    const saved = saveProposalRecord(target, cleanup('p2', ['feat/a']));

    expect(saved.changed).toBe(false);
    expect(saved.saved.reused).toBe(true);
    expect(saved.saved.note).toContain('already running');
    expect(saved.saved.note).toContain('proposalId=p1');
  });

  it('别的秘书会话的卡不算同类', () => {
    const target = file();
    saveProposalRecord(target, cleanup('p1', ['feat/a'], 'sec-2'));

    const saved = saveProposalRecord(target, cleanup('p2', ['feat/a']));

    expect(saved.changed).toBe(true);
    expect(saved.saved).toEqual({ proposalId: 'p2', reused: false });
  });
});

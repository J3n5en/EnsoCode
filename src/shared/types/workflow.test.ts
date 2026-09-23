import { describe, expect, it } from 'vitest';
import { groupWorkflowMembers, parseWorkflowRunSnapshot } from './workflow';

const valid = {
  runId: 'run-1',
  name: 'audit-auth',
  description: 'Audit authentication changes',
  status: 'running',
  phase: 'review',
  logs: ['started'],
  members: [
    {
      seq: 1,
      label: 'read auth',
      phase: 'review',
      batch: 1,
      status: 'running',
      prompt: 'read auth.ts',
      childId: 'child-1',
    },
  ],
};

describe('parseWorkflowRunSnapshot', () => {
  it('接受有界快照并丢掉多余字段', () => {
    expect(
      parseWorkflowRunSnapshot({
        ...valid,
        extra: true,
        members: [{ ...valid.members[0], extra: true, result: 'ok' }],
      })
    ).toEqual({
      ...valid,
      members: [{ ...valid.members[0], result: 'ok' }],
    });
  });

  it('拒绝超限、缺字段和未知状态', () => {
    expect(parseWorkflowRunSnapshot({ ...valid, status: 'paused' })).toBeNull();
    expect(
      parseWorkflowRunSnapshot({ ...valid, logs: Array.from({ length: 21 }, () => 'x') })
    ).toBeNull();
    expect(
      parseWorkflowRunSnapshot({ ...valid, members: [{ seq: 0, label: 'a', status: 'running' }] })
    ).toBeNull();
    expect(
      parseWorkflowRunSnapshot({
        ...valid,
        members: [{ ...valid.members[0], batch: 0 }],
      })
    ).toBeNull();
    expect(
      parseWorkflowRunSnapshot({
        ...valid,
        members: [{ ...valid.members[0], prompt: 'x'.repeat(161) }],
      })
    ).toBeNull();
    expect(parseWorkflowRunSnapshot({ ...valid, name: '  ' })).toBeNull();
  });
});

describe('groupWorkflowMembers', () => {
  it('同一阶段的同一并行批次合成一组，换阶段或换批次就拆开', () => {
    const members = [
      { seq: 1, label: 'a', phase: 'review', batch: 1, status: 'completed' as const },
      { seq: 2, label: 'b', phase: 'review', batch: 1, status: 'running' as const },
      { seq: 3, label: 'c', phase: 'review', batch: 2, status: 'running' as const },
      { seq: 4, label: 'd', phase: 'fix', batch: 3, status: 'running' as const },
    ];
    expect(groupWorkflowMembers(members)).toEqual([
      { phase: 'review', batch: 1, members: [members[0], members[1]] },
      { phase: 'review', batch: 2, members: [members[2]] },
      { phase: 'fix', batch: 3, members: [members[3]] },
    ]);
  });
});

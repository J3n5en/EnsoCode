import { describe, expect, it } from 'vitest';
import { parseAgentWorkerEvent } from './agent';
import { parent } from './agent.testUtils';

const signal = {
  type: 'goal-signal' as const,
  identity: parent,
  seq: 1,
  kind: 'complete' as const,
  note: 'done',
};

describe('goal-signal result', () => {
  it('合法 result 保留，sha 收成小写', () => {
    expect(
      parseAgentWorkerEvent({ ...signal, result: { summary: 'shipped', commits: ['AbC1234'] } })
    ).toEqual({
      ...signal,
      result: { summary: 'shipped', commits: ['abc1234'] },
    });
  });

  it('非法 result 丢掉字段，事件本身仍收下', () => {
    expect(parseAgentWorkerEvent({ ...signal, result: { extra: true } })).toEqual(signal);
  });

  it('没有 result 时与原来一样', () => {
    expect(parseAgentWorkerEvent(signal)).toEqual(signal);
  });
});

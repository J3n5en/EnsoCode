import { describe, expect, it } from 'vitest';
import type { Delegation } from '../../../shared/types/bot';
import { rewoundDelegations, rewoundWatermark } from './rewind';

const record = (patch: Partial<Delegation>): Delegation =>
  ({
    id: 'd',
    parentConversationId: 'p',
    parentBotId: 'a',
    targetBotId: 'b',
    chatId: 'c',
    task: 't',
    context: '',
    childConversationId: 'child',
    state: 'running',
    depth: 1,
    createdAt: 100,
    ...patch,
  }) as Delegation;

describe('rewoundDelegations', () => {
  it('只处理该会话在回退点之后发起的委派：进行中取消，已结束未投递作废，已投递不动', () => {
    const records = [
      record({ id: 'before', createdAt: 50 }),
      record({ id: 'other-parent', parentConversationId: 'x', createdAt: 200 }),
      record({ id: 'running', state: 'running', createdAt: 200 }),
      record({ id: 'queued', state: 'queued', createdAt: 100 }),
      record({ id: 'done', state: 'completed', createdAt: 300 }),
      record({ id: 'delivered', state: 'completed', createdAt: 300, deliveredAt: 400 }),
    ];
    expect(rewoundDelegations(records, 'p', 100)).toEqual({
      cancel: ['running', 'queued'],
      discard: ['running', 'queued', 'done'],
    });
  });
});

describe('rewoundWatermark', () => {
  const branch = ['e1', 'e2', 'u3', 'e4', 'e5'];
  it('水位落在被裁掉的部分：退到回退点前一条', () => {
    expect(rewoundWatermark(branch, 'u3', 'e5')).toEqual({ next: 'e2' });
    expect(rewoundWatermark(branch, 'u3', 'u3')).toEqual({ next: 'e2' });
  });
  it('回退到第一条：清空水位', () => {
    expect(rewoundWatermark(branch, 'e1', 'e4')).toEqual({ next: null });
  });
  it('水位在保留部分、不在分支上或目标缺失：不变', () => {
    expect(rewoundWatermark(branch, 'u3', 'e2')).toBeUndefined();
    expect(rewoundWatermark(branch, 'u3', 'zz')).toBeUndefined();
    expect(rewoundWatermark(branch, 'missing', 'e5')).toBeUndefined();
    expect(rewoundWatermark(branch, 'u3', undefined)).toBeUndefined();
  });
});

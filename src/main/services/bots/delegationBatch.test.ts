import { describe, expect, it } from 'vitest';
import type { Delegation } from '../../../shared/types/bot';
import {
  batchDeliveryId,
  batchResultText,
  batchWaitingNotice,
  delegationBatches,
  turnDelegationTargets,
} from './delegationBatch';

const rec = (id: string, patch: Partial<Delegation> = {}): Delegation => ({
  id,
  parentConversationId: 'p',
  parentBotId: 'boss',
  targetBotId: `bot-${id}`,
  chatId: null,
  task: 't',
  context: '',
  childConversationId: `c-${id}`,
  state: 'completed',
  depth: 1,
  createdAt: 1,
  ...patch,
});
const names: Record<string, string> = { 'bot-a': '小设', 'bot-b': '阿全', 'bot-c': '小王' };
const nameOf = (id: string) => names[id] ?? id;

describe('delegationBatches', () => {
  it('按父会话 + batchId 聚合，缺 batchId 的记录各自成批，批内按创建时间排序', () => {
    const batches = delegationBatches([
      rec('b', { batchId: 'k', createdAt: 2 }),
      rec('old', { createdAt: 0 }),
      rec('a', { batchId: 'k', createdAt: 1 }),
      rec('x', { batchId: 'k', parentConversationId: 'other' }),
      rec('r', { createdAt: 3 }),
    ]);
    expect(batches.map((batch) => batch.map((record) => record.id))).toEqual([
      ['old'],
      ['a', 'b'],
      ['x'],
      ['r'],
    ]);
  });
});

describe('batchDeliveryId / batchResultText', () => {
  it('单委派批次保持原 deliveryId 与原注入格式', () => {
    const batch = [rec('a', { batchId: 'k', result: '完成 & <ok>' })];
    expect(batchDeliveryId(batch)).toBe('a');
    expect(batchResultText(batch, nameOf)).toBe(
      '<delegation-result id="a" from="小设" status="completed">完成 &amp; &lt;ok&gt;</delegation-result>'
    );
  });

  it('多委派批次用 batchId 作稳定 deliveryId，合并为一条批次注入', () => {
    const batch = [
      rec('a', { batchId: 'k', result: '设计稿' }),
      rec('b', { batchId: 'k', state: 'failed', failure: 'timeout' }),
    ];
    expect(batchDeliveryId(batch)).toBe('k');
    expect(batchResultText(batch, nameOf)).toBe(
      [
        '<delegation-results id="k">',
        '<delegation-result id="a" from="小设" status="completed">设计稿</delegation-result>',
        '<delegation-result id="b" from="阿全" status="failed">timeout</delegation-result>',
        '</delegation-results>',
      ].join('\n')
    );
  });
});

describe('batchWaitingNotice', () => {
  it('批次未齐时提示谁完成、还在等谁；齐了不提示', () => {
    const done = rec('a', { batchId: 'k' });
    const batch = [
      done,
      rec('b', { batchId: 'k', state: 'running' }),
      rec('c', { batchId: 'k', state: 'queued' }),
    ];
    expect(batchWaitingNotice(batch, done, nameOf)).toBe('小设 已完成，等待 阿全、小王');
    const canceled = rec('a', { batchId: 'k', state: 'canceled' });
    expect(batchWaitingNotice([canceled, batch[1]], canceled, nameOf)).toBe(
      '小设 已取消，等待 阿全'
    );
    expect(batchWaitingNotice([done, rec('b', { batchId: 'k' })], done, nameOf)).toBeNull();
    expect(batchWaitingNotice([done], done, nameOf)).toBeNull();
  });
});

describe('turnDelegationTargets', () => {
  it('只取同一父会话同一轮新建委派的目标', () => {
    const records = [
      rec('a', { batchId: 'turn-1' }),
      rec('b', { batchId: 'turn-1', state: 'running' }),
      rec('c', { batchId: 'turn-0' }),
      rec('d', { batchId: 'turn-1', parentConversationId: 'other' }),
      rec('e'),
    ];
    expect(turnDelegationTargets(records, 'p', 'turn-1')).toEqual(['bot-a', 'bot-b']);
    expect(turnDelegationTargets(records, 'p', 'missing')).toEqual([]);
  });
});

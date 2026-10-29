import { describe, expect, it } from 'vitest';
import { parseApprovalReviewRecord } from './approvalReviewRecord';

describe('parseApprovalReviewRecord', () => {
  const record = {
    verdict: 'deny',
    model: 'jev-latest',
    allow: 0.67,
    ask: 0.1,
    block: 0.23,
    reason: 'unclear_target',
  };

  it('白名单字段通过，多余字段剥离', () => {
    expect(parseApprovalReviewRecord({ ...record, secret: 'x' })).toEqual(record);
    const { reason: _reason, ...noReason } = record;
    expect(parseApprovalReviewRecord(noReason)).toEqual(noReason);
  });

  it('非法判定、概率、理由或模型名拒绝', () => {
    for (const bad of [
      { ...record, verdict: 'block' },
      { ...record, allow: 1.2 },
      { ...record, ask: Number.NaN },
      { ...record, block: '0.1' },
      { ...record, reason: 'whatever' },
      { ...record, model: '' },
      { ...record, model: 'x'.repeat(300) },
      null,
      [],
    ]) {
      expect(parseApprovalReviewRecord(bad)).toBeUndefined();
    }
  });
});

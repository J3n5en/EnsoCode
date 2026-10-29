import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ALLOW_THRESHOLDS,
  parseApprovalAllowThreshold,
  parseApprovalReviewRecord,
} from './approvalReviewRecord';

describe('parseApprovalAllowThreshold', () => {
  it('只认 0.85 / 0.9 / 0.95，其他值一律按 0.9', () => {
    expect(APPROVAL_ALLOW_THRESHOLDS).toEqual([0.85, 0.9, 0.95]);
    for (const value of APPROVAL_ALLOW_THRESHOLDS)
      expect(parseApprovalAllowThreshold(value)).toBe(value);
    for (const value of [0.5, 0.8, 0.86, 1, 0, -1, '0.85', null, undefined, Number.NaN, {}]) {
      expect(parseApprovalAllowThreshold(value)).toBe(0.9);
    }
  });
});

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

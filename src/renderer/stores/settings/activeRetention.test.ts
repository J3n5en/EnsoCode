import { describe, expect, it } from 'vitest';
import {
  ACTIVE_RETENTION_MINUTES,
  DEFAULT_ACTIVE_RETENTION_MINUTES,
  normalizeActiveRetentionMinutes,
} from './activeRetention';

describe('active retention minutes', () => {
  it('暴露允许值且默认关闭', () => {
    expect(ACTIVE_RETENTION_MINUTES).toEqual([0, 5, 10, 15, 30, 60, 120]);
    expect(DEFAULT_ACTIVE_RETENTION_MINUTES).toBe(0);
  });

  it('保留允许值', () => {
    expect(ACTIVE_RETENTION_MINUTES.map((value) => normalizeActiveRetentionMinutes(value))).toEqual(
      ACTIVE_RETENTION_MINUTES
    );
  });

  it('非法值回落到关闭', () => {
    expect(
      [undefined, null, 45, -1, '30', 7.5, 240].map((value) =>
        normalizeActiveRetentionMinutes(value)
      )
    ).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

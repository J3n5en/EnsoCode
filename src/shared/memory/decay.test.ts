import { describe, expect, it } from 'vitest';
import { computeDecayScore } from './decay';

const now = new Date('2025-01-31T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

describe('computeDecayScore', () => {
  it('never drops below floor', () => {
    const s = computeDecayScore({ lastHitAt: null, hitCount: 0, importance: 1.0, now });
    expect(s).toBeGreaterThanOrEqual(0.5);
  });

  it('floor = 0.3 + 0.2 * importance', () => {
    expect(
      computeDecayScore({ lastHitAt: daysAgo(10_000), hitCount: 0, importance: 0, now })
    ).toBeCloseTo(0.3, 6);
    expect(
      computeDecayScore({ lastHitAt: daysAgo(10_000), hitCount: 0, importance: 0.5, now })
    ).toBeCloseTo(0.4, 6);
  });

  it('never exceeds 1', () => {
    expect(
      computeDecayScore({ lastHitAt: now.toISOString(), hitCount: 1e9, importance: 1, now })
    ).toBeLessThanOrEqual(1);
  });

  it('recency = exp(-days/30)，不是 0.5^(days/30)', () => {
    const at = (d: number) =>
      computeDecayScore({ lastHitAt: daysAgo(d), hitCount: 0, importance: 0, now });
    expect(at(0)).toBeCloseTo(0.7, 6);
    // 0.7 * e^-0.5 = 0.7 * 0.6065307 = 0.4245715
    expect(at(15)).toBeCloseTo(0.4245715, 6);
    // 0.7 * e^-0.7 = 0.7 * 0.4965853 = 0.3476097
    expect(at(21)).toBeCloseTo(0.3476097, 6);
    // 0.5^(30/30)*0.7 would be 0.35; e^-1*0.7 = 0.2575 < floor 0.3
    expect(at(30)).toBeCloseTo(0.3, 6);
  });

  it('counts whole days like timedelta.days', () => {
    const at = (d: number) =>
      computeDecayScore({ lastHitAt: daysAgo(d), hitCount: 0, importance: 0, now });
    expect(at(0.9)).toBeCloseTo(0.7, 6);
    // 0.7 * e^(-1/30) = 0.7 * 0.9672161 = 0.6770513
    expect(at(1.9)).toBeCloseTo(0.6770513, 6);
  });

  it('frequency = log(1+min(n,100))/log(100)', () => {
    const at = (n: number) =>
      computeDecayScore({ lastHitAt: daysAgo(0), hitCount: n, importance: 0, now });
    expect(at(0)).toBeCloseTo(0.7, 6);
    // log(10)/log(100) = 0.5 → 0.7 + 0.3*0.5
    expect(at(9)).toBeCloseTo(0.85, 6);
    // log(100)/log(100) = 1
    expect(at(99)).toBeCloseTo(1, 6);
    // saturates at 100: log(101)/log(100) = 1.0022 → clamped to 1
    expect(at(100)).toBe(1);
    expect(at(1000)).toBe(at(100));
  });

  it('accepts Date or ISO string for lastHitAt', () => {
    const a = computeDecayScore({
      lastHitAt: new Date(daysAgo(5)),
      hitCount: 2,
      importance: 0.5,
      now,
    });
    const b = computeDecayScore({
      lastHitAt: daysAgo(5),
      hitCount: 2,
      importance: 0.5,
      now,
    });
    expect(a).toBeCloseTo(b, 12);
  });

  it('treats a future lastHitAt as now', () => {
    const s = computeDecayScore({
      lastHitAt: daysAgo(-10),
      hitCount: 0,
      importance: 0,
      now,
    });
    expect(s).toBeCloseTo(0.7, 6);
  });
});

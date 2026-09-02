import { describe, expect, it } from 'vitest';
import { intersects, isCoveredBy } from './overlayCover';

const host = { x: 600, y: 40, width: 400, height: 600 };

describe('intersects', () => {
  it('true when boxes overlap', () => {
    expect(intersects(host, { x: 900, y: 500, width: 300, height: 300 })).toBe(true);
  });
  it('false when touching edge or apart', () => {
    expect(intersects(host, { x: 1000, y: 40, width: 10, height: 10 })).toBe(false);
    expect(intersects(host, { x: 0, y: 0, width: 100, height: 100 })).toBe(false);
  });
  it('false for zero-size boxes', () => {
    expect(intersects(host, { x: 700, y: 100, width: 0, height: 0 })).toBe(false);
  });
});

describe('isCoveredBy', () => {
  it('any overlapping overlay covers the host', () => {
    expect(
      isCoveredBy(host, [
        { x: 0, y: 0, width: 200, height: 200 },
        { x: 650, y: 80, width: 200, height: 200 },
      ])
    ).toBe(true);
  });
  it('none overlapping does not', () => {
    expect(isCoveredBy(host, [{ x: 0, y: 0, width: 200, height: 200 }])).toBe(false);
    expect(isCoveredBy(host, [])).toBe(false);
  });
});

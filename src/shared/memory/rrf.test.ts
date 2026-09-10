import { describe, expect, it } from 'vitest';
import { finalScore, minMaxNormalize, rrf } from './rrf';

describe('rrf', () => {
  it('prefers items high in both lists', () => {
    const fused = rrf([
      ['x', 'y'],
      ['x', 'z'],
    ]);
    expect(fused[0][0]).toBe('x');
    expect(fused).toHaveLength(3);
  });

  it('uses 1/(k+rank) with k=60 and 1-based rank', () => {
    const fused = rrf([['a', 'b'], ['a']]);
    expect(fused[0]).toEqual(['a', 2 / 61]);
    expect(fused[1]).toEqual(['b', 1 / 62]);
  });

  it('handles a single result', () => {
    expect(rrf([['only']])).toEqual([['only', 1 / 61]]);
  });

  it('allows empty lists and missing channels', () => {
    expect(rrf([])).toEqual([]);
    expect(rrf([[], []])).toEqual([]);
    expect(rrf([[], ['a']])).toEqual([['a', 1 / 61]]);
  });

  it('dedups each list keeping the first rank', () => {
    const fused = rrf([['a', 'a', 'b']]);
    expect(fused).toEqual([
      ['a', 1 / 61],
      ['b', 1 / 62],
    ]);
  });

  it('sorts stably by first-seen order on ties', () => {
    const fused = rrf([['p'], ['q'], ['r']]);
    expect(fused.map(([id]) => id)).toEqual(['p', 'q', 'r']);
  });

  it('respects a custom k', () => {
    expect(rrf([['a']], 1)).toEqual([['a', 0.5]]);
  });

  it('scales each channel by optional weights', () => {
    expect(rrf([['a'], ['b']], 60, [0.5, 2]).map(([id]) => id)).toEqual(['b', 'a']);
    expect(rrf([['a'], ['b']], 60, [2, 1])[0]?.[0]).toBe('a');
    expect(rrf([['a'], ['b']], 60, [2, 1])[0]?.[1]).toBeCloseTo(2 / 61, 12);
  });

  it('skips a channel when its weight is not positive', () => {
    expect(rrf([['a'], ['b']], 60, [0, 1])).toEqual([['b', 1 / 61]]);
    expect(rrf([['a'], ['b']], 60, [-1])).toEqual([['b', 1 / 61]]);
  });
});

describe('finalScore', () => {
  it('uses V1 blend 0.85/0.15 without temporal boost', () => {
    expect(finalScore(1, 0.5)).toBeCloseTo(0.925, 12);
    expect(finalScore(0.4, 1)).toBeCloseTo(0.49, 12);
  });

  it('uses 0.70/0.15 + boost when boost > 0', () => {
    expect(finalScore(1, 0.5, 0.1)).toBeCloseTo(0.875, 12);
  });

  it('keeps RRF order when decay is equal, and decay order when RRF is equal', () => {
    expect(finalScore(0.9, 0.5)).toBeGreaterThan(finalScore(0.8, 0.5));
    expect(finalScore(0.8, 0.9)).toBeGreaterThan(finalScore(0.8, 0.5));
  });
});

describe('minMaxNormalize', () => {
  it('normalizes into [0,1]', () => {
    expect(minMaxNormalize([1, 3, 2])).toEqual([0, 1, 0.5]);
  });

  it('returns 1.0 for every item when all scores are equal', () => {
    expect(minMaxNormalize([0.016, 0.016])).toEqual([1, 1]);
    expect(minMaxNormalize([0.5])).toEqual([1]);
  });

  it('returns empty for empty input', () => {
    expect(minMaxNormalize([])).toEqual([]);
  });
});

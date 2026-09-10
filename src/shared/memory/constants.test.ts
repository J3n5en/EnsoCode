import { describe, expect, it } from 'vitest';
import * as c from './constants';

describe('memory constants', () => {
  it('freezes the spec values', () => {
    expect(c.UNIT_TYPES).toEqual([
      'fact',
      'preference',
      'decision',
      'plan',
      'procedure',
      'learning',
      'context',
      'event',
    ]);
    expect(c.DEFAULT_UNIT_TYPE).toBe('fact');
    expect(c.DEFAULT_IMPORTANCE).toBe(0.5);
    expect(c.AGENT_CREATE_IMPORTANCE).toBe(0.6);
    expect(c.HALF_LIFE_DAYS).toBe(30);
    expect(c.RECENCY_W).toBe(0.7);
    expect(c.FREQUENCY_W).toBe(0.3);
    expect(c.FREQUENCY_MAX_COUNT).toBe(100);
    expect(c.MIN_FLOOR).toBe(0.3);
    expect(c.IMP_MULT).toBe(0.2);
    expect(c.DECAY_WEIGHT).toBe(0.15);
    expect(c.RRF_K).toBe(60);
    expect(c.DEDUP_VECTOR).toBe(0.8);
    expect(c.DEDUP_MAX).toBe(3);
    expect(c.DEDUP_MIN_CHARS).toBe(100);
    expect(c.EVOLVES_MIN_CONF).toBe(0.7);
    expect(c.CRYSTAL_MIN_SOURCES).toBe(3);
  });

  it('isUnitType only accepts the closed set', () => {
    expect(c.isUnitType('decision')).toBe(true);
    expect(c.isUnitType('crystal')).toBe(false);
    expect(c.isUnitType('')).toBe(false);
  });
});

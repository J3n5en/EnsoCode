import { describe, expect, it } from 'vitest';
import * as c from './constants';

describe('memory constants', () => {
  it('isUnitType only accepts the closed set', () => {
    expect(c.isUnitType('decision')).toBe(true);
    expect(c.isUnitType('crystal')).toBe(false);
    expect(c.isUnitType('')).toBe(false);
  });
});

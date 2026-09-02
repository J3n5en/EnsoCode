import { describe, expect, it } from 'vitest';
import { holesClipPath } from './backgroundClip';

describe('holesClipPath', () => {
  it('returns undefined when there are no holes', () => {
    expect(holesClipPath([])).toBeUndefined();
  });

  it('punches one rect out of the full layer with an evenodd polygon', () => {
    expect(holesClipPath([{ x: 10, y: 20, width: 30, height: 40 }])).toBe(
      'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, 10px 20px, 40px 20px, 40px 60px, 10px 60px, 10px 20px, 0 0)'
    );
  });

  it('chains multiple holes into the same polygon', () => {
    const path = holesClipPath([
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 5, y: 5, width: 2, height: 2 },
    ]);
    expect(path).toContain('0px 0px, 1px 0px, 1px 1px, 0px 1px, 0px 0px, 0 0');
    expect(path).toContain('5px 5px, 7px 5px, 7px 7px, 5px 7px, 5px 5px, 0 0');
  });
});

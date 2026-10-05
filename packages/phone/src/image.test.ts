import { describe, expect, it } from 'vitest';
import { imageBudget } from './image';

describe('imageBudget', () => {
  it('多张图合计不超过单帧预算', () => {
    for (const count of [1, 2, 3, 4, 20])
      expect(imageBudget(count) * count).toBeLessThanOrEqual(700_000);
    expect(imageBudget(1)).toBe(700_000);
    expect(imageBudget(0)).toBe(700_000);
  });
});

import { describe, expect, it } from 'vitest';
import { shouldInjectProjectLearnedFile, shouldLearnFromTurn } from './localMemory';

describe('supervisor local-memory wiring (OMP-aligned)', () => {
  it('shouldInjectProjectLearnedFile always returns false', () => {
    expect(shouldInjectProjectLearnedFile()).toBe(false);
  });

  it('shouldLearnFromTurn always returns false', () => {
    expect(shouldLearnFromTurn()).toBe(false);
  });
});

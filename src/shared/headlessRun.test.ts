import { describe, expect, it } from 'vitest';
import { isHeadlessRun } from './headlessRun';

describe('isHeadlessRun', () => {
  it('只认 ENSO_HEADLESS_RUN=1', () => {
    expect(isHeadlessRun({})).toBe(false);
    expect(isHeadlessRun({ ENSO_HEADLESS_RUN: '0' })).toBe(false);
    expect(isHeadlessRun({ ENSO_HEADLESS_RUN: 'true' })).toBe(false);
    expect(isHeadlessRun({ ENSO_HEADLESS_RUN: '1' })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { shouldReloadRenderer } from './rendererGone';

describe('shouldReloadRenderer', () => {
  it('reloads killed and crash reasons, but not a clean exit', () => {
    expect(shouldReloadRenderer('killed', 1)).toBe(true);
    expect(shouldReloadRenderer('crashed', 1)).toBe(true);
    expect(shouldReloadRenderer('abnormal-exit', 1)).toBe(true);
    expect(shouldReloadRenderer('oom', 1)).toBe(true);
    expect(shouldReloadRenderer('launch-failed', 1)).toBe(true);
    expect(shouldReloadRenderer('integrity-failure', 1)).toBe(true);
    expect(shouldReloadRenderer('clean-exit', 1)).toBe(false);
  });

  it('stops reloading after three losses in the current window', () => {
    expect(shouldReloadRenderer('killed', 3)).toBe(true);
    expect(shouldReloadRenderer('killed', 4)).toBe(false);
  });
});

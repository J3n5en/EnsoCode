import { describe, expect, it } from 'vitest';
import { PAGE_LOCK_OVERLAY_SCRIPT, PAGE_UNLOCK_OVERLAY_SCRIPT } from './pageScripts';

describe('lock overlay scripts', () => {
  it('installs a full-page overlay and can remove it', () => {
    expect(PAGE_LOCK_OVERLAY_SCRIPT).toContain('enso-browser-lock-overlay');
    expect(PAGE_LOCK_OVERLAY_SCRIPT).toContain('preventDefault');
    expect(PAGE_UNLOCK_OVERLAY_SCRIPT).toContain('enso-browser-lock-overlay');
    expect(PAGE_UNLOCK_OVERLAY_SCRIPT).toContain('.remove()');
  });
});

import { describe, expect, it } from 'vitest';
import { clipGuestRect, rectsOverlap } from './guestViewOcclusion';

const guest = { x: 1000, y: 80, width: 400, height: 800 };
const windowSize = { width: 1400, height: 900 };

describe('rectsOverlap', () => {
  it('overlaps when menus drop into the guest rect', () => {
    expect(rectsOverlap(guest, { x: 1200, y: 40, width: 160, height: 80 })).toBe(true);
  });
});

describe('clipGuestRect', () => {
  it('crops the top strip under a new-tab menu, keeps the rest of the page', () => {
    const menu = { x: 1180, y: 50, width: 180, height: 70 };
    const clipped = clipGuestRect(guest, [menu], windowSize);
    expect(clipped).toEqual({ x: 1000, y: 120, width: 400, height: 760 });
  });

  it('ignores a full-window menu backdrop so the page does not go blank', () => {
    const backdrop = { x: 0, y: 0, width: 1400, height: 900 };
    const menu = { x: 1180, y: 50, width: 180, height: 70 };
    const clipped = clipGuestRect(guest, [backdrop, menu], windowSize);
    expect(clipped?.y).toBe(120);
    expect(clipped?.height).toBe(760);
  });

  it('leaves the guest alone when floats miss it', () => {
    expect(clipGuestRect(guest, [{ x: 20, y: 700, width: 280, height: 320 }], windowSize)).toEqual(
      guest
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  DROP_SHELF_MAX_PATHS,
  dropShelfBounds,
  dropShelfLayout,
  parseDropShelfDrop,
  parseDropShelfPaths,
  stepDragWatch,
} from './dropShelf';

describe('stepDragWatch', () => {
  const idle = { count: 5, dragging: false };
  const sample = (over: Partial<Parameters<typeof stepDragWatch>[1]> = {}) => ({
    count: 6,
    mouseDown: true,
    appActive: false,
    hasFiles: () => true,
    ...over,
  });

  it('starts when the drag pasteboard changes with files while the mouse is down', () => {
    expect(stepDragWatch(idle, sample())).toEqual({
      state: { count: 6, dragging: true },
      event: 'start',
    });
  });

  it('does not read the pasteboard types when nothing changed', () => {
    const hasFiles = vi.fn(() => true);
    expect(stepDragWatch(idle, sample({ count: 5, hasFiles })).event).toBeNull();
    expect(hasFiles).not.toHaveBeenCalled();
  });

  it('ignores drags without files, after release, or while the app itself is active', () => {
    expect(stepDragWatch(idle, sample({ hasFiles: () => false })).event).toBeNull();
    expect(stepDragWatch(idle, sample({ mouseDown: false })).event).toBeNull();
    expect(stepDragWatch(idle, sample({ appActive: true })).event).toBeNull();
    // 计数照样前进，松手后旧内容不会再触发
    expect(stepDragWatch(idle, sample({ mouseDown: false })).state).toEqual({
      count: 6,
      dragging: false,
    });
  });

  it('ends once the mouse is released', () => {
    const dragging = { count: 6, dragging: true };
    expect(stepDragWatch(dragging, sample({ mouseDown: true })).event).toBeNull();
    expect(stepDragWatch(dragging, sample({ mouseDown: false }))).toEqual({
      state: { count: 6, dragging: false },
      event: 'end',
    });
  });
});

describe('parseDropShelfPaths', () => {
  it('keeps unique absolute paths only', () => {
    expect(parseDropShelfPaths(['/a', '/a', 'rel', '', 3, null, '/b\0x', '/c'])).toEqual([
      '/a',
      '/c',
    ]);
  });

  it('rejects non-arrays and caps the count', () => {
    expect(parseDropShelfPaths('/a')).toEqual([]);
    const many = Array.from({ length: DROP_SHELF_MAX_PATHS + 10 }, (_, i) => `/f${i}`);
    expect(parseDropShelfPaths(many)).toHaveLength(DROP_SHELF_MAX_PATHS);
  });
});

describe('dropShelfBounds', () => {
  it('pins the shelf to the top-right corner of the work area', () => {
    expect(
      dropShelfBounds({ x: 1440, y: 25, width: 1920, height: 1055 }, { width: 360, height: 96 }, 8)
    ).toEqual({ x: 1440 + 1920 - 360 - 8, y: 25 + 8, width: 360, height: 96 });
  });
});

describe('dropShelfLayout', () => {
  it('offers the project choice only when a folder is being dragged', () => {
    expect(dropShelfLayout([false, false])).toBe('single');
    expect(dropShelfLayout([false, true])).toBe('choice');
  });

  it('falls back to the choice when the dragged paths are unknown', () => {
    expect(dropShelfLayout(null)).toBe('choice');
    expect(dropShelfLayout([])).toBe('choice');
  });
});

describe('parseDropShelfDrop', () => {
  it('accepts a known action with valid paths', () => {
    expect(parseDropShelfDrop({ action: 'project', paths: ['/a', 'rel'] })).toEqual({
      action: 'project',
      paths: ['/a'],
    });
    expect(parseDropShelfDrop({ action: 'attach', paths: ['/a'] })?.action).toBe('attach');
  });

  it('rejects unknown actions, empty paths and malformed payloads', () => {
    expect(parseDropShelfDrop({ action: 'delete', paths: ['/a'] })).toBeNull();
    expect(parseDropShelfDrop({ action: 'attach', paths: ['rel'] })).toBeNull();
    expect(parseDropShelfDrop(['/a'])).toBeNull();
    expect(parseDropShelfDrop(null)).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDropHighlightTracker,
  DROP_HIGHLIGHT_WATCHDOG_MS,
  dropZonesFor,
  pickDroppedDirectories,
  projectImportFollowUp,
} from './projectDrop';

describe('pickDroppedDirectories', () => {
  it('skips empty and whitespace paths', () => {
    expect(
      pickDroppedDirectories([
        { path: '', isDirectory: true },
        { path: '   ', isDirectory: true },
        { path: '/repo', isDirectory: true },
      ])
    ).toEqual({ directories: ['/repo'], skippedFiles: 0, truncated: false });
  });

  it('keeps only directory-marked paths and counts files once', () => {
    expect(
      pickDroppedDirectories([
        { path: '/notes.md', isDirectory: false },
        { path: '/app', isDirectory: true },
        { path: '/readme.txt', isDirectory: false },
        { path: '/lib', isDirectory: true },
      ])
    ).toEqual({ directories: ['/app', '/lib'], skippedFiles: 2, truncated: false });
  });

  it('dedupes directories by first occurrence', () => {
    expect(
      pickDroppedDirectories([
        { path: '/app', isDirectory: true },
        { path: '/app', isDirectory: true },
        { path: '/app/', isDirectory: true },
      ])
    ).toEqual({ directories: ['/app', '/app/'], skippedFiles: 0, truncated: false });
  });

  it('caps at 10 unique directories and reports truncation', () => {
    const paths = Array.from({ length: 12 }, (_, index) => ({
      path: `/proj-${index}`,
      isDirectory: true,
    }));
    const result = pickDroppedDirectories(paths);
    expect(result.directories).toEqual(Array.from({ length: 10 }, (_, index) => `/proj-${index}`));
    expect(result.truncated).toBe(true);
    expect(result.skippedFiles).toBe(0);
  });

  it('does not count files toward the directory cap', () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      path: `/file-${index}.txt`,
      isDirectory: false,
    }));
    const dirs = Array.from({ length: 3 }, (_, index) => ({
      path: `/dir-${index}`,
      isDirectory: true,
    }));
    expect(pickDroppedDirectories([...files, ...dirs])).toEqual({
      directories: ['/dir-0', '/dir-1', '/dir-2'],
      skippedFiles: 5,
      truncated: false,
    });
  });
});

describe('dropZonesFor', () => {
  const file = (type: string) => ({ kind: 'file', type });

  it('offers only the attach zone when every item has a MIME type (cannot be a folder)', () => {
    expect(
      dropZonesFor({
        types: ['Files'],
        items: [file('text/plain'), file('image/png')],
        composerReady: true,
      })
    ).toEqual({ project: false, attach: true });
  });

  it('offers both zones when an item may be a folder', () => {
    expect(
      dropZonesFor({ types: ['Files'], items: [file('text/plain'), file('')], composerReady: true })
    ).toEqual({ project: true, attach: true });
  });

  it('offers the project zone when the item list is unreadable', () => {
    expect(dropZonesFor({ types: ['Files'], items: [], composerReady: true })).toEqual({
      project: true,
      attach: true,
    });
  });

  it('drops the attach zone when no composer can take files', () => {
    expect(dropZonesFor({ types: ['Files'], items: [file('')], composerReady: false })).toEqual({
      project: true,
      attach: false,
    });
    expect(
      dropZonesFor({ types: ['Files'], items: [file('text/plain')], composerReady: false })
    ).toEqual({ project: false, attach: false });
  });

  it('offers nothing for drags that are not OS files', () => {
    expect(
      dropZonesFor({
        types: ['text/plain'],
        items: [{ kind: 'string', type: 'text/plain' }],
        composerReady: true,
      })
    ).toEqual({ project: false, attach: false });
  });
});

describe('createDropHighlightTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function track() {
    const states: boolean[] = [];
    const tracker = createDropHighlightTracker((active) => states.push(active));
    return { tracker, states, active: () => states.at(-1) === true };
  }

  it('resets on Escape inside the window even though leave never reached depth 0', () => {
    const { tracker, active } = track();
    tracker.enter(true);
    tracker.enter(true);
    tracker.leave();
    expect(active()).toBe(true);
    tracker.cancel();
    expect(active()).toBe(false);
  });

  it('resets when dragover stops arriving (drag pulled out along the edge)', () => {
    const { tracker, active } = track();
    tracker.enter(true);
    tracker.enter(true);
    tracker.leave();
    vi.advanceTimersByTime(DROP_HIGHLIGHT_WATCHDOG_MS - 1);
    tracker.over(true);
    vi.advanceTimersByTime(DROP_HIGHLIGHT_WATCHDOG_MS - 1);
    expect(active()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(active()).toBe(false);
  });

  it('resets as soon as enter/leave depth returns to 0', () => {
    const { tracker, active } = track();
    tracker.enter(true);
    tracker.enter(true);
    tracker.leave();
    tracker.leave();
    expect(active()).toBe(false);
  });

  it('never highlights for non-file drags', () => {
    const { tracker, states } = track();
    tracker.enter(false);
    tracker.over(false);
    tracker.leave();
    expect(states).toEqual([]);
  });
});

describe('projectImportFollowUp', () => {
  it('starts a new conversation for a newly added project', () => {
    expect(
      projectImportFollowUp({
        projectId: 'p-new',
        knownIds: new Set(['p-old']),
        archivedIds: ['p-old'],
        collapsed: { 'p-old': true },
        latestConversationId: 'c-old',
      })
    ).toEqual({
      archivedIds: ['p-old'],
      collapsed: { 'p-old': true },
      focus: { kind: 'new' },
    });
  });

  it('unarchives, expands, and selects the latest chat when re-adding a known project', () => {
    expect(
      projectImportFollowUp({
        projectId: 'p1',
        knownIds: new Set(['p1']),
        archivedIds: ['p1', 'p2'],
        collapsed: { p1: true, p2: true },
        latestConversationId: 'c1',
      })
    ).toEqual({
      archivedIds: ['p2'],
      collapsed: { p1: false, p2: true },
      focus: { kind: 'select', conversationId: 'c1' },
    });
  });

  it('creates a conversation when the known project has none', () => {
    expect(
      projectImportFollowUp({
        projectId: 'p1',
        knownIds: new Set(['p1']),
        archivedIds: [],
        collapsed: { p1: true },
        latestConversationId: undefined,
      })
    ).toEqual({
      archivedIds: [],
      collapsed: { p1: false },
      focus: { kind: 'new' },
    });
  });
});

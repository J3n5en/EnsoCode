import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDropHighlightTracker,
  DROP_HIGHLIGHT_WATCHDOG_MS,
  pickDroppedDirectories,
  projectImportFollowUp,
  shouldAcceptProjectDrop,
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

describe('shouldAcceptProjectDrop', () => {
  it('leaves file-only drops to the composer even while the highlight is on', () => {
    const tracker = createDropHighlightTracker(() => undefined);
    tracker.enter(true);
    expect(
      shouldAcceptProjectDrop({
        types: ['Files'],
        entries: [{ isDirectory: false }, { isDirectory: false }],
      })
    ).toBe(false);
    tracker.dispose();
  });

  it('takes over when the drop contains a directory', () => {
    expect(
      shouldAcceptProjectDrop({
        types: ['Files'],
        entries: [{ isDirectory: false }, { isDirectory: true }],
      })
    ).toBe(true);
  });

  it('ignores drags that are not OS files', () => {
    expect(
      shouldAcceptProjectDrop({ types: ['text/plain'], entries: [{ isDirectory: true }] })
    ).toBe(false);
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

import { describe, expect, it } from 'vitest';
import {
  pickDroppedDirectories,
  projectImportFollowUp,
  shouldOfferProjectDrop,
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

describe('shouldOfferProjectDrop', () => {
  it('ignores drags that are not OS files', () => {
    expect(shouldOfferProjectDrop({ types: ['text/plain'] })).toBe(false);
  });

  it('offers overlay when Files are present and entries cannot be inspected', () => {
    expect(shouldOfferProjectDrop({ types: ['Files'] })).toBe(true);
  });

  it('does not steal file-only drops meant for the composer', () => {
    expect(
      shouldOfferProjectDrop({
        types: ['Files'],
        items: [
          { kind: 'file', isDirectory: false },
          { kind: 'file', isDirectory: false },
        ],
      })
    ).toBe(false);
  });

  it('offers overlay when at least one dropped item is a directory', () => {
    expect(
      shouldOfferProjectDrop({
        types: ['Files'],
        items: [
          { kind: 'file', isDirectory: false },
          { kind: 'file', isDirectory: true },
        ],
      })
    ).toBe(true);
  });

  it('offers overlay when file items exist but directory flags are unknown', () => {
    expect(
      shouldOfferProjectDrop({
        types: ['Files'],
        items: [{ kind: 'file' }, { kind: 'file' }],
      })
    ).toBe(true);
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

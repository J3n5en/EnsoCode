import { realpathSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARCHIVED_PROJECTS_KEY,
  readSidebarOrder,
  subscribeSidebarOrder,
} from '@/stores/settings/sidebarOrderStorage';
import {
  importLocalProject,
  isNotDirectoryError,
  isSkippableProjectPathError,
} from './importLocalProject';

const state = vi.hoisted(() => ({
  projects: [] as { id: string }[],
  addProject: vi.fn(),
  order: [] as string[],
  conversations: {} as Record<string, unknown>,
  selectConversation: vi.fn(),
  newConversation: vi.fn(),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => ({
      projects: state.projects,
      projectGroups: [],
      addProject: state.addProject,
    }),
  },
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: {
    getState: () => ({
      order: state.order,
      conversations: state.conversations,
      selectConversation: state.selectConversation,
      newConversation: state.newConversation,
    }),
  },
}));

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('window', new EventTarget());
  state.projects = [{ id: 'p1' }];
  state.order = ['c1'];
  state.conversations = { c1: { projectId: 'p1', createdAt: 1, messages: [] } };
  state.addProject.mockResolvedValue({ id: 'p1', path: '/repo' });
  state.newConversation.mockResolvedValue('c-new');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('importLocalProject', () => {
  it('selects the latest chat of a known project through onSelect instead of creating one', async () => {
    const onSelect = vi.fn();
    await importLocalProject('/repo', { onSelect });
    expect(onSelect).toHaveBeenCalledWith('c1');
    expect(state.selectConversation).not.toHaveBeenCalled();
    expect(state.newConversation).not.toHaveBeenCalled();
  });

  it('unarchives a re-added project and notifies sidebar order subscribers', async () => {
    localStorage.setItem(ARCHIVED_PROJECTS_KEY, JSON.stringify(['p1', 'p2']));
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarOrder(listener);
    await importLocalProject('/repo');
    unsubscribe();
    expect(listener).toHaveBeenCalled();
    expect(readSidebarOrder(ARCHIVED_PROJECTS_KEY)).toEqual(['p2']);
  });

  it('creates a conversation for a new project', async () => {
    state.projects = [];
    await importLocalProject('/repo');
    expect(state.newConversation).toHaveBeenCalledWith('p1');
  });

  it('rejects when no conversation could be created', async () => {
    state.projects = [];
    state.newConversation.mockResolvedValue('');
    await expect(importLocalProject('/repo')).rejects.toThrow();
  });
});

describe('project path errors from Main', () => {
  function realpathError(): Error {
    try {
      realpathSync('/definitely/missing/enso-project');
    } catch (error) {
      return new Error((error as Error).message);
    }
    throw new Error('expected realpathSync to fail');
  }

  it('treats the authority not-a-directory error as a skipped file', () => {
    const error = new Error('Project path is not a directory.');
    expect(isNotDirectoryError(error)).toBe(true);
    expect(isSkippableProjectPathError(error)).toBe(true);
  });

  it('skips missing paths reported by realpathSync without counting them as files', () => {
    const error = realpathError();
    expect(error.message).toMatch(/^ENOENT/);
    expect(isSkippableProjectPathError(error)).toBe(true);
    expect(isNotDirectoryError(error)).toBe(false);
  });

  it('does not swallow unrelated failures', () => {
    expect(isSkippableProjectPathError(new Error('Project kind is reserved.'))).toBe(false);
  });
});

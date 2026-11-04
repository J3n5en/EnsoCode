import type { SessionWorktree, WorkspaceBranches, WorktreeStatus } from '@shared/types/worktree';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@/stores/sessions';
import type { WorkspaceBranchListProps } from './WorkspaceBranchList';
import { WorktreeBadge, worktreeHoverText } from './WorktreeBadge';
import { WorktreePicker } from './WorktreePicker';

const harness = vi.hoisted(() => ({
  conversations: {} as Record<string, Conversation>,
  statuses: {} as Record<string, WorktreeStatus>,
  projectKind: 'local',
  states: [] as unknown[],
  cursor: 0,
  popup: null as ReactNode,
  runEffects: false,
  effectCursor: 0,
  effectDeps: [] as (readonly unknown[] | undefined)[],
  pendingEffects: [] as (() => unknown)[],
  changeQuery: (_value: string) => {},
  createBranch: () => {},
  onOpenChange: (_open: boolean) => {},
  branches: vi.fn(),
  addToast: vi.fn(),
}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
    if (!harness.runEffects) return;
    const index = harness.effectCursor++;
    const previous = harness.effectDeps[index];
    if (!deps || !previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
      harness.pendingEffects.push(effect);
    }
    harness.effectDeps[index] = deps;
  },
  useState: <T>(initial: T) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [
      harness.states[index],
      (value: T) => {
        harness.states[index] = value;
      },
    ];
  },
}));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.addToast }));
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      Object.entries(params ?? {}).reduce(
        (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
        key
      ),
  }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (selector: (state: unknown) => unknown) =>
    selector({
      conversations: harness.conversations,
      worktreeStatuses: harness.statuses,
      workspaceRevisionByConversation: {},
    }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ projects: [{ id: 'project', kind: harness.projectKind }] }),
}));
vi.mock('@/components/ui/popover', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children?: ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) => {
      harness.onOpenChange = onOpenChange;
      return createElement('div', { 'data-open': open }, children);
    },
    PopoverPopup: ({ children }: { children?: ReactNode }) => {
      harness.popup = children;
      return createElement(Wrap, null, children);
    },
    PopoverTrigger: ({
      children,
      disabled,
      title,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      title?: string;
    }) => createElement('button', { disabled, title, type: 'button' }, children),
  };
});
vi.mock('@/components/chat/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('./WorktreeRenameDialog', () => ({ WorktreeRenameDialog: () => null }));
vi.mock('./WorkspaceBranchDialog', () => ({
  WorkspaceBranchDialog: () => createElement('div', { role: 'dialog' }, 'Create branch'),
}));
vi.mock('./WorkspaceBranchList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./WorkspaceBranchList')>();
  return {
    WorkspaceBranchList: (props: WorkspaceBranchListProps) => {
      harness.createBranch = props.onCreate;
      return createElement(actual.WorkspaceBranchList, props);
    },
  };
});
vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => {
    const onChange = props.onChange;
    harness.changeQuery = (value) => {
      if (typeof onChange === 'function') onChange({ target: { value } });
    };
    return createElement('input', props);
  },
}));

const worktree: SessionWorktree = {
  conversationId: 'source',
  projectId: 'project',
  repoPath: '/repo',
  path: '/worktrees/task',
  branch: 'feature/task',
  baseBranch: 'main',
  baseCommit: 'abc',
  createdAt: 1,
  name: 'Readable task',
};
const conversation = (id: string, extra: Partial<Conversation> = {}): Conversation =>
  ({
    id,
    projectId: 'project',
    title: '',
    messages: [],
    status: 'idle',
    spawning: false,
    createdAt: 1,
    started: false,
    ...extra,
  }) as Conversation;
const render = (conversationId = 'current') => {
  harness.cursor = 0;
  harness.effectCursor = 0;
  const html = renderToStaticMarkup(createElement(WorktreePicker, { conversationId }));
  for (const effect of harness.pendingEffects.splice(0)) effect();
  return html;
};
const click = (label: string, children = harness.popup): boolean => {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) continue;
    if (child.type === 'button' && renderToStaticMarkup(child).includes(label)) {
      child.props.onClick?.();
      return true;
    }
    if (click(label, child.props.children ?? null)) return true;
  }
  return false;
};
const loadBranches = async (overrides: Partial<WorkspaceBranches> = {}) => {
  const data: WorkspaceBranches = {
    currentBranch: 'trunk',
    defaultBranch: 'trunk',
    headCommit: 'abc',
    affectedConversationIds: ['current'],
    branches: [
      { name: 'trunk', occupied: false },
      { name: 'feature/task', occupied: false },
    ],
    ...overrides,
  };
  harness.branches.mockResolvedValue({ ok: true, value: data });
  render();
  harness.onOpenChange(true);
  await Promise.resolve();
  return render();
};

beforeEach(() => {
  harness.conversations = {
    current: conversation('current'),
    source: conversation('source', { worktree }),
  };
  harness.statuses = {};
  harness.projectKind = 'local';
  harness.states = [];
  harness.runEffects = false;
  harness.effectDeps = [];
  harness.pendingEffects = [];
  harness.branches.mockReset().mockResolvedValue({ ok: false, code: 'unavailable' });
  harness.addToast.mockClear();
  vi.stubGlobal('window', {
    electronAPI: { worktree: { branches: harness.branches } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('WorktreePicker', () => {
  it('首次展开以工作区为主体，分支搜索和创建仅在二级入口显示', () => {
    const html = render();
    expect(html).toContain('Local workspace');
    expect(html).toContain('Switch branch');
    expect(html).not.toContain('Search local branches');
    expect(html).not.toContain('Create branch from HEAD…');
    expect(html).not.toContain('Loading...');
    expect(click('Switch branch')).toBe(true);
    const branches = render();
    expect(branches).toContain('Search local branches');
    expect(branches).toContain('Create branch from HEAD…');
    expect(branches).not.toContain('New isolated worktree');
    expect(branches).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Create branch from HEAD…/);
    expect(branches).toContain('Switching branches affects all conversations in this workspace.');
  });
  it('二级视图可以返回，关闭再打开始终恢复工作区页', async () => {
    await loadBranches();
    expect(click('Switch branch')).toBe(true);
    render();
    expect(click('Back to workspaces')).toBe(true);
    expect(render()).toContain('New isolated worktree');
    expect(click('Switch branch')).toBe(true);
    render();
    harness.onOpenChange(false);
    harness.onOpenChange(true);
    await Promise.resolve();
    expect(render()).not.toContain('Search local branches');
    expect(render()).toContain('New isolated worktree');
  });
  it.each(['conversation', 'workspace'])('%s 变化后关闭二级页并清空搜索', (change) => {
    harness.runEffects = true;
    harness.branches.mockImplementation(() => new Promise(() => {}));
    render();
    harness.onOpenChange(true);
    render();
    expect(click('Switch branch')).toBe(true);
    render();
    harness.changeQuery('feature/old');
    expect(render()).toContain('value="feature/old"');
    if (change === 'workspace') harness.conversations.current.worktree = worktree;
    const nextId = change === 'conversation' ? 'source' : 'current';
    render(nextId);
    const html = render(nextId);
    expect(html).toContain('data-open="false"');
    expect(html).not.toContain('Search local branches');
    expect(html).toContain('Local workspace');
    harness.onOpenChange(true);
    render(nextId);
    expect(click('Switch branch')).toBe(true);
    expect(render(nextId)).toContain('value=""');
    expect(render(nextId)).not.toContain('feature/old');
  });
  it('A 的创建分支弹窗在切到 B 再返回 A 后不会复活', async () => {
    await loadBranches();
    expect(click('Switch branch')).toBe(true);
    render();
    harness.createBranch();
    expect(render()).toContain('role="dialog"');
    harness.runEffects = true;
    harness.branches.mockImplementation(() => new Promise(() => {}));
    render('source');
    expect(render('source')).not.toContain('role="dialog"');
    render('current');
    expect(render('current')).not.toContain('role="dialog"');
    expect(render('current')).toContain('data-open="false"');
  });
  it.each(['trunk', 'release/stable'])('权威默认分支 %s 不占工具栏空间', async (branch) => {
    const html = await loadBranches({ currentBranch: branch, defaultBranch: branch });
    expect(html).toContain('truncate">Local</span>');
    expect(html).not.toContain(`Local · ${branch}`);
  });
  it('隔离工作区默认分支只显示工作区名称', async () => {
    harness.conversations.current.worktree = worktree;
    const html = await loadBranches({
      currentBranch: 'feature/task',
      defaultBranch: 'feature/task',
    });
    expect(html).toContain('truncate">Readable task</span>');
    expect(html).not.toContain('Readable task · feature/task');
  });
  it.each(['main', 'master', 'feature/task'])('默认分支未知时不猜测隐藏 %s', async (branch) => {
    expect(await loadBranches({ currentBranch: branch, defaultBranch: null })).toContain(
      `Local · ${branch}`
    );
  });
  it('旧版响应缺少默认分支元数据时保留分支后缀', async () => {
    expect(await loadBranches({ currentBranch: 'main', defaultBranch: undefined })).toContain(
      'Local · main'
    );
  });
  it('非默认分支继续使用紧凑分支后缀', async () => {
    expect(await loadBranches({ currentBranch: 'feature/task' })).toContain('Local · feature/task');
  });
  it('分离 HEAD 不会被未知默认分支隐藏', async () => {
    expect(await loadBranches({ currentBranch: null, defaultBranch: null })).toContain(
      'Local · Detached HEAD'
    );
  });
  it('非 Git 查询失败不打扰工作区页，进入分支页才展示错误与重试', async () => {
    render();
    harness.onOpenChange(true);
    await Promise.resolve();
    expect(render()).not.toContain('role="alert"');
    expect(render()).not.toContain('Retry');
    expect(harness.addToast).not.toHaveBeenCalled();
    expect(click('Switch branch')).toBe(true);
    await Promise.resolve();
    expect(render()).toContain('role="alert"');
    expect(render()).toContain('Retry');
  });
  it('入口保留工作区名称并附加分支，而不改变 Sidebar 徽标', () => {
    harness.conversations.current.worktree = worktree;
    expect(render()).toContain('Readable task · feature/task');
  });
  it('offers one existing worktree per path alongside the new isolation entry', () => {
    harness.conversations.duplicate = conversation('duplicate', { worktree, archived: true });
    const html = render();
    expect(html).toContain('Local workspace');
    expect(html).toContain('New isolated worktree');
    expect(html).toContain('Existing worktrees');
    expect(html.match(/block truncate">Readable task</g)).toHaveLength(1);
    expect(html).toContain('/worktrees/task');
  });
  it('hides existing worktree attachment after history exists', () => {
    harness.conversations.current.sessionFile = '/history.jsonl';
    expect(render()).not.toContain('Existing worktrees');
    expect(render()).toContain('New isolated worktree');
  });
  it('shows the current display name and both worktree actions', () => {
    harness.conversations.current.worktree = worktree;
    const html = render();
    expect(html).toContain('Readable task');
    expect(html).toContain('New conversation in this worktree');
    expect(html).toContain('Rename worktree');
    expect(html).not.toContain('Existing worktrees');
  });
  it('disables the picker while the conversation is busy', () => {
    harness.conversations.current.workspaceMigrating = true;
    expect(render()).toContain('<button disabled=""');
  });
  it('does not offer unavailable worktrees', () => {
    harness.statuses.source = { exists: false, dirty: false, ahead: 0 };
    expect(render()).not.toContain('Existing worktrees');
  });
  it('hides worktree UI for child conversations and SSH projects', () => {
    harness.conversations.current.parentId = 'parent';
    expect(render()).toBe('');
    delete harness.conversations.current.parentId;
    harness.projectKind = 'ssh';
    expect(render()).toBe('');
  });
});

describe('WorktreeBadge', () => {
  const t = (key: string, params?: Record<string, string | number>) =>
    key.replace('{{n}}', String(params?.n));
  it('keeps full name, branch, path and both dirty/ahead states in hover text', () => {
    expect(worktreeHoverText(worktree, { exists: true, dirty: true, ahead: 2 }, t)).toBe(
      'Readable task\nfeature/task\n/worktrees/task\nUncommitted changes · 2 unmerged commits'
    );
    const html = renderToStaticMarkup(createElement(WorktreeBadge, { worktree }));
    expect(html).toContain('data-slot="worktree-label"');
    expect(html).toContain('title="Readable task\nfeature/task\n/worktrees/task');
    expect(html).not.toContain('>Readable task<');
    expect(html).toContain('lucide-git-branch');
  });
  it('distinguishes missing and unknown status from clean worktrees', () => {
    expect(worktreeHoverText(worktree, undefined, t)).toContain('Worktree status unknown');
    expect(worktreeHoverText(worktree, { exists: false, dirty: false, ahead: 0 }, t)).toContain(
      'Worktree missing'
    );
    expect(worktreeHoverText(worktree, { exists: true, dirty: false, ahead: 0 }, t)).toContain(
      'Working tree clean'
    );
  });
});

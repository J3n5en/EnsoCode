import type { GitFile } from '@shared/types/git';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitChangesView } from './GitChangesView';
import type { GitFileDirectory } from './GitFileList';
import { type PanelActivitySource, PanelVisibilityProvider } from './panelVisibility';

const harness = vi.hoisted(() => ({
  git: {
    status: vi.fn(),
    fileDiff: vi.fn(),
    discard: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
  },
  sessions: {
    activeId: 'a' as string | null,
    refreshWorktreeStatuses: () => Promise.resolve(),
  },
  sidePanel: { uiByConversation: {} as Record<string, { open: boolean; width: number }> },
}));
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name])),
  }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: Object.assign(
    (select: (state: unknown) => unknown) => select(harness.sessions),
    { getState: () => harness.sessions }
  ),
}));
vi.mock('@/stores/sidePanel', () => ({
  useSidePanelStore: (select: (state: unknown) => unknown) => select(harness.sidePanel),
  useSidePanelShown: (id: string) =>
    Boolean(
      (harness.sidePanel as { uiByConversation: Record<string, { open?: boolean }> })
        .uiByConversation[id]?.open
    ),
}));
vi.mock('@/components/chat/ConfirmDialog', () => ({
  ConfirmDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    props.open ? (
      <div data-confirm-dialog="">
        <p data-confirm-title="">{props.title}</p>
        <p data-confirm-description="">{props.description}</p>
        <button
          type="button"
          data-confirm-ok=""
          onClick={() => {
            props.onConfirm();
            props.onOpenChange(false);
          }}
        >
          {props.confirmLabel}
        </button>
        <button type="button" data-confirm-cancel="" onClick={() => props.onOpenChange(false)} />
      </div>
    ) : null,
}));
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ render }: { render?: ReactElement }) => render ?? null,
  ContextMenuPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ContextMenuSeparator: () => null,
  ContextMenuItem: ({
    variant: _variant,
    ...props
  }: ComponentProps<'button'> & { variant?: string }) => <button type="button" {...props} />,
}));
vi.mock('@/components/ui/menu', () => ({
  Menu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ render: _render, ...props }: ComponentProps<'button'> & { render?: unknown }) => (
    <button type="button" {...props} />
  ),
  MenuPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MenuSeparator: () => null,
  MenuItem: ({ variant: _variant, ...props }: ComponentProps<'button'> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock('@/components/ui/input-group', () => ({
  InputGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  InputGroupAddon: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  InputGroupInput: ({ size: _size, ...props }: ComponentProps<'input'> & { size?: string }) => (
    <input {...props} />
  ),
}));
vi.mock('@/components/ui/textarea', () => ({ Textarea: () => <textarea /> }));
vi.mock('./GitDiffPreview', () => ({ GitDiffPreview: () => null }));
vi.mock('./GitHistoryView', () => ({ GitHistoryView: () => null }));
vi.mock('./GitPanelLayout', () => ({
  GitPanelLayout: ({
    navigation,
    actions,
    children,
  }: {
    navigation: ReactNode;
    actions?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      {actions}
      {navigation}
      {children}
    </div>
  ),
}));
vi.mock('./GitFileList', () => ({
  GitFileList: ({
    files,
    tree,
    renderDirectory,
    children,
  }: {
    files: GitFile[];
    tree: boolean;
    renderDirectory?: (directory: GitFileDirectory, trigger: ReactElement) => ReactNode;
    children: (file: GitFile) => ReactNode;
  }) => {
    const directories = new Map<string, GitFileDirectory>();
    if (tree && renderDirectory) {
      for (const file of files) {
        const parts = file.path.split('/').slice(0, -1);
        let current = '';
        for (const name of parts) {
          current = current ? `${current}/${name}` : name;
          let entry = directories.get(current);
          if (!entry) {
            entry = { name, path: current, files: [] };
            directories.set(current, entry);
          }
          entry.files.push(file);
        }
      }
    }
    return (
      <>
        {[...directories.values()].map((directory) => (
          <div key={`dir:${directory.path}`} data-git-dir={directory.path}>
            {renderDirectory?.(directory, <button type="button">{directory.name}</button>)}
          </div>
        ))}
        {files.map((file) => (
          <div key={file.path}>{children(file)}</div>
        ))}
      </>
    );
  },
  GitFileViewToggle: () => null,
}));
vi.mock('./GitFileRow', () => ({
  GitFileRow: ({ file, onSelect }: { file: GitFile; onSelect: () => void }) => (
    <button type="button" data-git-file={file.path} onClick={onSelect} />
  ),
}));

const panel: PanelActivitySource = {
  isActive: true,
  isVisible: true,
  onDidActiveChange: () => ({ dispose() {} }),
  onDidVisibilityChange: () => ({ dispose() {} }),
};
const statusWith = (unstaged: GitFile[] = [], staged: GitFile[] = []) => ({
  ok: true,
  branch: 'main',
  head: 'abc',
  upstream: null,
  ahead: 0,
  behind: 0,
  staged,
  unstaged,
});

let root: Root;
let container: HTMLElement;
/** 会话 a 的 dock 里的 Git 面板；store 替身不会推送变化，切会话后重新 render 一次 */
async function render() {
  await act(async () =>
    root.render(
      <PanelVisibilityProvider dockConversationId="a" api={panel}>
        <GitChangesView
          conversationId="a"
          projectId="project"
          disabled={false}
          unavailable={false}
          editWriteKey=""
        />
      </PanelVisibilityProvider>
    )
  );
}
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // 窗口在前台且聚焦：旧逻辑只看这两项就会轮询
  Object.defineProperty(dom.document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.assign(dom.document, { hasFocus: () => true });
  Object.assign(dom.window, { electronAPI: { git: harness.git } });
  // react-dom 在无 window 时加载，onChange 走 IE 兜底，需要 attachEvent / detachEvent
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent: vi.fn(), detachEvent: vi.fn() });
  harness.git.status.mockReset().mockResolvedValue(statusWith());
  harness.git.discard.mockReset().mockResolvedValue({ ok: true });
  harness.git.stage.mockReset().mockResolvedValue({ ok: true });
  harness.git.unstage.mockReset().mockResolvedValue({ ok: true });
  harness.git.fileDiff
    .mockReset()
    .mockResolvedValue({ ok: true, path: 'src/x.ts', oldText: 'a', newText: 'b' });
  harness.sessions.activeId = 'a';
  harness.sidePanel.uiByConversation = {
    a: { open: true, width: 400 },
    b: { open: true, width: 400 },
  };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GitChangesView 只在面板可见时读 Git', () => {
  // 真实场景：隐藏会话里的 Git 面板仍每 5 秒跑 git status，和 agent 的 git 操作抢 index.lock
  it('隐藏会话里的 Git 面板不跑 git status，切回该会话后立即刷新并恢复轮询', async () => {
    harness.sessions.activeId = 'b';
    await render();
    await advance(15_000);
    expect(harness.git.status).not.toHaveBeenCalled();
    harness.sessions.activeId = 'a';
    await render();
    expect(harness.git.status).toHaveBeenCalledTimes(1);
    await advance(5_000);
    expect(harness.git.status).toHaveBeenCalledTimes(2);
  });

  it('切到别的会话后，不再轮询选中文件的 diff', async () => {
    harness.git.status.mockResolvedValue(statusWith([{ path: 'src/x.ts', status: 'modified' }]));
    await render();
    const row = container.querySelector('[data-git-file="src/x.ts"]');
    expect(row).not.toBeNull();
    await act(async () => (row as HTMLButtonElement).click());
    expect(harness.git.fileDiff).toHaveBeenCalledTimes(1);
    harness.sessions.activeId = 'b';
    await render();
    harness.git.fileDiff.mockClear();
    harness.git.status.mockClear();
    await advance(15_000);
    expect(harness.git.fileDiff).not.toHaveBeenCalled();
    expect(harness.git.status).not.toHaveBeenCalled();
  });
});

const mixed = () =>
  statusWith(
    [
      { path: 'src/m.ts', status: 'modified' },
      { path: 'src/d.ts', status: 'deleted' },
      { path: 'src/c.ts', status: 'conflicted' },
      { path: 'new/a.ts', status: 'untracked' },
      { path: 'new/b.ts', status: 'untracked' },
    ],
    [{ path: 'src/s.ts', status: 'modified' }]
  );
const clean = () =>
  statusWith(
    [
      { path: 'src/m.ts', status: 'modified' },
      { path: 'src/d.ts', status: 'deleted' },
      { path: 'new/a.ts', status: 'untracked' },
      { path: 'new/b.ts', status: 'untracked' },
    ],
    [{ path: 'src/s.ts', status: 'modified' }]
  );
const q = (selector: string) => container.querySelector(selector) as HTMLElement | null;
const groupToggle = (id: string) => q(`[data-git-group="${id}"] [aria-expanded]`);
const option = (id: string) => q(`[data-discard-option="${id}"]`) as HTMLButtonElement | null;
async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => element?.click());
}
async function search(value: string) {
  const input = q('input[type="search"]');
  expect(input).not.toBeNull();
  await act(async () => {
    input?.dispatchEvent(new window.Event('focusin', { bubbles: true }));
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, value);
    input?.dispatchEvent(Object.assign(new window.Event('keyup', { bubbles: true }), { key: 'a' }));
  });
}

describe('GitChangesView 分组折叠', () => {
  it('已暂存默认收起：标题与数量可见，文件行不渲染；其余组默认展开', async () => {
    harness.git.status.mockResolvedValue(mixed());
    await render();
    const staged = groupToggle('staged');
    expect(staged?.getAttribute('aria-expanded')).toBe('false');
    expect(staged?.textContent).toContain('Staged changes');
    expect(staged?.textContent).toContain('1');
    expect(q('[data-git-file="src/s.ts"]')).toBeNull();
    expect(groupToggle('unstaged')?.getAttribute('aria-expanded')).toBe('true');
    expect(groupToggle('untracked')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-git-file="src/m.ts"]')).not.toBeNull();
    expect(q('[data-git-file="new/a.ts"]')).not.toBeNull();
  });

  it('点击标题切换展开/收起', async () => {
    harness.git.status.mockResolvedValue(mixed());
    await render();
    await click(groupToggle('staged'));
    expect(groupToggle('staged')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-git-file="src/s.ts"]')).not.toBeNull();
    await click(groupToggle('untracked'));
    expect(groupToggle('untracked')?.getAttribute('aria-expanded')).toBe('false');
    expect(q('[data-git-file="new/a.ts"]')).toBeNull();
    expect(groupToggle('untracked')?.textContent).toContain('2');
  });

  it('搜索有命中时强制展开已收起的组', async () => {
    harness.git.status.mockResolvedValue(mixed());
    await render();
    await search('s.ts');
    expect(groupToggle('staged')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-git-file="src/s.ts"]')).not.toBeNull();
  });

  it('收起的组里有冲突文件时，标题上提示冲突数', async () => {
    harness.git.status.mockResolvedValue(
      statusWith(
        [{ path: 'src/c.ts', status: 'conflicted' }],
        [
          { path: 'src/s.ts', status: 'modified' },
          { path: 'src/c.ts', status: 'conflicted' },
        ]
      )
    );
    await render();
    expect(groupToggle('staged')?.textContent).toContain('1 conflicted');
    expect(groupToggle('unstaged')?.textContent).not.toContain('conflicted');
    await click(groupToggle('unstaged'));
    expect(groupToggle('unstaged')?.textContent).toContain('1 conflicted');
  });
});

describe('GitChangesView 放弃入口', () => {
  it('放弃所有：已跟踪与未跟踪分开调用，只有未跟踪那次 confirmUntracked 为 true', async () => {
    harness.git.status.mockResolvedValue(clean());
    await render();
    await click(option('all'));
    expect(harness.git.discard).not.toHaveBeenCalled();
    const statusCalls = harness.git.status.mock.calls.length;
    await click(q('[data-confirm-ok]'));
    expect(harness.git.discard.mock.calls).toEqual([
      [
        {
          conversationId: 'a',
          projectId: 'project',
          paths: ['src/m.ts', 'src/d.ts'],
          confirmUntracked: false,
        },
      ],
      [
        {
          conversationId: 'a',
          projectId: 'project',
          paths: ['new/a.ts', 'new/b.ts'],
          confirmUntracked: true,
        },
      ],
    ]);
    expect(harness.git.status.mock.calls.length).toBeGreaterThan(statusCalls);
  });

  it('放弃所有：已跟踪部分被拒绝时不再删除未跟踪文件', async () => {
    harness.git.status.mockResolvedValue(clean());
    harness.git.discard.mockResolvedValueOnce({ ok: false, error: 'stale' });
    await render();
    await click(option('all'));
    await click(q('[data-confirm-ok]'));
    expect(harness.git.discard).toHaveBeenCalledTimes(1);
  });

  it('有冲突文件时放弃所有与放弃跟踪都禁用（Main 会整批拒绝）', async () => {
    harness.git.status.mockResolvedValue(mixed());
    await render();
    expect(option('all')?.disabled).toBe(true);
    expect(option('untracked')?.disabled).toBe(true);
  });

  it('放弃所有的确认文案分别写明已跟踪修改数量与未跟踪文件数量（不可恢复）', async () => {
    harness.git.status.mockResolvedValue(clean());
    await render();
    await click(option('all'));
    const description = q('[data-confirm-description]')?.textContent ?? '';
    expect(description).toContain('Unstaged changes in 2 tracked files will be lost');
    expect(description).toContain(
      '2 untracked files will be permanently deleted and cannot be recovered.'
    );
    expect(q('[data-confirm-ok]')?.textContent).toBe('Discard and delete 2 untracked files');
  });

  it('放弃跟踪：只传未跟踪文件', async () => {
    harness.git.status.mockResolvedValue(clean());
    await render();
    await click(option('untracked'));
    expect(q('[data-confirm-description]')?.textContent).toContain(
      '2 untracked files will be permanently deleted and cannot be recovered.'
    );
    await click(q('[data-confirm-ok]'));
    expect(harness.git.discard).toHaveBeenCalledTimes(1);
    expect(harness.git.discard).toHaveBeenCalledWith({
      conversationId: 'a',
      projectId: 'project',
      paths: ['new/a.ts', 'new/b.ts'],
      confirmUntracked: true,
    });
  });

  it('没有未跟踪文件时放弃跟踪禁用；只有已跟踪修改时放弃所有不删文件', async () => {
    harness.git.status.mockResolvedValue(statusWith([{ path: 'src/m.ts', status: 'modified' }]));
    await render();
    expect(option('untracked')?.disabled).toBe(true);
    expect(option('all')?.disabled).toBe(false);
    await click(option('all'));
    await click(q('[data-confirm-ok]'));
    expect(harness.git.discard).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ['src/m.ts'], confirmUntracked: false })
    );
  });

  it('未暂存为空时放弃所有与放弃跟踪都禁用', async () => {
    harness.git.status.mockResolvedValue(
      statusWith([], [{ path: 'src/s.ts', status: 'modified' }])
    );
    await render();
    expect(option('all')?.disabled).toBe(true);
    expect(option('untracked')?.disabled).toBe(true);
    expect(option('cancel')?.disabled).toBe(false);
  });

  it('取消不弹确认、不调用 discard', async () => {
    harness.git.status.mockResolvedValue(mixed());
    await render();
    await click(option('cancel'));
    expect(q('[data-confirm-dialog]')).toBeNull();
    expect(harness.git.discard).not.toHaveBeenCalled();
  });
});

describe('GitChangesView 文件夹右键菜单', () => {
  const dirAction = (groupId: string, path: string, action: 'stage' | 'unstage' | 'discard') =>
    q(
      `[data-git-group="${groupId}"] [data-git-dir-path="${path}"][data-git-dir-action="${action}"]`
    ) as HTMLButtonElement | null;

  const nestedStatus = () =>
    statusWith(
      [
        { path: 'src/a/one.ts', status: 'modified' },
        { path: 'src/a/deep/two.ts', status: 'deleted' },
        { path: 'src/b/other.ts', status: 'modified' },
        { path: 'new/x/a.ts', status: 'untracked' },
        { path: 'new/x/sub/b.ts', status: 'untracked' },
      ],
      [
        { path: 'staged/dir/a.ts', status: 'modified' },
        { path: 'staged/dir/sub/b.ts', status: 'added' },
      ]
    );

  it('已暂存文件夹仅提供取消暂存，不提供丢弃修改，点击对目录下所有文件调用 unstage', async () => {
    harness.git.status.mockResolvedValue(nestedStatus());
    await render();
    await click(groupToggle('staged'));
    expect(dirAction('staged', 'staged/dir', 'discard')).toBeNull();
    expect(dirAction('staged', 'staged/dir', 'stage')).toBeNull();
    await click(dirAction('staged', 'staged/dir', 'unstage'));
    expect(harness.git.unstage).toHaveBeenCalledWith({
      conversationId: 'a',
      projectId: 'project',
      paths: ['staged/dir/a.ts', 'staged/dir/sub/b.ts'],
    });
  });

  it('未暂存文件夹点击暂存时对目录下全部已跟踪文件调用 stage', async () => {
    harness.git.status.mockResolvedValue(nestedStatus());
    await render();
    await click(dirAction('unstaged', 'src/a', 'stage'));
    expect(harness.git.stage).toHaveBeenCalledWith({
      conversationId: 'a',
      projectId: 'project',
      paths: ['src/a/one.ts', 'src/a/deep/two.ts'],
    });
  });

  it('未暂存文件夹确认后丢弃目录下全部已跟踪修改（confirmUntracked 为 false）', async () => {
    harness.git.status.mockResolvedValue(nestedStatus());
    await render();
    await click(dirAction('unstaged', 'src/a', 'discard'));
    expect(harness.git.discard).not.toHaveBeenCalled();
    expect(q('[data-confirm-title]')?.textContent).toBe('Discard changes');
    expect(q('[data-confirm-description]')?.textContent).toContain(
      'Unstaged changes in 2 tracked files in src/a will be lost'
    );
    expect(q('[data-confirm-ok]')?.textContent).toBe('Discard');
    await click(q('[data-confirm-ok]'));
    expect(harness.git.discard).toHaveBeenCalledWith({
      conversationId: 'a',
      projectId: 'project',
      paths: ['src/a/one.ts', 'src/a/deep/two.ts'],
      confirmUntracked: false,
    });
  });

  it('未跟踪文件夹确认后以 confirmUntracked: true 删除目录下全部未跟踪文件', async () => {
    harness.git.status.mockResolvedValue(nestedStatus());
    await render();
    await click(dirAction('untracked', 'new/x', 'discard'));
    expect(q('[data-confirm-title]')?.textContent).toBe('Delete untracked files');
    expect(q('[data-confirm-description]')?.textContent).toContain(
      '2 untracked files in new/x will be permanently deleted and cannot be recovered.'
    );
    expect(q('[data-confirm-ok]')?.textContent).toBe('Delete 2 untracked files');
    await click(q('[data-confirm-ok]'));
    expect(harness.git.discard).toHaveBeenCalledWith({
      conversationId: 'a',
      projectId: 'project',
      paths: ['new/x/a.ts', 'new/x/sub/b.ts'],
      confirmUntracked: true,
    });
  });

  it('存在冲突文件时，文件夹右键的丢弃修改与删除未跟踪文件禁用并提示先解决冲突', async () => {
    harness.git.status.mockResolvedValue(mixed());
    await render();
    const unstagedDiscard = dirAction('unstaged', 'src', 'discard');
    const untrackedDiscard = dirAction('untracked', 'new', 'discard');
    expect(unstagedDiscard?.disabled).toBe(true);
    expect(unstagedDiscard?.textContent).toContain('Resolve conflicts first.');
    expect(untrackedDiscard?.disabled).toBe(true);
    expect(untrackedDiscard?.textContent).toContain('Resolve conflicts first.');
  });

  it('同一目录混有多组文件时，每组文件夹只操作本组文件，且不混入同名前缀目录', async () => {
    harness.git.status.mockResolvedValue(
      statusWith(
        [
          { path: 'src/a/m.ts', status: 'modified' },
          { path: 'src/a/both.ts', status: 'modified' },
          { path: 'src/a/new.ts', status: 'untracked' },
          { path: 'src/ab/m.ts', status: 'modified' },
          { path: 'src/ab/new.ts', status: 'untracked' },
        ],
        [
          { path: 'src/a/s.ts', status: 'added' },
          { path: 'src/a/both.ts', status: 'modified' },
        ]
      )
    );
    await render();
    await click(dirAction('unstaged', 'src/a', 'discard'));
    expect(q('[data-confirm-description]')?.textContent).toContain(
      'Unstaged changes in 2 tracked files in src/a will be lost'
    );
    expect(q('[data-confirm-description]')?.textContent).not.toContain('untracked');
    await click(q('[data-confirm-ok]'));
    expect(harness.git.discard).toHaveBeenLastCalledWith({
      conversationId: 'a',
      projectId: 'project',
      paths: ['src/a/m.ts', 'src/a/both.ts'],
      confirmUntracked: false,
    });

    await click(dirAction('untracked', 'src/a', 'discard'));
    expect(q('[data-confirm-description]')?.textContent).toBe(
      '1 untracked files in src/a will be permanently deleted and cannot be recovered. Tracked files are not changed.'
    );
    await click(q('[data-confirm-ok]'));
    expect(harness.git.discard).toHaveBeenLastCalledWith({
      conversationId: 'a',
      projectId: 'project',
      paths: ['src/a/new.ts'],
      confirmUntracked: true,
    });
    expect(harness.git.discard).toHaveBeenCalledTimes(2);

    await click(groupToggle('staged'));
    await click(dirAction('staged', 'src/a', 'unstage'));
    expect(harness.git.unstage).toHaveBeenCalledWith({
      conversationId: 'a',
      projectId: 'project',
      paths: ['src/a/s.ts', 'src/a/both.ts'],
    });
  });

  it('搜索筛选激活时，文件夹右键仅作用于当前筛选命中的文件', async () => {
    harness.git.status.mockResolvedValue(nestedStatus());
    await render();
    await search('two.ts');
    await click(dirAction('unstaged', 'src/a', 'discard'));
    await click(q('[data-confirm-ok]'));
    expect(harness.git.discard).toHaveBeenCalledWith({
      conversationId: 'a',
      projectId: 'project',
      paths: ['src/a/deep/two.ts'],
      confirmUntracked: false,
    });
  });
});

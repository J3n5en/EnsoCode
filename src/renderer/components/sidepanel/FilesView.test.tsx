import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IS_MAC } from '@/lib/keybindings';
import { FilesView } from './FilesView';
import { type PanelActivitySource, PanelVisibilityProvider } from './panelVisibility';

const harness = vi.hoisted(() => ({
  openers: new Map<string, (rel: string) => void>(),
  files: {
    read: vi.fn(),
    write: vi.fn(),
    listDir: vi.fn(),
    createFile: vi.fn(),
    rename: vi.fn(),
  },
  toast: vi.fn(),
  sessions: {
    activeId: 'a' as string | null,
    workspaceRevisionByConversation: {},
    conversations: {
      a: { messages: [], status: 'idle' },
      b: { messages: [], status: 'idle' },
    },
  },
  sidePanel: { uiByConversation: {} as Record<string, { open: boolean; width: number }> },
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: Object.assign(
    (select: (state: unknown) => unknown) => select(harness.sessions),
    { getState: () => harness.sessions }
  ),
}));
vi.mock('@/stores/sidePanel', () => ({
  useSidePanelStore: (select: (state: unknown) => unknown) => select(harness.sidePanel),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ projects: [{ id: 'project', path: '/workspace' }] }),
}));
vi.mock('@/stores/sessions/timeline', () => ({
  buildTimeline: () => [],
  completedEditWriteFingerprint: () => '',
}));
vi.mock('@/stores/sessions/messageCache', () => ({ hasAuthoritativeMessages: () => false }));
vi.mock('@/lib/sidePanelDock', () => ({
  addSidePanelBrowser: vi.fn(),
  registerFilesTabCloser: () => vi.fn(),
  registerFilesOpener: (owner: string, opener: (rel: string) => void) => {
    harness.openers.set(owner, opener);
    return () => harness.openers.delete(owner);
  },
}));
vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ setNodeRef: vi.fn(), listeners: {}, isDragging: false }),
}));
vi.mock('@pierre/diffs/edit', () => ({ Editor: class {} }));
vi.mock('@pierre/diffs/react', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    EditProvider: Wrap,
    Virtualizer: Wrap,
    // 编辑器替身：点一下即模拟用户改了内容
    File: ({
      file,
      editorOptions,
    }: {
      file: { contents: string };
      editorOptions: { onChange: (next: { contents: string }) => void };
    }) => (
      <>
        <pre data-viewer="source">{file.contents}</pre>
        <button
          type="button"
          data-edit=""
          onClick={() => editorOptions.onChange({ contents: `${file.contents}\nedited` })}
        />
      </>
    ),
  };
});
vi.mock('@/components/chat/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/chat/codeHighlighter', () => ({
  CODE_THEME: '',
  ensureHighlighter: () => Promise.resolve(),
}));
vi.mock('@/components/chat/composerMentionBridge', () => ({
  insertComposerMention: vi.fn(),
  requestFocusComposer: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.toast }));
vi.mock('@/hooks/useColorScheme', () => ({
  useCodeHighlightOptions: (options: unknown) => options,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<'button'> & { variant?: string; size?: string }) => <button {...props} />,
}));
vi.mock('@/components/ui/context-menu', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ContextMenu: Wrap,
    ContextMenuPopup: () => null,
    ContextMenuSeparator: () => null,
    ContextMenuTrigger: Wrap,
    ContextMenuItem: Wrap,
  };
});
vi.mock('./FilesSearchPane', () => ({ FilesSearchPane: () => null }));
vi.mock('./fileTreeMenu', () => ({
  isMarkdownRel: () => false,
  revealLabel: () => 'Reveal in Finder',
  // 右键菜单替身：只露出用例要点的「新建文件」「重命名」入口
  FileTreeMenu: ({
    children,
    target,
    onNewFile,
    onRename,
  }: {
    children?: ReactNode;
    target: { kind: 'blank' } | { kind: 'file' | 'dir'; rel: string; name: string };
    onNewFile: (parent: string) => void;
    onRename?: (rel: string, name: string) => void;
  }) => (
    <>
      {children}
      {target.kind === 'blank' && (
        <button type="button" data-menu="new-file" onClick={() => onNewFile('')} />
      )}
      {target.kind === 'file' && onRename && (
        <button
          type="button"
          data-menu="rename"
          data-rel={target.rel}
          onClick={() => onRename(target.rel, target.name)}
        />
      )}
    </>
  ),
}));
vi.mock('./filePreviewMarkdown', () => ({ FileMarkdownPreview: () => null }));

/** 所在分组激活、tab 被选中的 dockview 面板 */
function panelSource(isActive: boolean, isVisible = true): PanelActivitySource {
  return {
    isActive,
    isVisible,
    onDidActiveChange: () => ({ dispose() {} }),
    onDidVisibilityChange: () => ({ dispose() {} }),
  };
}

let root: Root;
let container: HTMLElement;

/** 每个会话一个常驻 dock，与 SidePanel 的挂法一致 */
async function mountDocks(
  ids: string[],
  activity: Record<string, { isActive: boolean; isVisible?: boolean }> = {}
) {
  await act(async () =>
    root.render(
      ids.map((id) => (
        <section key={id} data-dock={id}>
          <PanelVisibilityProvider
            dockConversationId={id}
            api={panelSource(activity[id]?.isActive ?? true, activity[id]?.isVisible ?? true)}
          >
            <FilesView conversationId={id} projectId="project" />
          </PanelVisibilityProvider>
        </section>
      ))
    )
  );
}
async function openReadme(id: string) {
  await act(async () => harness.openers.get(id)?.('README.md'));
}
async function click(selector: string) {
  const el = container.querySelector(selector);
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLButtonElement).click());
}
const nameInput = () => container.querySelector('input[aria-label="New File"]');
async function press(target: Element | null, key: string) {
  expect(target).not.toBeNull();
  await act(async () => {
    target?.dispatchEvent(
      Object.assign(new window.Event('keydown', { bubbles: true, cancelable: true }), { key })
    );
  });
}
/**
 * 在名称输入框里填名字并回车。react-dom 加载时还没有 window，onChange 只能走它的 IE 兜底：
 * focusin 后开始盯值，keyup 时发现 value 变了才派发；改值要绕过 React 自己的 value 追踪。
 */
async function commitName(name: string) {
  const input = nameInput();
  expect(input).not.toBeNull();
  await act(async () => {
    input?.dispatchEvent(new window.Event('focusin', { bubbles: true }));
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, name);
    input?.dispatchEvent(Object.assign(new window.Event('keyup', { bubbles: true }), { key: 'a' }));
  });
  await press(input, 'Enter');
}
/** platform = 本平台的保存修饰键（mac ⌘ / 其它 Ctrl），other = 另一个 */
async function pressSave(modifier: 'platform' | 'other' = 'platform') {
  const meta = modifier === 'platform' ? IS_MAC : !IS_MAC;
  await act(async () => {
    window.dispatchEvent(
      Object.assign(new window.Event('keydown', { bubbles: true, cancelable: true }), {
        key: 's',
        metaKey: meta,
        ctrlKey: !meta,
        shiftKey: false,
        altKey: false,
      })
    );
  });
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
  // 补上 linkedom 缺的浏览器行为：input.type 缺省为 'text'（React 据此认定文本框）、select()，
  // 以及 react-dom 兜底派发 onChange 时调用的 attachEvent / detachEvent
  Object.defineProperty(dom.window.HTMLInputElement.prototype, 'type', {
    configurable: true,
    get(this: HTMLInputElement) {
      return this.getAttribute('type') ?? 'text';
    },
    set(this: HTMLInputElement, value: string) {
      this.setAttribute('type', value);
    },
  });
  Object.assign(dom.window.HTMLInputElement.prototype, { select: vi.fn() });
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent: vi.fn(), detachEvent: vi.fn() });
  Object.assign(dom.window, {
    electronAPI: {
      workspaceFiles: {
        ...harness.files,
        watchStart: vi.fn(async () => ({ ok: true })),
        watchStop: vi.fn(async () => ({ ok: true })),
        onChange: () => vi.fn(),
      },
    },
  });
  harness.openers.clear();
  harness.toast.mockReset();
  harness.files.read.mockReset().mockResolvedValue({ ok: true, content: '# README' });
  harness.files.write.mockReset().mockResolvedValue({ ok: true });
  harness.files.listDir
    .mockReset()
    .mockResolvedValue({ ok: true, entries: [{ name: 'README.md', kind: 'file' }] });
  harness.files.createFile.mockReset();
  harness.files.rename.mockReset();
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
});

describe('FilesView 保存快捷键', () => {
  // 真实场景：dock 按会话常驻，在会话 B 里按 ⌘S，会话 A 的 Files 也会把草稿静默写盘
  it('只有当前会话可见的 Files 面板响应保存键，隐藏会话的草稿不写盘', async () => {
    harness.sessions.activeId = 'b';
    await mountDocks(['a', 'b']);
    await openReadme('a');
    await openReadme('b');
    await click('[data-dock="a"] [data-edit]');
    await click('[data-dock="b"] [data-edit]');
    await pressSave();
    expect(harness.files.write).toHaveBeenCalledTimes(1);
    expect(harness.files.write).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'b', rel: 'README.md' })
    );
  });

  // 真实场景：agent 删掉了已打开的文件，回读失败被忽略，tab 里仍是旧内容
  it('没有未保存改动时按保存键不写盘，不会用旧内容复活被删的文件', async () => {
    await mountDocks(['a']);
    await openReadme('a');
    await pressSave();
    expect(harness.files.write).not.toHaveBeenCalled();
    await click('[data-dock="a"] [data-edit]');
    await pressSave();
    expect(harness.files.write).toHaveBeenCalledTimes(1);
  });

  // 真实场景：mac 终端里的 ⌃S、emacs 的 C-x C-s 也会冒泡到 window
  it('只认本平台的保存修饰键：mac 只认 ⌘S，其它平台只认 Ctrl+S', async () => {
    await mountDocks(['a']);
    await openReadme('a');
    await click('[data-dock="a"] [data-edit]');
    await pressSave('other');
    expect(harness.files.write).not.toHaveBeenCalled();
    await pressSave();
    expect(harness.files.write).toHaveBeenCalledTimes(1);
  });

  // 真实场景：分屏后焦点在终端/浏览器，或点了原生视图这类不会把分组标成激活的区域
  it('分组未激活但 Files 仍是唯一可见面板时，⌘S 照样保存', async () => {
    await mountDocks(['a'], { a: { isActive: false } });
    await openReadme('a');
    await click('[data-dock="a"] [data-edit]');
    await pressSave();
    expect(harness.files.write).toHaveBeenCalledTimes(1);
    expect(harness.files.write).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'a', rel: 'README.md' })
    );
  });
});

describe('FilesView 名称输入框', () => {
  // 真实场景：新建文件填了已存在的 README.md，回车提示已存在；改名后再回车没反应
  it('新建文件名已存在被拒后，改个名字再回车会重新提交', async () => {
    harness.files.createFile
      .mockResolvedValueOnce({ ok: false, error: 'exists' })
      .mockResolvedValueOnce({ ok: true, rel: 'notes.md' });
    await mountDocks(['a']);
    await click('[data-menu="new-file"]');
    await commitName('README.md');
    expect(harness.toast).toHaveBeenCalledTimes(1);
    await commitName('notes.md');
    expect(harness.files.createFile).toHaveBeenCalledTimes(2);
    expect(harness.files.createFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'notes.md' })
    );
    expect(nameInput()).toBeNull();
  });

  // 真实场景：重命名撞名失败后输入框留在原地，Esc 取消不了
  it('重命名失败后，Esc 仍能取消改名输入框', async () => {
    harness.files.rename.mockResolvedValueOnce({ ok: false, error: 'exists' });
    await mountDocks(['a']);
    await click('[data-menu="rename"][data-rel="README.md"]');
    await commitName('CHANGELOG.md');
    expect(harness.toast).toHaveBeenCalledTimes(1);
    expect(nameInput()).not.toBeNull();
    await press(nameInput(), 'Escape');
    expect(nameInput()).toBeNull();
  });
});

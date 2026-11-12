import type { GitFile } from '@shared/types/git';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitChangesView } from './GitChangesView';
import { type PanelActivitySource, PanelVisibilityProvider } from './panelVisibility';

const harness = vi.hoisted(() => ({
  git: { status: vi.fn(), fileDiff: vi.fn() },
  sessions: {
    activeId: 'a' as string | null,
    refreshWorktreeStatuses: () => Promise.resolve(),
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
vi.mock('@/components/chat/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
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
  InputGroupInput: () => <input />,
}));
vi.mock('@/components/ui/textarea', () => ({ Textarea: () => <textarea /> }));
vi.mock('./GitDiffPreview', () => ({ GitDiffPreview: () => null }));
vi.mock('./GitHistoryView', () => ({ GitHistoryView: () => null }));
vi.mock('./GitPanelLayout', () => ({
  GitPanelLayout: ({ navigation, children }: { navigation: ReactNode; children?: ReactNode }) => (
    <div>
      {navigation}
      {children}
    </div>
  ),
}));
vi.mock('./GitFileList', () => ({
  GitFileList: ({
    files,
    children,
  }: {
    files: GitFile[];
    children: (file: GitFile) => ReactNode;
  }) => (
    <>
      {files.map((file) => (
        <div key={file.path}>{children(file)}</div>
      ))}
    </>
  ),
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
const statusWith = (unstaged: GitFile[] = []) => ({
  ok: true,
  branch: 'main',
  head: 'abc',
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
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
  harness.git.status.mockReset().mockResolvedValue(statusWith());
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

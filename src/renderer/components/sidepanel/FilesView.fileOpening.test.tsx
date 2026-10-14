import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode, useEffect, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesView } from './FilesView';

const harness = vi.hoisted(() => ({
  opener: null as ((rel: string, line?: number, viewer?: 'text' | 'markdown') => void) | null,
  pending: null as [string, undefined, 'markdown'] | null,
  editors: [] as { focus: ReturnType<typeof vi.fn> }[],
  read: vi.fn(),
  t: (key: string) => key,
  state: {
    workspaceRevisionByConversation: {},
    conversations: { owner: { messages: [], status: 'idle' } },
  },
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: harness.t }) }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: Object.assign((select: (state: unknown) => unknown) => select(harness.state), {
    getState: () => harness.state,
  }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ projects: [{ id: 'project', path: 'C:/workspace' }] }),
}));
vi.mock('@/stores/sessions/timeline', () => ({
  buildTimeline: () => [],
  completedEditWriteFingerprint: () => '',
}));
vi.mock('@/stores/sessions/messageCache', () => ({ hasAuthoritativeMessages: () => false }));
vi.mock('@/lib/sidePanelDock', () => ({
  addSidePanelBrowser: vi.fn(),
  registerFilesTabCloser: () => vi.fn(),
  registerFilesOpener: (_owner: string, opener: NonNullable<typeof harness.opener>) => {
    harness.opener = opener;
    if (harness.pending) {
      opener(...harness.pending);
      harness.pending = null;
    }
    return () => {
      harness.opener = null;
    };
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
    File: ({
      file,
      editorOptions,
    }: {
      file: { contents: string };
      editorOptions: { onAttach: (editor: unknown) => void };
    }) => {
      const editor = useMemo(() => ({ focus: vi.fn() }), []);
      useEffect(() => {
        harness.editors.push(editor);
        editorOptions.onAttach(editor);
      }, [editor, editorOptions]);
      return <pre data-viewer="source">{file.contents}</pre>;
    },
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
vi.mock('@/components/ui/toast', () => ({ addToast: vi.fn() }));
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
    ContextMenuTrigger: Wrap,
    ContextMenuItem: Wrap,
  };
});
vi.mock('./FilesSearchPane', () => ({ FilesSearchPane: () => null }));
vi.mock('./fileTreeMenu', () => ({
  isMarkdownRel: (rel: string) => /\.(md|markdown|mdx)$/i.test(rel),
  FileTreeMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('./filePreviewMarkdown', () => ({
  FileMarkdownPreview: ({ text }: { text: string }) => (
    <article data-viewer="markdown">{text}</article>
  ),
}));

let root: Root;
let container: HTMLElement;
async function mount() {
  await act(async () => root.render(<FilesView conversationId="owner" projectId="project" />));
}
async function open(line?: number, viewer?: 'text' | 'markdown') {
  await act(async () => harness.opener?.('README.md', line, viewer));
}
async function toggle(label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => (button as HTMLButtonElement)?.click());
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.assign(dom.window, {
    electronAPI: {
      workspaceFiles: {
        read: harness.read,
        listDir: vi.fn(async () => ({ ok: true, entries: [] })),
        watchStart: vi.fn(async () => ({ ok: true })),
        watchStop: vi.fn(async () => ({ ok: true })),
        onChange: () => vi.fn(),
      },
    },
  });
  harness.opener = null;
  harness.pending = null;
  harness.editors = [];
  harness.read.mockReset().mockResolvedValue({ ok: true, content: '# README\ncontent' });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('FilesView 文件链接预览', () => {
  it('冷挂载 pending Markdown 默认预览并保留 View Source 切换', async () => {
    harness.pending = ['README.md', undefined, 'markdown'];
    await mount();
    expect(container.querySelector('[data-viewer="markdown"]')?.textContent).toContain('# README');
    expect(container.querySelector('[data-viewer="source"]')).toBeNull();
    await toggle('View Source');
    expect(container.querySelector('[data-viewer="source"]')?.textContent).toContain('# README');
  });

  it('source → preview → 行号回到源码并聚焦新 editor，不消费已卸载 editor', async () => {
    await mount();
    await open();
    const previous = harness.editors.at(-1);
    expect(previous).toBeDefined();
    await toggle('Preview');
    expect(container.querySelector('[data-viewer="markdown"]')).not.toBeNull();
    await open(12);
    expect(container.querySelector('[data-viewer="source"]')).not.toBeNull();
    expect(previous?.focus).not.toHaveBeenCalled();
    expect(harness.editors.at(-1)?.focus).toHaveBeenCalledWith({ lineNumber: 12 });
  });
});

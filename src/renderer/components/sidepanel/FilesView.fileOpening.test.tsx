import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode, useEffect, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPluginFileViewers } from '../../plugins/fileViewers';
import { IMAGE_INLINE_MAX_CHARS } from './FileImageViewer';
import { FilesView } from './FilesView';

const harness = vi.hoisted(() => ({
  opener: null as ((rel: string, line?: number, viewer?: 'text' | 'markdown') => void) | null,
  pending: null as [string, undefined, 'markdown'] | null,
  editors: [] as { focus: ReturnType<typeof vi.fn> }[],
  read: vi.fn(),
  readImage: vi.fn(),
  onChange: null as ((event: { conversationId: string; rel: string }) => void) | null,
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
    ContextMenuPopup: Wrap,
    ContextMenuSeparator: () => null,
    ContextMenuTrigger: Wrap,
    ContextMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock('../../plugins/PluginView', () => ({
  PluginFrame: ({ title }: { title: string }) => <div data-viewer="plugin">{title}</div>,
}));
vi.mock('./FilesSearchPane', () => ({ FilesSearchPane: () => null }));
vi.mock('./fileTreeMenu', () => ({
  isMarkdownRel: (rel: string) => /\.(md|markdown|mdx)$/i.test(rel),
  revealLabel: () => 'Reveal in Finder',
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
        readImage: harness.readImage,
        listDir: vi.fn(async () => ({ ok: true, entries: [] })),
        watchStart: vi.fn(async () => ({ ok: true })),
        watchStop: vi.fn(async () => ({ ok: true })),
        onChange: (listener: NonNullable<typeof harness.onChange>) => {
          harness.onChange = listener;
          return vi.fn();
        },
      },
    },
  });
  harness.opener = null;
  harness.pending = null;
  harness.editors = [];
  harness.read.mockReset().mockResolvedValue({ ok: true, content: '# README\ncontent' });
  harness.readImage.mockReset().mockResolvedValue({ ok: true, dataUrl: PNG_DATA_URL });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  setPluginFileViewers([]);
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

  it('文件标签右键复制路径并在访达中显示，只传工作区相对路径', async () => {
    const copyPath = vi.fn(async () => ({ ok: true }));
    const reveal = vi.fn(async () => ({ ok: true }));
    Object.assign(window.electronAPI.workspaceFiles, { copyPath, reveal });
    await mount();
    await open();
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((node) => node.textContent === label);
    await act(async () => (button('Copy Path') as HTMLButtonElement).click());
    await act(async () => (button('Reveal in Finder') as HTMLButtonElement).click());
    expect(copyPath).toHaveBeenCalledWith({
      conversationId: 'owner',
      projectId: 'project',
      rel: 'README.md',
      mode: 'absolute',
    });
    expect(reveal).toHaveBeenCalledWith({
      conversationId: 'owner',
      projectId: 'project',
      rel: 'README.md',
    });
  });
});

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

async function openRel(rel: string) {
  await act(async () => harness.opener?.(rel));
}
function buttonByText(text: string) {
  return [...container.querySelectorAll('button')].find((node) => node.textContent === text);
}

describe('FilesView 图片预览', () => {
  it('图片扩展名（含大写）走图片查看器，不按文本读入编辑器', async () => {
    await mount();
    await openRel('assets/logo.PNG');
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(PNG_DATA_URL);
    expect(container.querySelector('[data-viewer="source"]')).toBeNull();
    expect(harness.read).not.toHaveBeenCalled();
    expect(harness.readImage).toHaveBeenCalledWith({
      conversationId: 'owner',
      projectId: 'project',
      rel: 'assets/logo.PNG',
    });
  });

  it('非图片扩展名仍走代码编辑器', async () => {
    harness.read.mockResolvedValue({ ok: true, content: 'export const a = 1;' });
    await mount();
    await openRel('src/main.ts');
    expect(container.querySelector('[data-viewer="source"]')?.textContent).toBe(
      'export const a = 1;'
    );
    expect(container.querySelector('img')).toBeNull();
    expect(harness.readImage).not.toHaveBeenCalled();
  });

  it('适应窗口与原始尺寸可切换', async () => {
    await mount();
    await openRel('a.webp');
    expect(container.querySelector('img')?.getAttribute('data-fit')).toBe('contain');
    await toggle('Actual size');
    expect(container.querySelector('img')?.getAttribute('data-fit')).toBe('actual');
    await toggle('Fit to window');
    expect(container.querySelector('img')?.getAttribute('data-fit')).toBe('contain');
  });

  it.each([
    [
      '读图返回失败',
      () => harness.readImage.mockResolvedValue({ ok: false, error: 'unsupported' }),
    ],
    ['读图抛错', () => harness.readImage.mockRejectedValue(new Error('boom'))],
  ])('%s 时显示兜底文案，可改用代码编辑器打开', async (_name, arrange) => {
    arrange();
    harness.read.mockResolvedValue({
      ok: true,
      content: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    await mount();
    await openRel('icons/broken.svg');
    expect(container.textContent).toContain('Unable to preview this image.');
    expect(container.querySelector('img')).toBeNull();
    await act(async () => (buttonByText('Open in code editor') as HTMLButtonElement).click());
    expect(container.querySelector('[data-viewer="source"]')?.textContent).toContain('<svg');
    expect(container.textContent).not.toContain('Unable to preview this image.');
  });

  it('超过读图上限时明确提示图片过大，而不是笼统的无法预览', async () => {
    harness.readImage.mockResolvedValue({ ok: false, error: 'too-large' });
    await mount();
    await openRel('huge.png');
    expect(container.textContent).toContain('The image is too large to preview.');
    expect(container.textContent).not.toContain('Unable to preview this image.');
    expect(container.querySelector('img')).toBeNull();
  });

  it('超大图不直接渲染，点击后才加载', async () => {
    const huge = `data:image/png;base64,${'A'.repeat(IMAGE_INLINE_MAX_CHARS)}`;
    harness.readImage.mockResolvedValue({ ok: true, dataUrl: huge });
    await mount();
    await openRel('big.jpg');
    expect(container.querySelector('img')).toBeNull();
    const load = buttonByText('Image is too large. Click to load.');
    expect(load).toBeDefined();
    await act(async () => (load as HTMLButtonElement).click());
    expect(container.querySelector('img')?.getAttribute('src')).toBe(huge);
  });

  it('文件变更重新取图时不闪回加载态，已点开的大图保持显示', async () => {
    const huge = `data:image/png;base64,${'A'.repeat(IMAGE_INLINE_MAX_CHARS)}`;
    harness.readImage.mockResolvedValue({ ok: true, dataUrl: huge });
    await mount();
    await openRel('big.jpg');
    await act(async () =>
      (buttonByText('Image is too large. Click to load.') as HTMLButtonElement).click()
    );
    let resolve: (value: unknown) => void = () => {};
    harness.readImage.mockReturnValue(new Promise((done) => (resolve = done)));
    await act(async () => harness.onChange?.({ conversationId: 'owner', rel: 'big.jpg' }));
    expect(harness.readImage).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Loading...');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(huge);
    const next = `data:image/png;base64,${'B'.repeat(IMAGE_INLINE_MAX_CHARS)}`;
    await act(async () => resolve({ ok: true, dataUrl: next }));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(next);
    // 写入途中读到半截文件短暂失败，写完再取到图时仍直接显示
    harness.readImage.mockResolvedValueOnce({ ok: false, error: 'unsupported' });
    await act(async () => harness.onChange?.({ conversationId: 'owner', rel: 'big.jpg' }));
    expect(container.textContent).toContain('Unable to preview this image.');
    harness.readImage.mockResolvedValueOnce({ ok: true, dataUrl: huge });
    await act(async () => harness.onChange?.({ conversationId: 'owner', rel: 'big.jpg' }));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(huge);
  });

  it('插件为该图片后缀声明了默认查看器时仍按插件查看器打开', async () => {
    setPluginFileViewers([
      {
        pluginId: 'drawio',
        pluginName: 'Draw.io',
        id: 'editor',
        title: 'Draw.io',
        entry: 'index.html',
        extensions: ['.drawio.svg'],
        default: true,
      },
    ]);
    harness.read.mockResolvedValue({ ok: true, content: '<svg/>' });
    await mount();
    await openRel('docs/flow.drawio.svg');
    expect(container.querySelector('[data-viewer="plugin"]')?.textContent).toBe('Draw.io');
    expect(harness.readImage).not.toHaveBeenCalled();
    await openRel('docs/plain.svg');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(PNG_DATA_URL);
  });
});

import type { ContextMenuOpen } from '@shared/fileOpening';
import { parseHTML } from 'linkedom';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { resetFileLinkCache } from './fileLinkResolver';
import { LocalFileTrigger, Markdown, MarkdownLinkContext } from './Markdown';

const harness = vi.hoisted(() => ({
  open: vi.fn(),
  openContext: vi.fn(),
  reveal: vi.fn(),
  revealExternal: vi.fn(),
  readImage: vi.fn(),
  resolveLinks: vi.fn(),
  missing: new Set<string>(),
  openSidePanelFile: vi.fn(),
  openSidePanelBrowserUrl: vi.fn(),
  toast: vi.fn(),
  contextMenuOpen: [] as ContextMenuOpen,
  projects: [] as { id: string; kind: string; disabledBuiltinTools?: string[] }[],
  disabledBuiltinTools: [] as string[],
  openLinksInBuiltinBrowser: true,
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/sidePanelDock', () => ({
  openSidePanelFile: harness.openSidePanelFile,
  openSidePanelBrowserUrl: harness.openSidePanelBrowserUrl,
}));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.toast }));
vi.mock('./CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('./MermaidRenderer', () => ({ MermaidRenderer: () => null }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (
    selector: (state: {
      contextMenuOpen: ContextMenuOpen;
      projects: { id: string; kind: string; disabledBuiltinTools?: string[] }[];
      disabledBuiltinTools: string[];
      openLinksInBuiltinBrowser: boolean;
    }) => unknown
  ) =>
    selector({
      contextMenuOpen: harness.contextMenuOpen,
      projects: harness.projects,
      disabledBuiltinTools: harness.disabledBuiltinTools,
      openLinksInBuiltinBrowser: harness.openLinksInBuiltinBrowser,
    }),
}));
vi.mock('@/components/ui/context-menu', async () => {
  const { cloneElement, createContext, useContext, useState } = await import('react');
  const State = createContext({ open: false, show: () => {} });
  return {
    ContextMenu: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = useState(false);
      return (
        <State.Provider value={{ open, show: () => setOpen(true) }}>{children}</State.Provider>
      );
    },
    ContextMenuTrigger: ({ render }: { render: ReactElement }) => {
      const { show } = useContext(State);
      return cloneElement(render as ReactElement<{ onContextMenu: (event: Event) => void }>, {
        onContextMenu: (event: Event) => {
          event.preventDefault();
          show();
        },
      });
    },
    ContextMenuPopup: ({ children }: { children: ReactNode }) =>
      useContext(State).open ? <span role="menu">{children}</span> : null,
    ContextMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
      <button type="button" role="menuitem" onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <span>{children}</span>;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <span role="dialog">{children}</span> : null,
    DialogContent: Wrap,
    DialogHeader: Wrap,
    DialogTitle: Wrap,
    DialogDescription: Wrap,
    DialogPanel: Wrap,
    DialogFooter: Wrap,
  };
});

let root: Root;
let container: HTMLElement;
const context = { conversationId: 'child', projectId: 'project', cwd: 'C:/workspace' };

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 70)));

async function render(text: string, authorized = true, streaming = false) {
  await act(async () =>
    root.render(
      <MarkdownLinkContext.Provider value={authorized ? context : null}>
        <Markdown text={text} streaming={streaming} />
      </MarkdownLinkContext.Provider>
    )
  );
  await settle();
}

async function click(selector: string, type = 'click', init: Record<string, boolean> = {}) {
  const element = container.querySelector(selector);
  expect(element).not.toBeNull();
  let prevented = false;
  await act(async () => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, init);
    element?.dispatchEvent(event);
    prevented = event.defaultPrevented;
  });
  return prevented;
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('navigator', { userAgent: 'Windows', clipboard: { writeText: vi.fn() } });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, {
    electronAPI: {
      workspaceFiles: {
        open: harness.open,
        openContext: harness.openContext,
        reveal: harness.reveal,
        revealExternal: harness.revealExternal,
        readImage: harness.readImage,
        resolveLinks: harness.resolveLinks,
      },
    },
  });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  vi.clearAllMocks();
  resetFileLinkCache();
  harness.missing = new Set();
  harness.resolveLinks.mockImplementation(async ({ rels }: { rels: string[] }) => ({
    ok: true,
    items: rels.map((rel) =>
      harness.missing.has(rel) ? null : { rel, kind: /\.\w+$/.test(rel) ? 'file' : 'dir' }
    ),
  }));
  harness.open.mockResolvedValue({ ok: true, target: 'internal', viewer: 'text', rel: 'src/a.ts' });
  harness.reveal.mockResolvedValue({ ok: true });
  harness.revealExternal.mockResolvedValue({ ok: true });
  harness.openContext.mockResolvedValue({ ok: true });
  harness.contextMenuOpen = [
    { id: 'reveal', target: 'reveal', enabled: true },
    { id: 'vscode', target: 'vscode', enabled: true },
  ];
  harness.projects = [];
  harness.disabledBuiltinTools = [];
  harness.openLinksInBuiltinBrowser = true;
  harness.openSidePanelBrowserUrl.mockResolvedValue({ ok: true });
  harness.readImage.mockResolvedValue({ ok: true, dataUrl: 'data:image/png;base64,AAAA' });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('聊天文件链接的打开方式', () => {
  it.each([
    ['[source](src/a.ts:12)', 'a'],
    ['`src/a.ts:12`', 'button'],
  ])('右键文件链接先展示列表，点击后只发送条目标识：%s', async (text, selector) => {
    await render(text);
    expect(await click(selector, 'contextmenu')).toBe(true);
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    expect(harness.openContext).not.toHaveBeenCalled();
    await click('[role="menuitem"]:last-child');
    expect(harness.openContext).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'src/a.ts',
      itemId: 'vscode',
    });
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.reveal).not.toHaveBeenCalled();
    expect(harness.openSidePanelFile).not.toHaveBeenCalled();
  });

  it('菜单只显示启用项，允许多应用并仅传所选应用的标识', async () => {
    harness.contextMenuOpen = [
      { id: 'reveal', target: 'reveal', enabled: false },
      { id: 'vscode', target: 'vscode', enabled: true },
      { id: 'custom', target: 'application', enabled: true, applicationPath: 'C:/Apps/Editor.exe' },
      { id: 'off', target: 'application', enabled: false, applicationPath: 'C:/Apps/Other.exe' },
    ];
    await render('[source](src/a.ts)');
    await click('a', 'contextmenu');
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    await click('[role="menuitem"]:last-child');
    expect(harness.openContext).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'src/a.ts',
      itemId: 'custom',
    });
  });

  it('右键不接管外链或无权限链接，越界链接不渲染成链接也不调 IPC', async () => {
    await render('[web](https://example.com)');
    expect(await click('a', 'contextmenu')).toBe(false);
    await render('[local](src/a.ts)', false);
    expect(await click('a', 'contextmenu')).toBe(false);
    await render('[escape](../secret.txt)');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('escape');
    expect(harness.openContext).not.toHaveBeenCalled();
    expect(harness.resolveLinks).not.toHaveBeenCalled();
  });

  it('正文文本调用 open，以原会话 owner 打开内部 Files 而不是 reveal', async () => {
    await render('[source](src/a.ts)');
    expect(await click('a')).toBe(true);
    expect(harness.open).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'src/a.ts',
    });
    expect(harness.openSidePanelFile).toHaveBeenCalledWith('child', 'src/a.ts');
    expect(harness.reveal).not.toHaveBeenCalled();
  });

  it('Markdown 正文指定预览，handled 可执行文件不再打开内部面板', async () => {
    harness.open.mockResolvedValueOnce({
      ok: true,
      target: 'internal',
      viewer: 'markdown',
      rel: 'README.md',
    });
    await render('[doc](README.md)');
    await click('a');
    expect(harness.openSidePanelFile).toHaveBeenCalledWith(
      'child',
      'README.md',
      undefined,
      'markdown'
    );
    harness.openSidePanelFile.mockClear();
    harness.open.mockResolvedValueOnce({ ok: true, target: 'handled' });
    await render('[exe](app.exe)');
    await click('a');
    expect(harness.openSidePanelFile).not.toHaveBeenCalled();
  });

  it('文件管理器图标是链接的独立兄弟按钮，始终只 reveal', async () => {
    await render('[doc](README.md)');
    const button = container.querySelector('button[aria-label="Reveal in File Explorer"]');
    expect(button).not.toBeNull();
    expect(button?.closest('a')).toBeNull();
    expect(button?.getAttribute('title')).toBe('Reveal in File Explorer');
    await click('button[aria-label="Reveal in File Explorer"]');
    expect(harness.reveal).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'README.md',
    });
    expect(harness.open).not.toHaveBeenCalled();
  });

  it('AI 生成的 Windows 安装包表格链接与定位按钮使用相同的工作区相对路径', async () => {
    harness.open.mockResolvedValueOnce({ ok: true, target: 'handled' });
    await render(
      '| 安装包 | 大小 |\n| --- | --- |\n| [国内版：馆长](/C:/workspace/dist/%E9%A6%86%E9%95%BF-1.0.11.exe) | 273.35 MiB |'
    );
    await click('td a');
    expect(harness.open).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'dist/馆长-1.0.11.exe',
    });
    await click('button[aria-label="Reveal in File Explorer"]');
    expect(harness.reveal).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'dist/馆长-1.0.11.exe',
    });
    expect(harness.openSidePanelFile).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it('带前导斜杠的 Windows 文档链接保留源码跳行', async () => {
    await render('[source](/C:/workspace/src/a.ts:12)');
    await click('a');
    expect(harness.openSidePanelFile).toHaveBeenCalledWith('child', 'src/a.ts', 12);
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it('图片通过有权限的 readImage 显示 dataUrl，不导航到磁盘 URL', async () => {
    harness.open.mockResolvedValueOnce({
      ok: true,
      target: 'internal',
      viewer: 'image',
      rel: 'image.png',
    });
    await render('[image](image.png)');
    await click('a');
    expect(harness.readImage).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'image.png',
    });
    expect(container.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(
      'data:image/png;base64,AAAA'
    );
    expect(harness.openSidePanelFile).not.toHaveBeenCalled();
  });

  it('Markdown 行号与行内路径保留源码跳行，绕过用户打开规则', async () => {
    await render('[line](src/README.md:12) and `src/a.ts:7`');
    await click('a');
    expect(harness.openSidePanelFile).toHaveBeenCalledWith('child', 'src/README.md', 12);
    await click('button:not([aria-label])');
    expect(harness.openSidePanelFile).toHaveBeenCalledWith('child', 'src/a.ts', 7);
    expect(harness.open).not.toHaveBeenCalled();
  });

  it('关闭内置浏览器打开链接时 http 链接维持外链，无上下文本地链接不导航且不展示 reveal 按钮', async () => {
    harness.openLinksInBuiltinBrowser = false;
    await render('[web](https://example.com)');
    expect(container.querySelector('a')?.getAttribute('target')).toBe('_blank');
    expect(await click('a')).toBe(false);
    expect(harness.openSidePanelBrowserUrl).not.toHaveBeenCalled();
    expect(container.querySelector('button')).toBeNull();
    await render('[local](src/a.ts)', false);
    expect(await click('a')).toBe(true);
    expect(container.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(harness.open).not.toHaveBeenCalled();
  });

  it('启用内置浏览器时网页链接默认在会话侧栏浏览器打开，并提示修饰键点击走外部浏览器', async () => {
    await render('[web](https://example.com/a)');
    expect(container.querySelector('a')?.getAttribute('title')).toBe(
      '{{key}}+Click to open in external browser'
    );
    expect(await click('a')).toBe(true);
    expect(harness.openSidePanelBrowserUrl).toHaveBeenCalledWith('child', 'https://example.com/a');
  });

  it('Cmd/Ctrl+点击网页链接交给外部浏览器', async () => {
    await render('[web](https://example.com)');
    expect(await click('a', 'click', { metaKey: true, ctrlKey: true })).toBe(false);
    expect(harness.openSidePanelBrowserUrl).not.toHaveBeenCalled();
  });

  it('项目禁用 browser 工具、无会话上下文或非 http 链接时维持外部浏览器', async () => {
    harness.projects = [{ id: 'project', kind: 'local', disabledBuiltinTools: ['browser'] }];
    await render('[web](https://example.com)');
    expect(container.querySelector('a')?.getAttribute('title')).toBeNull();
    expect(await click('a')).toBe(false);
    harness.projects = [];
    await render('[web](https://example.com)', false);
    expect(await click('a')).toBe(false);
    await render('[mail](mailto:a@example.com)');
    expect(await click('a')).toBe(false);
    expect(harness.openSidePanelBrowserUrl).not.toHaveBeenCalled();
  });

  it('越界不可点、危险协议被拒绝，后端不可预览错误仍 toast', async () => {
    await render('[escape](../secret.txt)');
    expect(container.querySelector('a')).toBeNull();
    expect(harness.open).not.toHaveBeenCalled();
    await render('[danger](javascript:alert(1))');
    await click('a');
    expect(harness.open).not.toHaveBeenCalled();
    harness.open.mockResolvedValueOnce({ ok: false, error: 'unsupported-viewer' });
    await render('[binary](data.xyz)');
    await click('a');
    expect(harness.toast).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('有上下文本地链接可聚焦并用 Enter 打开，无上下文链接不可操作', async () => {
    await render('[source](src/a.ts)');
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('role')).toBe('link');
    expect(anchor?.getAttribute('tabindex')).toBe('0');
    await act(async () => {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(event, { key: 'Enter' });
      anchor?.dispatchEvent(event);
    });
    expect(harness.openSidePanelFile).toHaveBeenCalledWith('child', 'src/a.ts');
    await render('[source](src/a.ts)', false);
    expect(container.querySelector('a')?.getAttribute('tabindex')).toBeNull();
  });

  it('ICO 和 SVG 遵循真实 readImage MIME，SVG 只作为 img 显示', async () => {
    harness.open.mockResolvedValueOnce({
      ok: true,
      target: 'internal',
      viewer: 'image',
      rel: 'icon.ico',
    });
    harness.readImage.mockResolvedValueOnce({ ok: true, dataUrl: 'data:image/x-icon;base64,AAAA' });
    await render('[icon](icon.ico)');
    await click('a');
    expect(container.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(
      'data:image/x-icon;base64,AAAA'
    );
    harness.readImage.mockClear();
    harness.open.mockResolvedValueOnce({
      ok: true,
      target: 'internal',
      viewer: 'image',
      rel: 'vector.svg',
    });
    harness.readImage.mockResolvedValueOnce({
      ok: true,
      dataUrl: 'data:image/svg+xml;base64,AAAA',
    });
    await render('[svg](vector.svg)');
    await click('a');
    expect(container.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(
      'data:image/svg+xml;base64,AAAA'
    );
    expect(container.querySelector('iframe, object, embed')).toBeNull();
  });
});

describe('行内 code 路径 chip', () => {
  it.each([
    '`src/foo.ts`',
    '`foo.ts:12`',
    '`src/foo.ts:12-20`',
    '`src/`',
    '`src/renderer/components/`',
    '`./src/`',
    '`.agents/skills/`',
  ])('识别为可点 chip：%s', async (text) => {
    await render(text);
    expect(container.querySelector('button')?.textContent).toBe(text.slice(1, -1));
  });

  it.each([
    '`and/or`',
    '`TCP/IP`',
    '`他/她`',
    '`文档/`',
    '`/`',
    '`./`',
    '`../`',
    '`../../`',
    '`~/`',
    '`https://a.com/b/`',
    '`/Users/me/worktree/abc/`',
    '`C:\\foo\\`',
  ])('普通斜杠文本和非仓库相对目录不是链接：%s', async (text) => {
    await render(text);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe(text.slice(1, -1));
  });

  it.each(['see src/ and/or 他/她', '```\nsrc/renderer/\n```'])(
    '正文和代码块里的目录不渲染 chip：%s',
    async (text) => {
      await render(text);
      expect(container.querySelector('button')).toBeNull();
    }
  );

  it('工作区外的相对路径不是 chip，点击复制原文，不调 Main', async () => {
    const writeText = navigator.clipboard.writeText as Mock;
    writeText.mockResolvedValue(undefined);
    await render('`../shared/`');
    expect(container.querySelector('button')).toBeNull();
    await click('[data-copy-code]');
    expect(writeText).toHaveBeenCalledWith('../shared/');
    expect(harness.reveal).not.toHaveBeenCalled();
    expect(harness.resolveLinks).not.toHaveBeenCalled();
  });

  it('远程客户端调不了宿主文件管理器：目录可复制不判定，文件判定后 chip 照常', async () => {
    Object.assign(window.electronAPI, { remote: {} });
    await render('`src/renderer/` `src/foo.ts`');
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('src/foo.ts');
    expect(container.querySelector('[data-copy-code] code')?.textContent).toBe('src/renderer/');
    expect(harness.resolveLinks).toHaveBeenCalledTimes(1);
    expect(harness.resolveLinks.mock.calls[0][0].rels).toEqual(['src/foo.ts']);
  });

  it('末尾带斜杠的目录点击交给系统文件管理器，不打开 Files 面板', async () => {
    await render('`src/renderer/components/`');
    await click('button');
    expect(harness.reveal).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'src/renderer/components',
    });
    expect(harness.openSidePanelFile).not.toHaveBeenCalled();
    harness.reveal.mockResolvedValueOnce({ ok: false, error: 'unavailable' });
    await click('button');
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'The linked file or folder is unavailable.' })
    );
  });

  it('文件路径点击仍打开 Files 面板', async () => {
    await render('`src/foo.ts:12`');
    await click('button');
    expect(harness.openSidePanelFile).toHaveBeenCalledWith('child', 'src/foo.ts', 12);
    expect(harness.reveal).not.toHaveBeenCalled();
  });

  it('目录 chip 右键按所选应用打开（软链接由 Main 解析真实路径）', async () => {
    await render('`src/link/`');
    await click('button', 'contextmenu');
    await click('[role="menuitem"]:last-child');
    expect(harness.openContext).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'src/link',
      itemId: 'vscode',
    });
  });
});

describe('气泡文件卡片的打开方式', () => {
  async function renderChip(path: string) {
    await act(async () =>
      root.render(
        <MarkdownLinkContext.Provider value={context}>
          <LocalFileTrigger path={path}>
            <span data-chip="">{path}</span>
          </LocalFileTrigger>
        </MarkdownLinkContext.Provider>
      )
    );
  }
  const menuLabels = () =>
    [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

  it('工作区内（含 Windows 绝对路径）左键按相对路径打开', async () => {
    await renderChip('C:\\workspace\\src\\a.ts');
    await click('[data-chip]');
    expect(harness.open).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'src/a.ts',
    });
  });

  it('设置未启用定位时右键补「在文件夹中显示」，只发相对路径给 reveal', async () => {
    harness.contextMenuOpen = [];
    await renderChip('src/a.ts');
    await click('[data-chip]', 'contextmenu');
    expect(menuLabels()).toEqual(['Reveal in File Explorer', 'Copy Path']);
    await click('[role="menuitem"]:first-child');
    expect(harness.reveal).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      rel: 'src/a.ts',
    });
  });

  it('设置已启用定位时不重复，固定项排在设置项之前', async () => {
    await renderChip('src/a.ts');
    await click('[data-chip]', 'contextmenu');
    expect(menuLabels()).toEqual(['Copy Path', 'Reveal in File Explorer', 'Open in {{app}}']);
  });

  it('SSH 项目不补「在文件夹中显示」（Main 不支持远程定位）', async () => {
    harness.contextMenuOpen = [];
    harness.projects = [{ id: 'project', kind: 'ssh' }];
    await renderChip('src/a.ts');
    await click('[data-chip]', 'contextmenu');
    expect(menuLabels()).toEqual(['Copy Path']);
  });

  it('工作区外不可点击打开，右键只提供定位与复制路径', async () => {
    const writeText = navigator.clipboard.writeText as Mock;
    writeText.mockResolvedValue(undefined);
    const outside = 'C:\\Users\\me\\Desktop\\x.pdf';
    await renderChip(outside);
    await click('[data-chip]');
    expect(harness.revealExternal).not.toHaveBeenCalled();
    await click('[data-chip]', 'contextmenu');
    expect(menuLabels()).toEqual(['Reveal in File Explorer', 'Copy Path']);
    await click('[role="menuitem"]:last-child');
    expect(writeText).toHaveBeenCalledWith(outside);
    await click('[role="menuitem"]:first-child');
    expect(harness.revealExternal).toHaveBeenCalledWith({
      conversationId: 'child',
      projectId: 'project',
      path: outside,
    });
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.reveal).not.toHaveBeenCalled();
    expect(harness.openContext).not.toHaveBeenCalled();
  });

  it('工作区外相对越界或 SSH 项目仍只复制路径', async () => {
    await renderChip('../secret.txt');
    await click('[data-chip]', 'contextmenu');
    expect(menuLabels()).toEqual(['Copy Path']);
    harness.projects = [{ id: 'project', kind: 'ssh' }];
    await renderChip('C:\\Users\\me\\x.pdf');
    await click('[data-chip]', 'contextmenu');
    expect(menuLabels()).toEqual(['Copy Path']);
  });
});

describe('工作区外的聊天链接只定位（#157）', () => {
  const outside = 'C:/Users/me/AppData/Local/Temp/report.md';

  it('点击链接与定位按钮都只请求 Main 定位，传原路径不传 rel', async () => {
    await render(`[report](${outside})`);
    await click('a');
    await click('button');
    const request = { conversationId: 'child', projectId: 'project', path: outside };
    expect(harness.revealExternal).toHaveBeenNthCalledWith(1, request);
    expect(harness.revealExternal).toHaveBeenNthCalledWith(2, request);
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.reveal).not.toHaveBeenCalled();
  });

  it('右键菜单不提供按设置打开的应用，只有定位', async () => {
    await render(`[report](${outside})`);
    await click('a', 'contextmenu');
    expect(
      [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    ).toEqual(['Reveal in File Explorer']);
    await click('[role="menuitem"]');
    expect(harness.revealExternal).toHaveBeenCalledTimes(1);
    expect(harness.openContext).not.toHaveBeenCalled();
  });

  it('用户取消确认不报错；不存在等失败沿用越界提示', async () => {
    harness.revealExternal.mockResolvedValueOnce({ ok: false, error: 'cancelled' });
    await render(`[report](${outside})`);
    await click('a');
    expect(harness.toast).not.toHaveBeenCalled();
    harness.revealExternal.mockResolvedValueOnce({ ok: false, error: 'invalid-path' });
    await click('a');
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'The link is outside the current workspace.' })
    );
  });
});

describe('打不开的文件链接不高亮（先判定再渲染）', () => {
  const chips = () => [...container.querySelectorAll('button')].map((item) => item.textContent);
  const copies = () =>
    [...container.querySelectorAll('[data-copy-code] code')].map((item) => item.textContent);

  it('存在的是 chip，不存在、只有文件名且根目录没有、越界的都是可复制普通代码', async () => {
    harness.missing = new Set(['src/missing.ts', 'oauthProviders.ts']);
    await render(
      '`src/a.ts` `src/missing.ts` `oauthProviders.ts:142` `top.ts:3` `../out/x.ts` [web](https://example.com)'
    );
    expect(chips()).toEqual(['src/a.ts', 'top.ts:3']);
    expect(copies()).toEqual(['src/missing.ts', 'oauthProviders.ts:142', '../out/x.ts']);
    // 只有文件名时只查工作区根目录同名文件，不做模糊匹配
    expect(harness.resolveLinks).toHaveBeenCalledTimes(1);
    expect(harness.resolveLinks.mock.calls[0][0]).toEqual({
      conversationId: 'child',
      projectId: 'project',
      rels: ['src/a.ts', 'src/missing.ts', 'oauthProviders.ts', 'top.ts'],
    });
    const web = container.querySelector('a');
    expect(web?.getAttribute('href')).toBe('https://example.com');
    expect(web?.className).toContain('text-brand');
  });

  it('点击打不开的路径复制原文并提示已复制；拖选文字时不复制', async () => {
    const writeText = navigator.clipboard.writeText as Mock;
    writeText.mockResolvedValue(undefined);
    harness.missing = new Set(['oauthProviders.ts']);
    await render('`oauthProviders.ts:142`');
    // macOS 上 cursor: copy 是箭头加绿色「+」，与其他可点元素一致用 pointer
    const copyable = container.querySelector('[data-copy-code]');
    expect(copyable?.classList.contains('cursor-copy')).toBe(false);
    expect(copyable?.classList.contains('cursor-pointer')).toBe(true);
    await click('[data-copy-code]');
    expect(writeText).toHaveBeenCalledWith('oauthProviders.ts:142');
    expect(harness.toast).toHaveBeenCalledWith({ type: 'success', title: 'Copied' });
    expect(harness.openSidePanelFile).not.toHaveBeenCalled();
    writeText.mockClear();
    Object.assign(window, {
      getSelection: () => ({ isCollapsed: false, toString: () => 'oauth' }),
    });
    await click('[data-copy-code]');
    expect(writeText).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, 'getSelection');
  });

  it('剪贴板 API 被拒时退回 execCommand，仍失败则静默', async () => {
    (navigator.clipboard.writeText as Mock).mockRejectedValue(new Error('denied'));
    const execCommand = vi.fn(() => false);
    harness.missing = new Set(['x.ts']);
    await render('`x.ts:1`');
    const area = {
      value: '',
      style: {},
      setAttribute() {},
      select() {},
      setSelectionRange() {},
      remove() {},
    };
    vi.spyOn(document, 'createElement').mockReturnValue(area as never);
    vi.spyOn(document.body, 'appendChild').mockReturnValue(area as never);
    Object.assign(document, { execCommand });
    await click('[data-copy-code]');
    await settle();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(area.value).toBe('x.ts:1');
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it('一条消息里的候选路径合并成一次 IPC，重渲染命中缓存不再请求；超 200 条分批', async () => {
    await render('`src/a.ts` [b](src/b.md) `src/c/` `src/a.ts:9`');
    expect(harness.resolveLinks).toHaveBeenCalledTimes(1);
    expect(harness.resolveLinks.mock.calls[0][0].rels).toEqual(['src/a.ts', 'src/b.md', 'src/c']);
    await render('`src/a.ts` [b](src/b.md) `src/c/` again');
    expect(harness.resolveLinks).toHaveBeenCalledTimes(1);
    harness.resolveLinks.mockClear();
    await render(Array.from({ length: 250 }, (_, index) => `\`p/f${index}.ts\``).join(' '));
    expect(harness.resolveLinks.mock.calls.map(([request]) => request.rels.length)).toEqual([
      200, 50,
    ]);
  });

  it('判定结果回来前是中性普通代码，不先高亮', async () => {
    let finish: (value: unknown) => void = () => {};
    harness.resolveLinks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await render('`src/a.ts` [doc](README.md)');
    expect(chips()).toEqual([]);
    expect(copies()).toEqual([]);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('src/a.ts');
    await act(async () =>
      finish({
        ok: true,
        items: [
          { rel: 'src/a.ts', kind: 'file' },
          { rel: 'README.md', kind: 'file' },
        ],
      })
    );
    expect(chips()).toEqual(['src/a.ts', '']);
    expect(container.querySelector('button[aria-label="Reveal in File Explorer"]')).not.toBeNull();
    expect(container.querySelector('a')?.textContent).toBe('doc');
  });

  it('流式输出期间不判定，正文停顿 300ms 后才查', async () => {
    await render('`src/a.ts`', true, true);
    expect(harness.resolveLinks).not.toHaveBeenCalled();
    await render('`src/a.ts` `src/b.ts`', true, true);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(harness.resolveLinks).not.toHaveBeenCalled();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    await settle();
    expect(harness.resolveLinks).toHaveBeenCalledTimes(1);
    expect(chips()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('只判定接近视口的消息', async () => {
    const observers: { callback: (entries: { isIntersecting: boolean }[]) => void }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          observers.push({ callback });
        }
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('getComputedStyle', () => ({ overflowY: 'visible' }));
    await render('`src/a.ts`');
    expect(harness.resolveLinks).not.toHaveBeenCalled();
    expect(container.querySelector('code')?.textContent).toBe('src/a.ts');
    await act(async () => observers[0].callback([{ isIntersecting: true }]));
    await settle();
    expect(harness.resolveLinks).toHaveBeenCalledTimes(1);
    expect(chips()).toEqual(['src/a.ts']);
  });

  it('远程端或 SSH 判断不了（失败/拒绝）按打不开处理：可复制不可点', async () => {
    harness.resolveLinks.mockResolvedValueOnce({ ok: false, error: 'unsupported' });
    await render('`src/a.ts`');
    expect(chips()).toEqual([]);
    expect(copies()).toEqual(['src/a.ts']);
    resetFileLinkCache();
    harness.resolveLinks.mockRejectedValueOnce(new Error('tunnel closed'));
    await render('`src/b.ts`');
    expect(copies()).toEqual(['src/b.ts']);
  });

  it('点击时实时复查：文件已被删除则提示不可用并退回可复制', async () => {
    await render('`src/a.ts:3`');
    harness.missing = new Set(['src/a.ts']);
    await click('button');
    expect(harness.resolveLinks).toHaveBeenCalledTimes(2);
    expect(harness.openSidePanelFile).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'The linked file or folder is unavailable.' })
    );
    expect(copies()).toEqual(['src/a.ts:3']);
  });

  it('无链接上下文（精简版手机、Files 预览）路径一律可复制，不判定', async () => {
    await render('`src/a.ts:3` `src/dir/`', false);
    expect(chips()).toEqual([]);
    expect(copies()).toEqual(['src/a.ts:3', 'src/dir/']);
    expect(harness.resolveLinks).not.toHaveBeenCalled();
  });
});

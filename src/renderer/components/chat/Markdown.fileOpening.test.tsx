import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown, MarkdownLinkContext } from './Markdown';

const harness = vi.hoisted(() => ({
  open: vi.fn(),
  reveal: vi.fn(),
  readImage: vi.fn(),
  openSidePanelFile: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/sidePanelDock', () => ({ openSidePanelFile: harness.openSidePanelFile }));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.toast }));
vi.mock('./CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('./MermaidRenderer', () => ({ MermaidRenderer: () => null }));
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

async function render(text: string, authorized = true) {
  await act(async () =>
    root.render(
      <MarkdownLinkContext.Provider value={authorized ? context : null}>
        <Markdown text={text} />
      </MarkdownLinkContext.Provider>
    )
  );
}

async function click(selector: string) {
  const element = container.querySelector(selector);
  expect(element).not.toBeNull();
  let prevented = false;
  await act(async () => {
    const event = new window.Event('click', { bubbles: true, cancelable: true });
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
      workspaceFiles: { open: harness.open, reveal: harness.reveal, readImage: harness.readImage },
    },
  });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  vi.clearAllMocks();
  harness.open.mockResolvedValue({ ok: true, target: 'internal', viewer: 'text', rel: 'src/a.ts' });
  harness.reveal.mockResolvedValue({ ok: true });
  harness.readImage.mockResolvedValue({ ok: true, dataUrl: 'data:image/png;base64,AAAA' });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('聊天文件链接的打开方式', () => {
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

  it('http 链接维持外链，无上下文本地链接不导航且不展示 reveal 按钮', async () => {
    await render('[web](https://example.com)');
    expect(container.querySelector('a')?.getAttribute('target')).toBe('_blank');
    expect(await click('a')).toBe(false);
    expect(container.querySelector('button')).toBeNull();
    await render('[local](src/a.ts)', false);
    expect(await click('a')).toBe(true);
    expect(container.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(harness.open).not.toHaveBeenCalled();
  });

  it('越界与危险协议被拒绝，后端不可预览错误仍 toast', async () => {
    await render('[escape](../secret.txt)');
    await click('a');
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalled();
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

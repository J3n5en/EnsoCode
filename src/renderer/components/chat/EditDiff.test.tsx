import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditDiff } from './EditDiff';
import { EditDiffSourceContext } from './editDiffSource';
import { MarkdownLinkContext, type MarkdownLinkContextValue } from './Markdown';

const harness = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('@pierre/diffs', () => ({
  parseDiffFromFile: (oldFile: { contents: string }, newFile: { contents: string }) => ({
    oldText: oldFile.contents,
    newText: newFile.contents,
  }),
}));
vi.mock('@pierre/diffs/react', () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { oldText: string; newText: string } }) => (
    <pre data-diff="">{`${fileDiff.oldText}=>${fileDiff.newText}`}</pre>
  ),
}));
vi.mock('./codeHighlighter', () => ({
  CODE_THEME: '',
  ensureHighlighter: () => Promise.resolve(),
}));
vi.mock('@/hooks/useColorScheme', () => ({
  useCodeHighlightOptions: (options: unknown) => options,
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
// 真 Markdown 模块依赖太重；这里只要同一个 context 实例
vi.mock('./Markdown', async () => {
  const { createContext } = await import('react');
  return { MarkdownLinkContext: createContext(null) };
});

const blocks = [{ oldText: 'a = 1', newText: 'a = 2' }];
const link: MarkdownLinkContextValue = { conversationId: 'c1', projectId: 'p', cwd: '/repo' };
let root: Root;

async function render(node: ReactNode, context: MarkdownLinkContextValue | null = link) {
  await act(async () => {
    root.render(
      context ? (
        <MarkdownLinkContext.Provider value={context}>{node}</MarkdownLinkContext.Provider>
      ) : (
        node
      )
    );
  });
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.read.mockReset().mockResolvedValue('const a = 2;\n');
  Object.assign(dom.window, { electronAPI: { files: { read: harness.read } } });
  root = createRoot(dom.document.getElementById('root') as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

// 审计 J5a：FILES_READ 不再收磁盘路径，渲染层只能交会话标识 + 工作区相对路径
describe('EditDiff 读当前文件', () => {
  it('工作区内文件只把会话标识与相对路径交给 Main', async () => {
    await render(<EditDiff path="/repo/src/a.ts" blocks={blocks} />);
    expect(harness.read).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'c1',
      projectId: 'p',
      rel: 'src/a.ts',
    });
    expect(document.querySelector('[data-diff]')?.textContent).toBe(
      'const a = 1;\n=>const a = 2;\n'
    );
  });

  it('工作区外的绝对路径改走会话写入记录', async () => {
    await render(<EditDiff path="/etc/hosts" blocks={blocks} />);
    expect(harness.read).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'c1',
      projectId: 'p',
      path: '/etc/hosts',
    });
    expect(document.querySelector('[data-diff]')?.textContent).toBe(
      'const a = 1;\n=>const a = 2;\n'
    );
  });

  it('没有会话上下文（远程节点视图）时不读文件', async () => {
    await render(<EditDiff path="src/a.ts" blocks={blocks} />, null);
    expect(harness.read).not.toHaveBeenCalled();
    expect(document.querySelector('[data-diff]')?.textContent).toBe('a = 1=>a = 2');
  });

  it('Bot 时间线只给 EditDiff 提供会话标识', async () => {
    await render(
      <EditDiffSourceContext.Provider value={{ conversationId: 'b1', projectId: 'home' }}>
        <EditDiff path="notes/a.md" blocks={blocks} />
      </EditDiffSourceContext.Provider>,
      null
    );
    expect(harness.read).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'b1',
      projectId: 'home',
      rel: 'notes/a.md',
    });
  });
});

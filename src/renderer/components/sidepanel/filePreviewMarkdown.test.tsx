import { createContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * 只桩掉聊天 Markdown 组件的模块（它顶层会拉起真实设置 store /
 * `window.electronAPI`，脱离渲染进程无法 import）。桩里保留的都是
 * 本次修复**不涉及**的标签（a/table/code/pre/blockquote/hr）——被吞掉
 * align/width/colSpan 的 p/h1/h2/h3/ul/ol/th/td 在 `filePreviewMarkdown.tsx`
 * 里是我们自己实现的覆盖，不经这个桩，回归测试对它们仍是真实断言。
 */
vi.mock('@/components/chat/Markdown', () => {
  const MarkdownCtx = createContext({ text: '', streaming: false, searchQuery: '', activeNth: -1 });
  // p/h1-h3/ul/ol/th/td 复制自 chat/Markdown.tsx 的真实实现（只解构 children，不透传其余属性），
  // 这样这个回归测试才真正验证了 P0 bug（而不是因为桓里根本没定义这些标签而回退到默认 DOM 行为）。
  const markdownComponents = {
    p: ({ children }: { children?: React.ReactNode }) => (
      <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>
    ),
    h1: ({ children }: { children?: React.ReactNode }) => (
      <h1 className="mt-3 mb-1.5 text-base font-semibold">{children}</h1>
    ),
    a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
      <a href={href}>{children}</a>
    ),
    table: ({ children }: { children?: React.ReactNode }) => <table>{children}</table>,
    th: ({ children }: { children?: React.ReactNode }) => (
      <th className="border-b border-border px-2 py-1 text-left font-medium">{children}</th>
    ),
    td: ({ children }: { children?: React.ReactNode }) => (
      <td className="border-b border-border/50 px-2 py-1">{children}</td>
    ),
    code: ({ children }: { children?: React.ReactNode }) => <code>{children}</code>,
    pre: ({ children }: { children?: React.ReactNode }) => <pre>{children}</pre>,
    blockquote: ({ children }: { children?: React.ReactNode }) => (
      <blockquote>{children}</blockquote>
    ),
    hr: () => <hr />,
  };
  return { MarkdownCtx, markdownComponents };
});

const { FileMarkdownPreview } = await import('./filePreviewMarkdown');

const noop = async () => null;

/**
 * README 实际布局的回归测试：验证 rehype-sanitize 放行的原生 HTML 属性
 * （align/width/colSpan）真的落进最终渲染的 DOM，而不是被 react-markdown
 * 组件覆盖只解构 children 时静默丢弃。用 data: 图片保证同步渲染就能拿到
 * 最终 <img>（不依赖 useEffect 的异步解析，renderToStaticMarkup 不跑副作用）。
 */
function renderPreview(text: string): string {
  return renderToStaticMarkup(
    <FileMarkdownPreview text={text} baseDirRel="" resolveImage={noop} resolveRemoteImage={noop} />
  );
}

describe('FileMarkdownPreview：README 常见 HTML 布局落进最终 DOM', () => {
  it('<p align> 与 <h1 align> 保留 align 属性', () => {
    const html = renderPreview('<p align="center">centered</p>\n\n<h1 align="center">Title</h1>\n');
    expect(html).toContain('align="center"');
  });

  it('<img width/align> 保留 width（用 data: 图片保证同步渲染出最终 <img>）', () => {
    const html = renderPreview(
      '<p align="center"><img src="data:image/png;base64,AAAA" width="120" alt="EnsoCode" /></p>\n'
    );
    expect(html).toContain('width="120"');
    expect(html).toContain('align="center"');
    expect(html).toMatch(/<img[^>]*src="data:image\/png;base64,AAAA"/);
  });

  it('原生 HTML 表格的 colSpan 保留（不被 <td>/<th> 覆盖丢弃）', () => {
    const html = renderPreview(
      '<table><tr><th colspan="2">Header</th></tr><tr><td>A</td><td>B</td></tr></table>\n'
    );
    // React 对 colSpan 这类属性运行时不小写（HTML 属性名本身大小写不敏感，浏览器解析结果与
    // `colspan` 完全一致），断言不区分大小写
    expect(html.toLowerCase()).toContain('colspan="2"');
  });

  it('<b> 与 <details><summary> 正常渲染', () => {
    const html = renderPreview('<b>bold</b>\n\n<details><summary>more</summary>body</details>\n');
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>more</summary>');
  });
});

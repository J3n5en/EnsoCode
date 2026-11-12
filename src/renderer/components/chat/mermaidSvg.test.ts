import { describe, expect, it } from 'vitest';
import { decorateMermaidSvg, mermaidConfig, neutralizeMermaidLinks } from './mermaidSvg';

describe('decorateMermaidSvg', () => {
  it('给根 svg 加上不可聚焦，避免插入后被 scrollIntoView 吸走聊天滚动', () => {
    const out = decorateMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(out).toContain('focusable="false"');
    expect(out).toContain('tabindex="-1"');
  });

  it('已有 focusable 不重复改', () => {
    const src = '<svg focusable="false"></svg>';
    expect(decorateMermaidSvg(src)).toBe(src);
  });
});

describe('mermaidConfig', () => {
  // 真实场景：loose 会跳过 mermaid 最后一步 DOMPurify，click 链接原样保留 javascript: 等任意 URL
  it('图表按 strict 渲染，不跳过 mermaid 自带的净化', () => {
    expect(mermaidConfig('dark')).toMatchObject({ securityLevel: 'strict', theme: 'dark' });
  });
});

describe('neutralizeMermaidLinks', () => {
  // mermaid 11.17.2 strict 模式下 `click A "http://…"` 的真实输出：不带 target，点击即整窗跳走
  const clickLink =
    '<svg id="m"><a xlink:href="http://127.0.0.1:53561/evil" data-look="classic" transform="translate(42.71875, 35)"><g class="node default clickable " id="m-flowchart-A-0"><rect></rect></g></a></svg>';

  it('去掉节点链接的 xlink:href，节点图形与其它属性保留', () => {
    const out = neutralizeMermaidLinks(clickLink);
    expect(out).not.toContain('href');
    expect(out).toContain('<a data-look="classic" transform="translate(42.71875, 35)">');
    expect(out).toContain(
      '<g class="node default clickable " id="m-flowchart-A-0"><rect></rect></g>'
    );
  });

  it('href、target 和单引号写法一并去掉，HTML 标签里的 <a> / <area> 也不例外', () => {
    const out = neutralizeMermaidLinks(
      `<svg><a href='https://evil.example' target="_top"><text>x</text></a><foreignObject><div><a class="l" href="https://evil.example/?q=>">y</a><map><area shape="default" href="https://evil.example"></map></div></foreignObject></svg>`
    );
    expect(out).not.toMatch(/href|target/);
    expect(out).toContain('<a class="l">y</a>');
    expect(out).toContain('<area shape="default">');
  });

  it('不碰图内引用和图片：<use xlink:href="#id"> 是图形本身', () => {
    const svg =
      '<svg><use xlink:href="#computer"></use><image xlink:href="data:image/png;base64,AA"></image><animate attributeName="opacity"></animate></svg>';
    expect(neutralizeMermaidLinks(svg)).toBe(svg);
  });

  it('文字内容里像链接的部分原样保留', () => {
    const svg = '<svg><text>&lt;a href="https://example.com"&gt; a href=x</text></svg>';
    expect(neutralizeMermaidLinks(svg)).toBe(svg);
  });
});

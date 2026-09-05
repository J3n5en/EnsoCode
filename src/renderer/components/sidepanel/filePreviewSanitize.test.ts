import rehypeParse from 'rehype-parse';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { buildFilePreviewSanitizeSchema, rehypeRejectUnsafeImageSrc } from './filePreviewSanitize';

/** 跑真实的 rehype-raw 输出经 rehype-sanitize 白名单 + 后置图片校验的完整管道，而不只是断言 schema 形状 */
function sanitizeHtml(html: string): string {
  return unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize, buildFilePreviewSanitizeSchema())
    .use(rehypeRejectUnsafeImageSrc)
    .use(rehypeStringify)
    .processSync(html)
    .toString();
}

describe('buildFilePreviewSanitizeSchema：真实 HTML 管道', () => {
  it('保留 README 常见布局：p align / h1 / b / img width / details summary', () => {
    const out = sanitizeHtml(
      '<p align="center"><img src="a.png" width="120"/></p>' +
        '<h1 align="center">Title</h1><b>bold</b>' +
        '<details><summary>more</summary>body</details>'
    );
    expect(out).toContain('align="center"');
    expect(out).toContain('width="120"');
    expect(out).toContain('<h1');
    expect(out).toContain('<b>bold</b>');
    expect(out).toContain('<details>');
    expect(out).toContain('<summary>more</summary>');
  });

  it('剔除 script 标签及其内容', () => {
    const out = sanitizeHtml('<p>safe</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('剔除 onerror 等事件属性，img 标签本身保留', () => {
    const out = sanitizeHtml('<img src="a.png" onerror="alert(1)">');
    expect(out).not.toContain('onerror');
    expect(out).toContain('<img');
  });

  it('javascript: 链接被拒（href 被清空）', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript:');
  });

  it('data: 图片 src 放行（图片解析后注入用）', () => {
    const out = sanitizeHtml('<img src="data:image/png;base64,AAAA">');
    expect(out).toContain('data:image/png;base64,AAAA');
  });

  it('data: 携带 svg mime 的 img src 放行（svg 只通过 <img> 标签渲染，浏览器按图片上下文禁脚本，README 彽章 badge 多为 SVG）', () => {
    const out = sanitizeHtml('<img src="data:image/svg+xml;base64,AAAA" alt="x">');
    expect(out).toContain('data:image/svg+xml;base64,AAAA');
  });

  it('data: 携带非图片 mime（如 text/html）的 img src 仍会被剔除', () => {
    const out = sanitizeHtml('<img src="data:text/html;base64,AAAA" alt="x">');
    expect(out).not.toContain('data:text/html');
  });

  it('<source> 标签的 srcSet 被清空（响应式图片非本功能所需，收窄攻击面）', () => {
    const out = sanitizeHtml(
      '<picture><source srcset="javascript:alert(1) 1x"><img src="a.png"></picture>'
    );
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('javascript:');
  });

  it('svg 内嵌脚本与事件处理属性被整体剔除', () => {
    const out = sanitizeHtml('<svg onload="alert(1)"><script>alert(2)</script></svg>');
    expect(out).not.toContain('onload');
    expect(out).not.toContain('alert(2)');
    expect(out).not.toContain('<script');
  });

  it('img 的 srcset 不在白名单内，不能作为额外图片来源注入 javascript:', () => {
    const out = sanitizeHtml('<img src="a.png" srcset="javascript:alert(1) 1x">');
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('javascript:');
  });

  it('iframe / object / embed 一律不放行', () => {
    const out = sanitizeHtml(
      '<iframe src="https://evil.example"></iframe>' +
        '<object data="https://evil.example"></object>' +
        '<embed src="https://evil.example">'
    );
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<embed');
  });

  it('style 标签与内联 style 属性均不放行（防 CSS expression / 数据外泄）', () => {
    const out = sanitizeHtml(
      '<style>body{background:url(https://evil.example/x)}</style>' +
        '<p style="background:url(https://evil.example/x)">x</p>'
    );
    expect(out).not.toContain('<style');
    expect(out).not.toContain('style=');
  });
});

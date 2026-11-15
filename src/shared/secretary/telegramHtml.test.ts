import { describe, expect, it } from 'vitest';
import {
  htmlToPlain,
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  packTelegramBlocks,
} from './telegramHtml';

describe('markdown 转 Telegram HTML', () => {
  it('粗体、斜体、行内代码、删除线', () => {
    expect(markdownToTelegramHtml('**粗** 和 *斜* 和 `code` 和 ~~删~~')).toBe(
      '<b>粗</b> 和 <i>斜</i> 和 <code>code</code> 和 <s>删</s>'
    );
  });

  it('代码块整段进 pre，里面的标记不再解析', () => {
    const html = markdownToTelegramHtml('```ts\nconst a = **b**;\n```');
    expect(html).toBe('<pre>const a = **b**;</pre>');
  });

  it('链接转成 a 标签', () => {
    expect(markdownToTelegramHtml('见 [文档](https://example.com/a?b=1&c=2)')).toBe(
      '见 <a href="https://example.com/a?b=1&amp;c=2">文档</a>'
    );
  });

  it('标题转粗体，列表转圆点与序号', () => {
    expect(markdownToTelegramHtml('## 小节')).toBe('<b>小节</b>');
    expect(markdownToTelegramHtml('- 第一\n- 第二')).toBe('• 第一\n• 第二');
    expect(markdownToTelegramHtml('1. 甲\n2. 乙')).toBe('1. 甲\n2. 乙');
  });

  it('特殊字符一律转义，不会让 Telegram 解析失败', () => {
    expect(markdownToTelegramHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
    expect(markdownToTelegramHtml('`<script>`')).toBe('<code>&lt;script&gt;</code>');
  });

  it('表格转成对齐的等宽文本', () => {
    const html = markdownToTelegramHtml('| 名称 | 值 |\n| --- | --- |\n| a | 1 |\n| bbb | 22 |');
    expect(html.startsWith('<pre>')).toBe(true);
    const lines = htmlToPlain(html).split('\n');
    expect(lines[0]).toBe('名称   值');
    expect(lines[1]).toBe('a    1');
    expect(lines[2]).toBe('bbb  22');
  });

  it('引用转 blockquote', () => {
    expect(markdownToTelegramHtml('> 一句引用')).toBe('<blockquote>一句引用</blockquote>');
  });
});

describe('分条', () => {
  it('按行切到 3900 以内，内容不丢', () => {
    const line = '这一行大概六十个字符，用来把消息撑到上限以上，看看会不会被切开。';
    const markdown = Array.from({ length: 120 }, (_v, index) => `${index} ${line}`).join('\n');
    const chunks = markdownToTelegramChunks(markdown, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.html.length <= 500)).toBe(true);
    expect(chunks.map((chunk) => chunk.plain).join('\n')).toBe(
      markdown
        .split('\n')
        .map((row) => row)
        .join('\n')
    );
  });

  it('代码块太短放不下时整块搬到下一条，不从中间断', () => {
    const blocks = [
      { html: '开头一句', pre: false },
      { html: `<pre>${'x'.repeat(80)}</pre>`, pre: true },
    ];
    const chunks = packTelegramBlocks(blocks, 95);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe(`<pre>${'x'.repeat(80)}</pre>`);
  });

  it('超长代码块拆成几段 pre，一行不丢', () => {
    const code = Array.from({ length: 40 }, (_v, index) => `line ${index} ${'y'.repeat(20)}`);
    const chunks = packTelegramBlocks([{ html: `<pre>${code.join('\n')}</pre>`, pre: true }], 300);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith('<pre>') && chunk.endsWith('</pre>'))).toBe(
      true
    );
    expect(chunks.map((chunk) => htmlToPlain(chunk)).join('\n')).toBe(code.join('\n'));
  });

  it('纯文本兜底去掉标签、还原实体', () => {
    expect(htmlToPlain('<b>粗</b> &lt;tag&gt; &amp; 完')).toBe('粗 <tag> & 完');
  });
});

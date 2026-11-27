import { describe, expect, it } from 'vitest';
import {
  htmlToPlain,
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  packTelegramBlocks,
} from './telegramHtml';

/** 标签成对且正确嵌套（Telegram 解析不了交叉/未闭合的标签） */
function isBalanced(html: string): boolean {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)[^>]*>/giu)) {
    const name = match[2] ?? '';
    if (match[1]) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0 && !/<[^>]*$/u.test(html) && !/&[#a-z0-9]*$/iu.test(html);
}

describe('输出始终是 Telegram 能解析的 HTML', () => {
  it('file:// 链接渲染成 code，不生成 file 的 href', () => {
    const html = markdownToTelegramHtml('见 [report.md](file:///Users/a/report.md)');
    expect(html).toBe('见 <code>report.md</code>');
    expect(html).not.toContain('href="file');
  });

  it('conversation:// 等非 http 链接只留标签文字', () => {
    const html = markdownToTelegramHtml('打开 [那个会话](conversation://abc-123)');
    expect(html).toBe('打开 那个会话');
    expect(html).not.toContain('<a');
  });

  it('没有 scheme 的链接只留文字', () => {
    expect(markdownToTelegramHtml('[a](b)')).toBe('a');
  });

  it('行内代码里的 * _ ~~ 和链接语法原样保留', () => {
    const html = markdownToTelegramHtml('跑 `a*b*c _x_ ~~y~~ **z** [x](https://y)` 就行');
    expect(html).toBe('跑 <code>a*b*c _x_ ~~y~~ **z** [x](https://y)</code> 就行');
  });

  it('URL 里的 _ 和 * 不被当成斜体，href 保持原样', () => {
    const html = markdownToTelegramHtml('看 [这里](https://x.com/a_b_c*d*) 和 *斜*');
    expect(html).toBe('看 <a href="https://x.com/a_b_c*d*">这里</a> 和 <i>斜</i>');
  });

  it('标题里的粗体不嵌套 b', () => {
    expect(markdownToTelegramHtml('# **标题**')).toBe('<b>标题</b>');
    expect(markdownToTelegramHtml('## 前 **中** 后')).toBe('<b>前 中 后</b>');
  });

  it('交叉的标记不会生成交叉的标签', () => {
    const html = markdownToTelegramHtml('~~a **b~~ c**');
    expect(isBalanced(html)).toBe(true);
  });

  it('边界输入：空串、孤立反引号、未闭合粗体、输入里的 NUL', () => {
    expect(markdownToTelegramHtml('')).toBe('');
    expect(markdownToTelegramHtml('`')).toBe('`');
    expect(markdownToTelegramHtml('**没闭合')).toBe('**没闭合');
    expect(markdownToTelegramHtml('a\u00000\u0000 `c`')).toBe('a0 <code>c</code>');
  });

  it('超长单段带粗体和链接，切开后每条标签都成对且不超限', () => {
    const words = Array.from({ length: 30 }, (_v, index) =>
      index % 3 === 0
        ? `**粗体${index} 内容很长很长**`
        : index % 3 === 1
          ? `[链接${index} 文字](https://example.com/p_${index}?a=1&b=2)`
          : `普通 文字 ${index} a<b`
    );
    const markdown = words.join(' ');
    for (const limit of [60, 80, 137]) {
      const chunks = markdownToTelegramChunks(markdown, limit);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.html.length).toBeLessThanOrEqual(limit);
        expect(isBalanced(chunk.html)).toBe(true);
      }
      const whole = htmlToPlain(markdownToTelegramHtml(markdown)).replace(/\s/gu, '');
      expect(
        chunks
          .map((chunk) => chunk.plain)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(whole);
    }
  });

  it('没有空白的超长粗体也能切开，不切在实体中间', () => {
    const markdown = `**${'&'.repeat(200)}**`;
    const chunks = packTelegramBlocks([{ html: markdownToTelegramHtml(markdown), pre: false }], 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      expect(isBalanced(chunk)).toBe(true);
      expect(chunk.startsWith('<b>') && chunk.endsWith('</b>')).toBe(true);
    }
    expect(chunks.map(htmlToPlain).join('')).toBe('&'.repeat(200));
  });
});

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

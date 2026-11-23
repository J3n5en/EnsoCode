import { formatQuoteBlock, quotesAsMarkdown } from '@shared/quoteBlock';
import { extractRepresentativeTitle, mentionDisplayText } from '@shared/titleSource';
import { parseHTML } from 'linkedom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CodeBlock } from './CodeBlock';
import { createEditorPayload, serializeSegments, splitInlineMentions } from './mentionComposer';
import {
  buildQuoteSegment,
  QUOTE_MAX_LINES,
  quoteButtonPosition,
  quotePreview,
  selectionQuoteText,
} from './quoteSelection';

vi.mock('./CopyButton', () => ({ CopyButton: () => null }));

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

describe('buildQuoteSegment 超长截断', () => {
  it('空/纯空白不成引用', () => {
    expect(buildQuoteSegment('')).toBeNull();
    expect(buildQuoteSegment('  \n\t \n')).toBeNull();
  });

  it('阈值内完整保留，不带截断标注', () => {
    const quote = buildQuoteSegment(lines(QUOTE_MAX_LINES));
    expect(quote).toEqual({ type: 'quote', text: lines(QUOTE_MAX_LINES) });
    expect(formatQuoteBlock(quote!)).not.toContain('truncated');
  });

  it('超阈值截到前 200 行，并记下原始行数', () => {
    const quote = buildQuoteSegment(lines(250));
    expect(quote?.originalLines).toBe(250);
    expect(quote?.text.split('\n')).toHaveLength(QUOTE_MAX_LINES);
    expect(quote?.text).not.toContain('line 201');
    expect(formatQuoteBlock(quote!)).toContain('original-lines="250"');
  });

  it('截断切开代码围栏时补上收尾围栏', () => {
    const quote = buildQuoteSegment(`\`\`\`ts\n${lines(300)}\n\`\`\``);
    expect(quote?.text.endsWith('\n```')).toBe(true);
    expect(quote?.text.match(/^```/gm)).toHaveLength(2);
  });
});

describe('引用块 wire 往返', () => {
  it('段 → wire → 段：插在正文之间，独占行，不吞前后文字', () => {
    const segments = [
      { type: 'text' as const, text: '看这段' },
      { type: 'quote' as const, text: 'a < b && </quote> c' },
      { type: 'text' as const, text: '\u00a0为什么？' },
    ];
    const wire = serializeSegments(segments);
    expect(wire).toBe('看这段\n<quote>\na < b && <\\/quote> c\n</quote>\n为什么？');
    expect(splitInlineMentions(wire)).toEqual([
      { type: 'text', text: '看这段' },
      { type: 'quote', text: 'a < b && </quote> c' },
      { type: 'text', text: '为什么？' },
    ]);
  });

  it('截断标注随 wire 往返', () => {
    const wire = formatQuoteBlock({ text: 'x', originalLines: 999 });
    expect(splitInlineMentions(wire)).toEqual([{ type: 'quote', text: 'x', originalLines: 999 }]);
  });

  it('引用不算 mention，与 @会话 引用互不干扰', () => {
    const payload = createEditorPayload({
      segments: [
        { type: 'chat', label: '旧会话', sessionFile: '/s/a.jsonl', conversationId: 'c1' },
        { type: 'quote', text: '片段' },
      ],
      slashes: [],
      images: [],
    });
    expect(payload.mentions).toEqual([
      { kind: 'chat', id: 'c1', label: '旧会话', sessionFile: '/s/a.jsonl' },
    ]);
    expect(payload.text).toContain('[Referenced past chat "旧会话"');
    expect(payload.text).toContain('<quote>\n片段\n</quote>');
  });

  it('复制/标题/纯文本投影不露原始标签', () => {
    const wire = `${formatQuoteBlock({ text: 'one\ntwo', originalLines: 300 })}\n追问`;
    for (const out of [quotesAsMarkdown(wire), mentionDisplayText(wire)]) {
      expect(out).not.toMatch(/<\/?quote/);
      expect(out).toContain('> one\n> two');
      expect(out).toContain('追问');
    }
    expect(extractRepresentativeTitle(wire)).toBe('追问');
    expect(extractRepresentativeTitle(formatQuoteBlock({ text: '只有引用' }))).toBe('只有引用');
  });
});

describe('quotePreview 折叠预览', () => {
  it('超过 3 行只给前 3 行并标记被折叠', () => {
    expect(quotePreview(lines(10))).toEqual({ preview: lines(3), clipped: true });
    expect(quotePreview('a\nb')).toEqual({ preview: 'a\nb', clipped: false });
  });
});

describe('selectionQuoteText', () => {
  const { document } = parseHTML(
    '<html><body><div id="tl">' +
      '<div data-nav-key="1"><p id="p">hello world</p></div>' +
      '<div data-nav-key="2"><div data-enso="code-block" data-language="ts"><pre><code id="code">const a = 1;\nconst b = 2;</code></pre></div></div>' +
      '</div><p id="outside">outside</p></body></html>'
  );
  const container = document.getElementById('tl') as unknown as Element;
  const node = (id: string) => document.getElementById(id)?.firstChild as unknown as Node;
  const sel = (anchor: Node, focus: Node, text: string, common: Node = anchor) =>
    ({
      rangeCount: 1,
      isCollapsed: false,
      anchorNode: anchor,
      focusNode: focus,
      toString: () => text,
      getRangeAt: () => ({
        commonAncestorContainer: common,
        cloneContents: () => document.createDocumentFragment(),
      }),
    }) as unknown as Selection;

  it('普通文本原样返回', () => {
    expect(selectionQuoteText(sel(node('p'), node('p'), 'hello'), container)).toBe('hello');
  });

  it('空白选区 / 时间线外 / 跨消息不给引用', () => {
    expect(selectionQuoteText(sel(node('p'), node('p'), '  \n '), container)).toBeNull();
    expect(selectionQuoteText(sel(node('outside'), node('outside'), 'out'), container)).toBeNull();
    expect(
      selectionQuoteText(sel(node('p'), node('code'), 'hello const', container), container)
    ).toBeNull();
  });

  it('代码块里选中包成带语言的围栏', () => {
    expect(selectionQuoteText(sel(node('code'), node('code'), 'const a = 1;'), container)).toBe(
      '```ts\nconst a = 1;\n```'
    );
  });

  // 真机：拖选回复末尾时多拖一点，「对话分支 / 用时 / TTFT」操作条文字会混进引用
  it('选区带上消息的操作条 / 模型抬头时，引用里不含这些界面文字', () => {
    const fragment = document.createDocumentFragment();
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<div data-quote-skip="">fake-model-1 · 18:01</div><p>最后一段正文</p><div data-quote-skip=""><button>复制</button><span>对话分支</span><span>用时 0.1s</span></div>';
    fragment.append(...wrap.childNodes);
    const selection = {
      ...sel(node('p'), node('p'), 'fake-model-1 · 18:01\n最后一段正文\n\n对话分支\n用时 0.1s'),
      getRangeAt: () => ({ commonAncestorContainer: node('p'), cloneContents: () => fragment }),
    } as unknown as Selection;
    expect(selectionQuoteText(selection, container)).toBe('最后一段正文');
  });

  it('真实代码块带上语言标记，选中时才能还原围栏语言', () => {
    const html = renderToStaticMarkup(
      createElement(CodeBlock, { code: 'x', language: 'ts', streaming: true })
    );
    expect(html).toContain('data-enso="code-block" data-language="ts"');
  });
});

describe('quoteButtonPosition', () => {
  const viewport = { width: 375, height: 600 };
  const size = { width: 72, height: 28 };
  it('夹在视口内，不跑出屏幕', () => {
    const pos = quoteButtonPosition(
      { top: 2, bottom: 20, left: 360, right: 420 },
      viewport,
      size,
      false
    );
    expect(pos.left).toBeLessThanOrEqual(viewport.width - size.width - 8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });
  it('窄屏放在选区下方，避开系统选择菜单', () => {
    const pos = quoteButtonPosition(
      { top: 200, bottom: 220, left: 10, right: 100 },
      viewport,
      size,
      true
    );
    expect(pos.top).toBeGreaterThan(220);
  });

  const overlaps = (
    pos: { top: number; left: number },
    r: { top: number; bottom: number; left: number; right: number }
  ) =>
    pos.left < r.right &&
    pos.left + size.width > r.left &&
    pos.top < r.bottom &&
    pos.top + size.height > r.top;

  // 真机 390 宽：选中用户消息文字，按钮正好压在下方「回退 / 复制 / 对话分支」上
  it('窄屏选区下方是消息操作行时，改到选区上方', () => {
    const selection = { top: 200, bottom: 220, left: 150, right: 300 };
    const actions = { top: 226, bottom: 246, left: 120, right: 370 };
    const pos = quoteButtonPosition(selection, viewport, size, true, [actions]);
    expect(overlaps(pos, actions)).toBe(false);
    expect(pos.top + size.height).toBeLessThanOrEqual(selection.top);
  });

  it('桌面选区上方被占时翻到下方，上下都被占时往旁边让开', () => {
    const selection = { top: 200, bottom: 220, left: 100, right: 200 };
    const header = { top: 160, bottom: 196, left: 60, right: 260 };
    const below = quoteButtonPosition(selection, viewport, size, false, [header]);
    expect(overlaps(below, header)).toBe(false);
    expect(below.top).toBeGreaterThanOrEqual(selection.bottom);

    const actions = { top: 222, bottom: 256, left: 60, right: 260 };
    const aside = quoteButtonPosition(selection, viewport, size, false, [header, actions]);
    expect(overlaps(aside, header)).toBe(false);
    expect(overlaps(aside, actions)).toBe(false);
  });

  // 真机 390 宽：选中回复最后一段，下方是整行操作条，上方紧挨着下一条消息的整行抬头
  it('上下都被整行占满时，贴着选区旁边放，仍不压住任何一行', () => {
    const selection = { top: 650, bottom: 666, left: 14, right: 63 };
    const header = { top: 619, bottom: 640, left: 14, right: 368 };
    const actions = { top: 673, bottom: 689, left: 14, right: 368 };
    const pos = quoteButtonPosition(selection, { width: 390, height: 844 }, size, true, [
      header,
      actions,
    ]);
    expect(overlaps(pos, header)).toBe(false);
    expect(overlaps(pos, actions)).toBe(false);
    expect(overlaps(pos, selection)).toBe(false);
  });
});

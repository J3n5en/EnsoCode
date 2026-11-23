import { parseHTML } from 'linkedom';
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerComposerInsertQuote } from './composerMentionBridge';
import { MentionEditor, type MentionEditorHandle } from './MentionEditor';
import { createEditorPayload } from './mentionComposer';
import { QuoteSelectionButton } from './QuoteSelectionButton';
import { buildQuoteSegment } from './quoteSelection';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars?.[name])),
  }),
}));
let enabled = true;
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) =>
    select({ quoteSelectionButton: enabled }),
}));
vi.mock('@/hooks/useViewport', () => ({ useIsMobile: () => false }));

let selection: Selection | null = null;
let root: Root;
let host: HTMLElement;
let editor: MentionEditorHandle | null = null;

function Harness() {
  const editorRef = useRef<MentionEditorHandle>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    editor = editorRef.current;
    return registerComposerInsertQuote((quote) => editorRef.current?.insertQuote(quote));
  }, []);
  return (
    <>
      <div ref={timelineRef} data-enso="timeline">
        <div data-nav-key="1">
          <p id="msg">hello world</p>
        </div>
        <div data-nav-key="2">
          <div data-enso="code-block" data-language="ts">
            <pre>
              <code id="code">{'const a = 1;\nconst b = 2;'}</code>
            </pre>
          </div>
        </div>
      </div>
      <QuoteSelectionButton containerRef={timelineRef} />
      <MentionEditor
        ref={editorRef}
        placeholder=""
        onStateChange={() => {}}
        onKeyDown={() => {}}
        onPaste={() => {}}
        onCompositionStart={() => {}}
        onCompositionEnd={() => {}}
      />
    </>
  );
}

const textNode = (id: string) => host.querySelector(`#${id}`)?.firstChild as Node;

function select(anchor: Node, text: string, focus: Node = anchor) {
  selection = {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: anchor,
    focusNode: focus,
    toString: () => text,
    getRangeAt: () => ({
      commonAncestorContainer: anchor,
      cloneContents: () => document.createDocumentFragment(),
      getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 50, right: 150 }),
    }),
    removeAllRanges: () => {
      selection = null;
    },
    collapse: () => {},
    addRange: () => {},
  } as unknown as Selection;
  document.dispatchEvent(new window.Event('selectionchange'));
}

const quoteButton = () =>
  document.querySelector('[data-enso="quote-selection"]') as HTMLElement | null;
const quoteChip = () => host.querySelector('[data-mention-kind="quote"]') as HTMLElement | null;
const payloadText = () =>
  createEditorPayload({ segments: editor?.getSegments() ?? [], slashes: [], images: [] }).text;

beforeEach(async () => {
  enabled = true;
  selection = null;
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(window, { getSelection: () => selection, innerWidth: 1200, innerHeight: 800 });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('选中文本引用到输入框', () => {
  it('选中后出现「引用」按钮，点击后引用块进入输入框，发送带完整上下文', async () => {
    await act(async () => select(textNode('msg'), 'hello world'));
    expect(quoteButton()).not.toBeNull();
    await act(async () => quoteButton()?.click());
    expect(quoteChip()?.textContent).toContain('hello world');
    expect(quoteButton()).toBeNull();
    expect(payloadText()).toBe('<quote>\nhello world\n</quote>');
    // 输入框里展示的是引用卡片，不是原始标签
    expect(host.textContent).not.toContain('<quote>');
  });

  it('空 / 纯空白选中不弹按钮', async () => {
    await act(async () => select(textNode('msg'), '   \n  '));
    expect(quoteButton()).toBeNull();
  });

  it('跨消息选中不弹按钮', async () => {
    await act(async () => select(textNode('msg'), 'hello const', textNode('code')));
    expect(quoteButton()).toBeNull();
  });

  it('代码块里选中保留代码块格式', async () => {
    await act(async () => select(textNode('code'), 'const a = 1;'));
    await act(async () => quoteButton()?.click());
    expect(payloadText()).toBe('<quote>\n```ts\nconst a = 1;\n```\n</quote>');
  });

  it('设置关掉后不弹按钮', async () => {
    enabled = false;
    await act(async () => root.render(<Harness />));
    await act(async () => select(textNode('msg'), 'hello world'));
    expect(quoteButton()).toBeNull();
  });
});

describe('输入框引用块折叠 / 展开', () => {
  const tenLines = Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join('\n');

  it('默认折叠只显示前几行，点击展开全文，点外部缩回；折叠时发送仍是全文', async () => {
    await act(async () => editor?.insertQuote(buildQuoteSegment(tenLines)!));
    const chip = quoteChip();
    const body = () => chip?.querySelector('[data-quote-body]')?.textContent ?? '';
    expect(chip?.dataset.expanded).toBeUndefined();
    expect(body()).toContain('row 3');
    expect(body()).not.toContain('row 10');
    expect(chip?.querySelector('[data-quote-toggle]')).not.toBeNull();
    // 折叠态发送的是完整引用
    expect(payloadText()).toContain('row 10');
    expect(payloadText()).toBe(`<quote>\n${tenLines}\n</quote>`);

    await act(async () => chip?.click());
    expect(chip?.dataset.expanded).toBe('true');
    expect(body()).toContain('row 10');
    expect(chip?.querySelector('[data-quote-body]')?.className).toMatch(
      /max-h-\S+ .*overflow-y-auto/
    );

    await act(async () => {
      document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    });
    expect(chip?.dataset.expanded).toBeUndefined();
    expect(body()).not.toContain('row 10');
    expect(payloadText()).toBe(`<quote>\n${tenLines}\n</quote>`);
  });

  it('超长引用截断后在卡片上标注原始行数，与折叠提示区分', async () => {
    const long = Array.from({ length: 260 }, (_, i) => `l${i + 1}`).join('\n');
    await act(async () => editor?.insertQuote(buildQuoteSegment(long)!));
    const badge = quoteChip()?.querySelector('[data-quote-truncated]');
    expect(badge?.textContent).toContain('260');
    expect(badge).not.toBe(quoteChip()?.querySelector('[data-quote-toggle]'));
    expect(payloadText()).toContain('<quote truncated="true" original-lines="260">');
    expect(payloadText()).not.toContain('l201');
  });

  it('阈值内的引用卡片不带截断标注', async () => {
    await act(async () => editor?.insertQuote(buildQuoteSegment(tenLines)!));
    expect(quoteChip()?.querySelector('[data-quote-truncated]')).toBeNull();
  });

  // 真机：从 260 行代码块里全选引用，卡片曾标「原文 262 行」「引用 · 201 行」（把包裹的围栏行算进去）
  it('代码块引用的行数按代码行计，不算包裹的围栏行', async () => {
    const code = Array.from({ length: 260 }, (_, i) => `c${i + 1}`).join('\n');
    await act(async () => editor?.insertQuote(buildQuoteSegment(`\`\`\`js\n${code}\n\`\`\``)!));
    const chip = quoteChip();
    expect(chip?.querySelector('[data-quote-truncated]')?.textContent).toContain('260');
    expect(chip?.textContent).toContain('Quote · 200 lines');
    expect(payloadText()).toContain('c200');
    expect(payloadText()).not.toContain('c201');
  });
});

import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? '')),
  }),
}));
vi.mock('@/lib/sidePanelDock', () => ({
  openSidePanelFile: vi.fn(),
  openSidePanelBrowserUrl: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ addToast: vi.fn() }));
vi.mock('./CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code">{code}</pre>,
}));
vi.mock('./MermaidRenderer', () => ({ MermaidRenderer: () => null }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      contextMenuOpen: [],
      projects: [],
      disabledBuiltinTools: [],
      openLinksInBuiltinBrowser: false,
    }),
}));

let root: Root;
let container: HTMLElement;

function stubDom() {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('navigator', { userAgent: 'Mac', clipboard: { writeText: vi.fn() } });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return dom;
}

async function render(text: string, streaming = false) {
  await act(async () => root.render(<Markdown text={text} streaming={streaming} />));
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
}

const column = (index: number) =>
  [...container.querySelectorAll('tbody tr')].map(
    (row) => row.querySelectorAll('td')[index]?.textContent
  );

beforeEach(() => {
  const dom = stubDom();
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('富代码块', () => {
  it('完整 JSON 画成可折叠树，可切回原文；流式中仍是代码', async () => {
    const json = '```json\n{"user": {"name": "a", "tags": [1, 2]}, "ok": true}\n```';
    await render(json, true);
    expect(container.querySelector('[data-enso="json-tree"]')).toBeNull();
    await render(json);
    const tree = container.querySelector('[data-enso="json-tree"]');
    expect(tree?.textContent).toContain('user');
    expect(tree?.textContent).toContain('"a"');
    const toggles = [...(tree?.querySelectorAll('button[aria-expanded]') ?? [])];
    await click(toggles[0]);
    expect(tree?.textContent).not.toContain('"a"');
    await click(
      [...(tree?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Raw text')
    );
    expect(container.querySelector('[data-testid="code"]')?.textContent).toContain('"user"');
  });

  it('终端输出：命令与输出分开，ANSI 颜色上色、转义不外露', async () => {
    await render('```console\n$ npm test\n\u001b[32m27 passed\u001b[0m\n```');
    const block = container.querySelector('[data-enso="terminal-block"]');
    expect(block?.textContent).toContain('npm test');
    expect(block?.textContent).not.toContain('\u001b');
    const colored = [...(block?.querySelectorAll('span[style]') ?? [])].find(
      (span) => span.textContent === '27 passed'
    );
    expect(colored?.getAttribute('style')).toContain('color');
  });

  it('长输出只留末尾，可展开全部', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
    await render(`\`\`\`output\n${lines}\n\`\`\``);
    const block = container.querySelector('[data-enso="terminal-block"]');
    expect(block?.textContent).toContain('line 60');
    expect(block?.textContent).not.toContain('line 1\n');
    await click(block?.querySelector('button'));
    expect(block?.textContent).toContain('line 1\n');
  });
});

describe('Markdown 表格', () => {
  const table = [
    '| name | latency |',
    '| --- | --- |',
    '| beta | 412 ms |',
    '| alpha | 9 ms |',
    '| gamma | 1,200 ms |',
  ].join('\n');

  it('点表头：数值列按数值升序 → 降序 → 原序', async () => {
    await render(table);
    const header = () => container.querySelectorAll('th button')[1];
    await click(header());
    expect(column(1)).toEqual(['9 ms', '412 ms', '1,200 ms']);
    await click(header());
    expect(column(1)).toEqual(['1,200 ms', '412 ms', '9 ms']);
    await click(header());
    expect(column(0)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('流式中不提供排序', async () => {
    await render(table, true);
    expect(container.querySelectorAll('th button')).toHaveLength(0);
  });

  it('行数较多时可搜索过滤', async () => {
    const many = [
      '| id | owner |',
      '| --- | --- |',
      ...Array.from({ length: 8 }, (_, i) => `| ${i} | ${i % 2 ? 'alice' : 'bob'} |`),
    ].join('\n');
    await render(many);
    await click(container.querySelector('button[title="Search table"]'));
    const input = container.querySelector('input') as unknown as HTMLInputElement;
    await act(async () => {
      input.value = 'ALICE';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(column(1)).toEqual(['alice', 'alice', 'alice', 'alice']);
  });
});

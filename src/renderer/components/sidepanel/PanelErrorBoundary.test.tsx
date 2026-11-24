import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copied = vi.hoisted(() => ({ text: '' }));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => `[${key}]` }) }));
vi.mock('@/lib/copyText', () => ({
  copyText: async (text: string) => {
    copied.text = text;
    return true;
  },
}));

const { PanelErrorBoundary } = await import('./PanelErrorBoundary');

let root: Root;
let container: HTMLElement;
let broken = true;

function Board({ needsYou }: { needsYou: unknown[] | null }) {
  if (broken) return <p>{(needsYou as unknown[]).length}</p>;
  return <p data-enso="board-ok">ok</p>;
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  broken = true;
  copied.text = '';
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function click(selector: string) {
  const node = container.querySelector(selector) as unknown as HTMLElement | null;
  expect(node, selector).not.toBeNull();
  act(() => node?.click());
}

describe('PanelErrorBoundary', () => {
  it('子面板抛错时只在这块显示原因，旁边的内容照常渲染', async () => {
    await act(async () => {
      root.render(
        <>
          <p data-enso="sibling">tabs</p>
          <PanelErrorBoundary name="secretary">
            <Board needsYou={null} />
          </PanelErrorBoundary>
        </>
      );
    });
    expect(container.querySelector('[data-enso="sibling"]')?.textContent).toBe('tabs');
    const fallback = container.querySelector('[data-enso="side-panel-error"]');
    expect(fallback?.textContent).toContain('[This panel crashed]');
    expect(container.querySelector('[data-enso="side-panel-error-message"]')?.textContent).toMatch(
      /length/
    );
  });

  it('复制错误带上面板名和报错；重试后恢复渲染', async () => {
    await act(async () => {
      root.render(
        <PanelErrorBoundary name="secretary">
          <Board needsYou={null} />
        </PanelErrorBoundary>
      );
    });
    click('[data-enso="side-panel-error-copy"]');
    await act(async () => {
      await Promise.resolve();
    });
    expect(copied.text).toContain('[secretary]');
    expect(copied.text).toMatch(/TypeError/);
    expect(container.querySelector('[data-enso="side-panel-error-copy"]')?.textContent).toBe(
      '[Copied]'
    );

    broken = false;
    click('[data-enso="side-panel-error-retry"]');
    expect(container.querySelector('[data-enso="side-panel-error"]')).toBeNull();
    expect(container.querySelector('[data-enso="board-ok"]')?.textContent).toBe('ok');
  });
});

import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnCollapseFooter } from './TimelineRow';

const settings = { autoCollapseTurns: true };

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select(settings),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  settings.autoCollapseTurns = true;
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const render = (props: Partial<Parameters<typeof TurnCollapseFooter>[0]>) =>
  act(async () =>
    root.render(
      createElement(TurnCollapseFooter, {
        turnKey: '4',
        canCollapse: true,
        collapsed: false,
        onToggleTurn: () => {},
        ...props,
      })
    )
  );
const footer = () => container.querySelector<HTMLButtonElement>('[data-enso="turn-collapse"]');

describe('轮次末尾收起入口', () => {
  it('自动折叠开启、可折叠且已展开时出现，点击按目标状态收起该轮', async () => {
    const onToggleTurn = vi.fn();
    await render({ onToggleTurn });
    const button = footer();
    expect(button?.textContent).toBe('Collapse');
    expect(button?.hasAttribute('data-quote-skip')).toBe(true);
    await act(async () => button?.click());
    expect(onToggleTurn).toHaveBeenCalledWith('4', true);
  });

  // 手机浏览器打开 /desk 时没有 hover：24px 高的文字按钮难点中，触屏下加高到 40px；选中复制时不带入「收起」
  it('触屏下加大点击区，且不参与文本选中', async () => {
    await render({});
    const classes = footer()?.className.split(/\s+/) ?? [];
    expect(classes).toContain('[@media(hover:none)]:min-h-10');
    expect(classes).toContain('select-none');
  });

  it('关闭「回答完成后折叠过程」时不出现任何收起入口', async () => {
    settings.autoCollapseTurns = false;
    await render({});
    expect(footer()).toBeNull();
  });

  it('已折叠或不可折叠的轮次不出现', async () => {
    await render({ collapsed: true });
    expect(footer()).toBeNull();
    await render({ canCollapse: false });
    expect(footer()).toBeNull();
    await render({ onToggleTurn: undefined });
    expect(footer()).toBeNull();
  });
});

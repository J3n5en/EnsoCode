/** pinned tab 的 ×/pin 不得占布局宽度：非 hover 时 tab 宽度 = 图标+标题+pin 指示器的固有宽度。
 *  hover/focus-visible 时 overlay 并排浮出 pin/unpin 与 ×，盖住指示器位置，不留任何预留 padding。
 *  shell 还必须把 ref/className/...rest 透传到根 div，否则 ContextMenuTrigger 的右键菜单失效。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { SidePanelTabShell } from './sidePanelTabShell';

/** 与 SidePanel.tsx 的 SidePanelTab 同构的 props：静态 pin 指示器 + overlay 内 pin/unpin 按钮 */
const tabUnderTest = (pinned: boolean, onToggle?: () => void) => (
  <SidePanelTabShell
    panelId="changes"
    active={false}
    pinned={pinned}
    icon={<i data-test-icon />}
    title={<span className="min-w-0 max-w-32 truncate">enso-code</span>}
    pinIndicator={
      pinned ? (
        <span
          aria-hidden
          data-pinned-indicator
          className="inline-flex shrink-0 p-0.5 text-primary transition-opacity duration-100 group-hover/tab:opacity-0 group-has-[:focus-visible]/tab:opacity-0"
        />
      ) : undefined
    }
    pinHoverButton={
      <button
        type="button"
        aria-label={pinned ? 'Unpin default tab' : 'Pin as default tab'}
        aria-pressed={pinned}
        title={pinned ? 'Unpin default tab' : 'Pin as default tab'}
        className="relative"
        onClick={onToggle}
      />
    }
    closeButton={<button type="button" aria-label="close" className="relative" />}
  />
);

const shell = (pinned: boolean) => renderToStaticMarkup(tabUnderTest(pinned));

describe('pinned tab 零占位布局', () => {
  it('tab 根没有为 hover 按钮预留的 padding/padding-right', () => {
    for (const html of [shell(false), shell(true)]) {
      const rootTag = html.slice(0, html.indexOf('>') + 1);
      expect(rootTag).not.toMatch(/pr-\d|pr-\[|padding-right|padding-inline-end/);
    }
  });

  it('pinned 的静态 pin 指示器是 flex 流内的普通子节点：在 overlay 之前、无 absolute', () => {
    const html = shell(true);
    const pinIndex = html.indexOf('data-pinned-indicator');
    expect(pinIndex).toBeGreaterThan(-1);
    // overlay 容器在指示器之后出现（指示器不在 overlay 里）
    const overlayIndex = html.indexOf('pointer-events-none absolute inset-y-0 right-0');
    expect(overlayIndex).toBeGreaterThan(-1);
    expect(pinIndex).toBeLessThan(overlayIndex);
  });

  it('overlay 贴右缘右零偏移：pinned 与否一致，不存在让位 pin 槽的 right-[ 变体', () => {
    for (const html of [shell(false), shell(true)]) {
      expect(html).toContain('absolute inset-y-0 right-0');
      expect(html).not.toContain('right-[');
    }
  });

  it('渐变蒙版始终渲染且覆盖到双按钮（from-65% 保证 pin/unpin 与 × 都落在可读区）', () => {
    for (const html of [shell(false), shell(true)]) {
      expect(html).toContain('bg-linear-to-l');
      expect(html).toContain('from-muted/95');
      expect(html).toContain('from-65%');
    }
  });

  it('sidepanel-dock.css 不为 pinned tab 预留任何 padding', () => {
    const css = readFileSync(resolve(__dirname, 'sidepanel-dock.css'), 'utf8');
    const blocks = css.match(/\[data-side-tab\]\[data-pinned\][^{]*\{[^}]*\}/g) ?? [];
    for (const block of blocks) {
      expect(block).not.toContain('padding');
    }
    // 历史回归：2.75rem 预留曾撑宽 pinned tab
    expect(css).not.toContain('2.75rem');
  });
});

describe('真实 DOM 回归', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('navigator', { userAgent: 'Windows' });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = dom.document.getElementById('root') as unknown as HTMLElement;
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  const buttons = (label: string) =>
    [...container.querySelectorAll(`button[aria-label="${label}"]`)] as HTMLButtonElement[];

  it('ref/className/onContextMenu 透传到根 div：真实 ContextMenuTrigger 右键能打开菜单', async () => {
    const onContextMenu = vi.fn();
    let outerRef: HTMLDivElement | null = null;
    let innerRef: HTMLDivElement | null = null;
    await act(async () =>
      root.render(
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <SidePanelTabShell
                panelId="changes"
                active={false}
                pinned={false}
                icon={<i data-test-icon />}
                title={<span>enso-code</span>}
                closeButton={<button type="button" aria-label="close" />}
                className="test-extra-class"
                onContextMenu={onContextMenu}
                ref={(node) => {
                  outerRef = node;
                }}
                tabRef={(node) => {
                  innerRef = node;
                }}
              />
            }
          />
          <ContextMenuPopup>
            <ContextMenuItem>Close</ContextMenuItem>
          </ContextMenuPopup>
        </ContextMenu>
      )
    );
    const tab = container.querySelector('[data-side-tab]') as HTMLDivElement | null;
    expect(tab).not.toBeNull();
    expect(tab?.className).toContain('test-extra-class');
    // Trigger 通过 render 注入的 data-slot 必须落到根 div（...rest 透传）
    expect(tab?.getAttribute('data-slot')).toBe('context-menu-trigger');
    // 外部 ref（ContextMenuTrigger 注入的那类）与内部 tabRef 都指向同一个根节点
    expect(outerRef).toBe(tab);
    expect(innerRef).toBe(tab);
    await act(async () => {
      tab?.dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(onContextMenu).toHaveBeenCalled();
    // base-ui 的 Popup 在 linkedom 下不真正挂载，但 Trigger 翻入 open 态
    // （data-popup-open）即证明右键事件穿过 shell 真正打开了菜单
    expect(tab?.hasAttribute('data-popup-open')).toBe(true);
  });

  it('pinned：overlay 内并排 Unpin（aria-pressed=true）与 ×，全 DOM 只有一个 Unpin 按钮', async () => {
    const onToggle = vi.fn();
    await act(async () => root.render(tabUnderTest(true, onToggle)));
    const unpin = buttons('Unpin default tab');
    expect(unpin).toHaveLength(1);
    expect(unpin[0]?.getAttribute('aria-pressed')).toBe('true');
    const close = buttons('close');
    expect(close).toHaveLength(1);
    // 两个按钮同在 absolute 贴右缘的 overlay 里并排
    const overlay = unpin[0]?.parentElement;
    expect(overlay?.className).toContain('absolute inset-y-0 right-0');
    expect(close[0]?.parentElement).toBe(overlay);
    // 静态指示器非交互、hover 淡出，不与 overlay 的 Unpin 成重影
    const indicator = container.querySelector('[data-pinned-indicator]');
    expect(indicator).not.toBeNull();
    expect(indicator?.tagName.toLowerCase()).not.toBe('button');
    expect(indicator?.getAttribute('aria-hidden')).toBe('true');
    expect(indicator?.className).toContain('group-hover/tab:opacity-0');
    unpin[0]?.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('unpinned：无静态指示器，overlay 内并排 Pin（aria-pressed=false）与 ×', async () => {
    await act(async () => root.render(tabUnderTest(false)));
    expect(container.querySelector('[data-pinned-indicator]')).toBeNull();
    const pin = buttons('Pin as default tab');
    expect(pin).toHaveLength(1);
    expect(pin[0]?.getAttribute('aria-pressed')).toBe('false');
    const close = buttons('close');
    expect(close).toHaveLength(1);
    expect(close[0]?.parentElement).toBe(pin[0]?.parentElement);
  });
});

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

/**
 * 触屏（手机/iPad PWA）没有 hover：Tailwind 的 group-hover 包在 @media (hover: hover) 里永不命中，
 * overlay 里的 × 一直 pointer-events:none；globals.css 窄屏触屏规则还会把它强制显形（看得见点不着）。
 * 触屏契约放在 sidepanel-dock.css 的 @media (pointer: coarse)：激活 tab 常显可点的 ×、只为它留右侧空间，
 * 其余 overlay 不显示。桌面（精确指针）的零占位契约不受影响。
 */
describe('触屏：激活 tab 的 × 一次点击可关', () => {
  type Rule = { selector: string; body: string; media: string[] };
  const rules = (): Rule[] => {
    const css = readFileSync(resolve(__dirname, 'sidepanel-dock.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    );
    const out: Rule[] = [];
    const stack: string[] = [];
    let buf = '';
    for (const ch of css) {
      if (ch === '{') {
        stack.push(buf.trim());
        buf = '';
      } else if (ch === '}') {
        const head = stack.pop() ?? '';
        if (!head.startsWith('@')) {
          for (const selector of head.split(',').map((s) => s.trim())) {
            out.push({ selector, body: buf, media: stack.filter((s) => s.startsWith('@media')) });
          }
        }
        buf = '';
      } else {
        buf += ch;
      }
    }
    return out;
  };
  const coarse = (r: Rule) => r.media.some((m) => m.includes('pointer: coarse'));
  /** 类、属性、伪类个数：须高过 globals.css 的 `.opacity-0[class*="group-hover"]`（2 个） */
  const weight = (selector: string) => (selector.match(/\.[\w-]|\[|:(?!:)/g) ?? []).length;

  it('shell 标记 overlay，× 是 overlay 的最后一个子节点（CSS 契约依赖此结构）', () => {
    const { document } = parseHTML(`<div>${shell(true)}</div>`);
    const overlay = document.querySelector('[data-side-tab-overlay]');
    expect(overlay).not.toBeNull();
    expect(overlay?.lastElementChild?.getAttribute('aria-label')).toBe('close');
  });

  it('触屏下激活 tab 的 × 常显且接收点击，权重盖过窄屏触屏的强制显形规则', () => {
    const close = rules().filter(
      (r) =>
        coarse(r) &&
        r.selector.includes('[data-side-tab][data-active]') &&
        r.selector.includes('[data-side-tab-overlay] > :last-child')
    );
    expect(close.some((r) => /pointer-events:\s*auto/.test(r.body))).toBe(true);
    expect(close.some((r) => /opacity:\s*1/.test(r.body))).toBe(true);
    for (const r of close) expect(weight(r.selector)).toBeGreaterThan(2);
  });

  it('触屏下非激活 tab 与 pin/unpin 浮出按钮不显示，避免看得见点不着', () => {
    const all = rules().filter(coarse);
    const hiddenOverlay = all.find(
      (r) =>
        /\[data-side-tab\]\s+\[data-side-tab-overlay\]$/.test(r.selector) &&
        /display:\s*none/.test(r.body)
    );
    expect(hiddenOverlay).toBeDefined();
    expect(weight(hiddenOverlay?.selector ?? '')).toBeGreaterThan(2);
    const others = all.find(
      (r) =>
        r.selector.includes('[data-side-tab-overlay] > :not(:last-child)') &&
        /display:\s*none/.test(r.body)
    );
    expect(others).toBeDefined();
  });

  it('只在触屏为激活 tab 留右侧空间；精确指针下任何 tab 都不留', () => {
    const padded = rules().filter(
      (r) => /\[data-side-tab\]/.test(r.selector) && /padding-(right|inline-end)/.test(r.body)
    );
    expect(padded.length).toBeGreaterThan(0);
    for (const r of padded) {
      expect(coarse(r)).toBe(true);
      expect(r.selector).toContain('[data-active]');
      expect(r.selector).not.toContain('[data-pinned]');
    }
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

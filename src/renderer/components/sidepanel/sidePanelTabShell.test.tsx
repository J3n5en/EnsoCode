/** pinned tab 的 ×/pin 不得占布局宽度：非 hover 时 tab 宽度 = 图标+标题+pin 的固有宽度。
 *  × 只在 hover 浮出，overlay 盖着 pin 位置，不留任何预留 padding。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SidePanelTabShell } from './sidePanelTabShell';

const shell = (pinned: boolean) =>
  renderToStaticMarkup(
    <SidePanelTabShell
      panelId="changes"
      active={false}
      pinned={pinned}
      icon={<i data-test-icon />}
      title={<span className="min-w-0 max-w-32 truncate">enso-code</span>}
      pinButton={
        pinned ? (
          <button type="button" aria-label="Unpin default tab" className="shrink-0" />
        ) : undefined
      }
      pinHoverButton={
        pinned ? undefined : (
          <button type="button" aria-label="Pin as default tab" className="relative" />
        )
      }
      closeButton={<button type="button" aria-label="close" className="relative" />}
    />
  );

describe('pinned tab 零占位布局', () => {
  it('tab 根没有为 hover 按钮预留的 padding/padding-right', () => {
    for (const html of [shell(false), shell(true)]) {
      const rootTag = html.slice(0, html.indexOf('>') + 1);
      expect(rootTag).not.toMatch(/pr-\d|pr-\[|padding-right|padding-inline-end/);
    }
  });

  it('pinned 的 pin 是 flex 流内的普通子节点：在 overlay 之前、无 absolute', () => {
    const html = shell(true);
    const pinIndex = html.indexOf('Unpin default tab');
    expect(pinIndex).toBeGreaterThan(-1);
    // overlay 容器在 pin 之后出现（pin 不在 overlay 里）
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

  it('渐变蒙版始终渲染（pinned 时 × 盖住 pin 位置也需要可读背景）', () => {
    expect(shell(true)).toContain('bg-linear-to-l');
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

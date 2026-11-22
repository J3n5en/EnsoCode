import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ShowEverywhereItem, SideTabTitle } from './sideTabScope';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => (key === 'Show in all sessions' ? '在所有会话中显示' : key),
  }),
}));
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenuItem: ({
    children,
    onClick: _onClick,
    ...props
  }: {
    children?: ReactNode;
    onClick?: () => void;
  }) => <div {...props}>{children}</div>,
}));

const item = (checked: boolean) =>
  renderToStaticMarkup(<ShowEverywhereItem checked={checked} onClick={() => undefined} />);

const tab = (global: boolean) =>
  renderToStaticMarkup(<SideTabTitle title="插件面板" global={global} />);

describe('标签右键「在所有会话中显示」', () => {
  it('未勾选时文字是条目第一个子元素，不预留勾位', () => {
    const html = item(false);
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain('<svg');
    expect(html).toMatch(/^<div[^>]*><span[^>]*>在所有会话中显示<\/span><\/div>$/);
  });

  it('勾选后勾出现在文字右侧', () => {
    const html = item(true);
    expect(html).toContain('aria-checked="true"');
    expect(html.indexOf('在所有会话中显示')).toBeLessThan(html.indexOf('<svg'));
  });
});

describe('全局常驻标签标记', () => {
  it('勾选后标签出现图标与悬停提示，且不收缩', () => {
    const html = tab(true);
    expect(html).toContain('data-enso="side-tab-global"');
    expect(html).toContain('title="在所有会话中显示"');
    expect(html).toMatch(/data-enso="side-tab-global"[^>]*class="[^"]*shrink-0/);
    expect(html).toMatch(/class="min-w-0 max-w-32 truncate">插件面板/);
    expect(html).toContain('<svg');
  });

  it('取消勾选后图标消失', () => {
    const html = tab(false);
    expect(html).not.toContain('side-tab-global');
    expect(html).not.toContain('<svg');
    expect(html).toContain('插件面板');
  });
});

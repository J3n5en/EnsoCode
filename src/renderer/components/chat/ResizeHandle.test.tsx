import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResizeHandle } from './ResizeHandle';

const render = (props: { gap?: boolean; inactive?: boolean }) => {
  const html = renderToStaticMarkup(createElement(ResizeHandle, { onResize: () => {}, ...props }));
  const outer = html.match(/^<div[^>]*\bclass="([^"]*)"/)?.[1] ?? '';
  return { html, outer: outer.split(' ') };
};
const widthOf = (classes: string[]) => classes.filter((c) => /^w-/.test(c));

describe('ResizeHandle 常驻（面板收起时）', () => {
  it('1px 分隔线：收起与展开占位宽度一致，开合首帧聊天区不跳宽', () => {
    const widths = widthOf(render({}).outer);
    expect(widths).toHaveLength(1);
    expect(widthOf(render({ inactive: true }).outer)).toEqual(widths);
  });

  it('8px 画布缝：收起时不占位，否则收起态右边距成 16px，与底边 8px 不对称', () => {
    expect(widthOf(render({ gap: true }).outer)).toEqual(['w-[8px]']);
    expect(widthOf(render({ gap: true, inactive: true }).outer)).toEqual(['w-0']);
  });

  it('收起时不可交互、不可见', () => {
    const { html, outer } = render({ inactive: true });
    expect(outer).toContain('pointer-events-none');
    expect(outer).toContain('invisible');
    expect(html).toContain('aria-hidden="true"');
  });

  it('展开时保持原有拖拽命中区与分隔线', () => {
    const { html, outer } = render({});
    expect(outer).not.toContain('pointer-events-none');
    expect(outer).not.toContain('invisible');
    expect(outer).toContain('bg-border');
    expect(html).toContain('cursor-col-resize');
  });
});

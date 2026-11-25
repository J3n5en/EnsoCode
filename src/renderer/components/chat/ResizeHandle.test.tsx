import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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

describe('ResizeHandle 双击复位与拖拽通知', () => {
  const setup = async (props: {
    onReset?: () => void;
    onResizingChange?: (r: boolean) => void;
  }) => {
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = window.document.getElementById('root') as unknown as HTMLElement;
    const root = createRoot(container);
    await act(async () =>
      root.render(createElement(ResizeHandle, { onResize: () => {}, ...props }))
    );
    const hitArea = container.querySelector('.cursor-col-resize') as HTMLElement;
    return { root, container, hitArea, window };
  };

  it('双击手柄触发 onReset（默认宽度复位）', async () => {
    const onReset = vi.fn();
    const { root, hitArea, window } = await setup({ onReset });
    await act(async () => {
      hitArea.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
    });
    expect(onReset).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('拖拽开始/结束通知 onResizingChange，消费方可暂停宽度动画', async () => {
    const events: boolean[] = [];
    const { root, hitArea, window } = await setup({
      onResizingChange: (r) => events.push(r),
    });
    await act(async () => {
      {
        const down = new window.Event('mousedown', { bubbles: true });
        Object.assign(down, { clientX: 100 });
        hitArea.dispatchEvent(down);
      }
    });
    expect(events).toEqual([true]);
    await act(async () => {
      window.document.dispatchEvent(new window.Event('mouseup', { bubbles: true }));
    });
    expect(events).toEqual([true, false]);
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('未传 onReset 时双击不报错', async () => {
    const { root, hitArea, window } = await setup({});
    await act(async () => {
      hitArea.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
    });
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
});

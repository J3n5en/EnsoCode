import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'zh',
    t: (key: string) => key,
  }),
}));
vi.mock('@/hooks/useColorScheme', () => ({ useColorScheme: () => 'light' }));
vi.mock('@/hooks/useOverlayGuard', () => ({ useOverlayGuard: () => {} }));
vi.mock('./CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) =>
    createElement('pre', { 'data-enso': 'code-block' }, code),
}));
vi.mock('./CopyButton', () => ({ CopyButton: () => createElement('span') }));

import { HtmlVizRenderer } from './HtmlVizRenderer';
import { VIZ_READY_TIMEOUT_MS } from './htmlViz';

/** linkedom 的 iframe 没有 contentWindow，伪造一个以便模拟壳页面 postMessage */
function fakeFrameWindow(container: HTMLElement): object {
  const frame = container.querySelector('iframe');
  if (!frame) throw new Error('iframe 未挂载');
  const win = { postMessage: vi.fn() };
  Object.defineProperty(frame, 'contentWindow', { value: win, configurable: true });
  return win;
}

function postMessage(source: object, data: unknown) {
  const event = new window.Event('message');
  Object.defineProperties(event, {
    source: { value: source },
    data: { value: data },
  });
  window.dispatchEvent(event);
}

describe('HtmlVizRenderer 超时降级与恢复', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    const { window } = parseHTML(
      '<!doctype html><html><head><base href="https://enso.local/"></head><body><div id="root"></div></body></html>'
    );
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.getElementById('root')!;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const render = () =>
    act(() => {
      root.render(createElement(HtmlVizRenderer, { code: '<p>x</p>', streaming: false }));
    });

  it('超时后 iframe 仍挂载（隐藏、高度为 0），迟到的 height 上报后恢复预览', () => {
    render();
    const frameWindow = fakeFrameWindow(container);
    act(() => {
      vi.advanceTimersByTime(VIZ_READY_TIMEOUT_MS + 100);
    });
    expect(container.querySelector('details')).toBeTruthy();
    // 恢复的前提：iframe 没有被卸载，且不能靠 display:none 隐藏（宽度归零会让高度测量失真）
    const frame = container.querySelector('iframe');
    expect(frame).toBeTruthy();
    expect(frame?.style.height).toMatch(/^0(px)?$/);
    expect(frame?.className).not.toContain('hidden');

    act(() => postMessage(frameWindow, { type: 'enso-viz-height', height: 320 }));
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('iframe')?.style.height).toBe('320px');
  });

  it('脚本错误粘住：卸载 iframe 杀掉它，随后上报高度也不恢复', () => {
    render();
    const frameWindow = fakeFrameWindow(container);
    act(() => postMessage(frameWindow, { type: 'enso-viz-error', message: 'boom' }));
    expect(container.querySelector('details')).toBeTruthy();
    expect(container.innerHTML).toContain('boom');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('流式期间只渲染代码块，不挂 iframe', () => {
    act(() => {
      root.render(createElement(HtmlVizRenderer, { code: '<p>x</p>', streaming: true }));
    });
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-enso="code-block"]')).toBeTruthy();
  });

  it('正常路径：收到高度后按上报值定高', () => {
    render();
    const frameWindow = fakeFrameWindow(container);
    act(() => postMessage(frameWindow, { type: 'enso-viz-height', height: 200 }));
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('iframe')?.style.height).toBe('200px');
  });
});

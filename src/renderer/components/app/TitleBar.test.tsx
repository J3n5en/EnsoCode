import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TitleBar } from './TitleBar';

// SSR 渲染只需要 env.platform；useWindowMaximized 的 effect 不在服务端跑
vi.stubGlobal('window', {
  electronAPI: { env: { platform: 'darwin' } },
});
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
let mobile = false;
vi.mock('@/hooks/useViewport', () => ({ useIsMobile: () => mobile }));

const setPlatform = (platform: 'darwin' | 'win32' | 'linux') => {
  window.electronAPI.env.platform = platform;
};
const render = (props: Parameters<typeof TitleBar>[0]) =>
  renderToStaticMarkup(createElement(TitleBar, props));
const centered = createElement('div', { 'data-testid': 'mode-switch' });

describe('TitleBar centered content', () => {
  it('centers over the entire window while reserving native controls only for actions', () => {
    setPlatform('win32');
    const html = render({ centered });
    expect(html).toContain('padding-right:');
    expect(html).not.toContain('style="right:');
  });
  it('renders centered content as an overlay sibling of title and actions', () => {
    setPlatform('win32');
    const html = render({
      title: 'EnsoCode',
      centered,
      actions: createElement('button', { type: 'button' }, 'act'),
    });
    // 居中覆盖层：绝对定位铺满、自身不可点，内部内容可点且不参与拖拽
    expect(html).toContain('absolute inset-0 flex items-center justify-center');
    expect(html).toContain('pointer-events-auto');
    expect(html).toContain('data-testid="mode-switch"');
    // 标题不被居中内容替换，仍在左侧
    expect(html).toContain('EnsoCode');
    expect(html).toContain('act');
  });

  it('keeps the window drag region under the overlay', () => {
    setPlatform('win32');
    const html = render({ title: 'EnsoCode', centered });
    // 覆盖层 pointer-events:none，空处仍可拖动窗口
    expect(html).toContain('pointer-events-none absolute inset-0');
    expect(html).toContain('no-drag');
  });

  it('macOS: hides the title beside traffic lights when centered', () => {
    setPlatform('darwin');
    const html = render({ title: 'EnsoCode', centered });
    expect(html).toContain('data-testid="mode-switch"');
    expect(html).not.toContain('EnsoCode');
    // 红绿灯预留仍在
    expect(html).toContain('pl-[84px]');
  });

  it('leading still replaces the title and stays left (no centering)', () => {
    setPlatform('win32');
    const html = render({
      title: 'EnsoCode',
      leading: createElement('span', { 'data-testid': 'lead' }),
    });
    expect(html).toContain('data-testid="lead"');
    expect(html).not.toContain('absolute inset-0');
    expect(html).not.toContain('EnsoCode');
  });

  it('preserves titles and platform-specific caption controls', () => {
    setPlatform('darwin');
    const html = render({ title: 'Settings' });
    expect(html).toContain('Settings');
    expect(html).not.toContain('absolute inset-0');
    // macOS 不渲染自绘窗口控制
    expect(html).not.toContain('aria-label="Close"');
    setPlatform('win32');
    const win = render({ title: 'Settings' });
    expect(win).not.toContain('aria-label="Close"');
    expect(win).not.toContain('aria-label="Maximize"');
    expect(win).toContain('data-native-window-controls="true"');
    setPlatform('linux');
    expect(render({ title: 'Settings' })).toContain('aria-label="Close"');
  });
});

describe('TitleBar on narrow viewports (remote browser)', () => {
  it('drops traffic-light inset, native caption inset and custom caption buttons', () => {
    mobile = true;
    try {
      setPlatform('darwin');
      const mac = render({ title: 'EnsoCode', centered });
      expect(mac).not.toContain('pl-[84px]');
      expect(mac).toContain('EnsoCode');
      setPlatform('win32');
      const win = render({ title: 'EnsoCode', centered });
      expect(win).not.toContain('data-native-window-controls');
      expect(win).not.toContain('padding-right');
      setPlatform('linux');
      expect(render({ title: 'EnsoCode' })).not.toContain('aria-label="Close"');
    } finally {
      mobile = false;
    }
  });
});

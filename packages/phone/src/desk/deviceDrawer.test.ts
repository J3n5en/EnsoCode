// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom 没有 matchMedia；抽屉的主题回退只用到 matches=false 这一面
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as MediaQueryList;
}
Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });

import type { RemoteLinkStatus } from '@shared/remoteBridge';
import type { StoredDevice } from '../deviceList';
import { createDeviceDrawer, type DeviceDrawerHost, resolveDrawerLayout } from './deviceDrawer';

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('dd-style')?.remove();
});

const device = (pairId: string): StoredDevice =>
  ({
    pairId,
    label: pairId,
    token: 't',
    relayUrl: 'https://relay',
    contentKey: 'k',
  }) as StoredDevice;

const onlineLink: RemoteLinkStatus = {
  state: 'online',
  deviceLabel: '办公机',
  transport: 'direct',
  rttMs: 42,
  pushEnabled: false,
  pushBusy: false,
  pushError: null,
  pushAvailability: 'ok',
  pushReady: true,
} as RemoteLinkStatus;

function setup({
  wide = false,
  list = [device('a'), device('b')],
  pip,
}: {
  wide?: boolean;
  list?: StoredDevice[];
  pip?: DeviceDrawerHost['pip'];
} = {}) {
  const host: DeviceDrawerHost = {
    doc: document,
    currentId: 'a',
    devices: {
      list: () => list,
      switchTo: vi.fn(),
      rename: vi.fn(),
      unpair: vi.fn(async () => {}),
      pairNew: vi.fn(),
      exitDesk: vi.fn(),
    },
    link: () => onlineLink,
    onLink: () => () => {},
    togglePush: vi.fn(),
    theme: () => null,
    watchTheme: () => () => {},
    diagnostics: () => 'diag',
    wide: () => wide,
    pip,
  };
  return { host, drawer: createDeviceDrawer(host) };
}

describe('resolveDrawerLayout', () => {
  it('窄屏或触屏宽屏都是手机抽屉，其余是桌面对话框', () => {
    expect(resolveDrawerLayout(390, true)).toBe('phone');
    expect(resolveDrawerLayout(390, false)).toBe('phone');
    expect(resolveDrawerLayout(900, true)).toBe('phone');
    expect(resolveDrawerLayout(1440, false)).toBe('desktop');
  });
});

describe('createDeviceDrawer 布局', () => {
  it('宽屏桌面：居中对话框，没有拖动把手', () => {
    const { drawer } = setup({ wide: true });
    drawer.open();
    const root = document.querySelector('.dd-root');
    const sheet = document.querySelector('.dd-sheet');
    expect(root?.classList.contains('dd-desktop')).toBe(true);
    expect(sheet?.querySelector('.dd-grab')).toBeNull();
    drawer.close();
  });

  it('窄屏手机：底部抽屉，保留拖动把手', () => {
    const { drawer } = setup({ wide: false });
    drawer.open();
    const root = document.querySelector('.dd-root');
    const sheet = document.querySelector('.dd-sheet');
    expect(root?.classList.contains('dd-desktop')).toBe(false);
    expect(sheet?.querySelector('.dd-grab')).not.toBeNull();
    drawer.close();
  });

  it('推送说明按设备区分：宽屏是这台设备，窄屏是这台手机', () => {
    const desk = setup({ wide: true });
    desk.drawer.open();
    expect(document.body.textContent).toContain('这台设备');
    expect(document.body.textContent).not.toContain('这台手机');
    desk.drawer.close();

    const phone = setup({ wide: false });
    phone.drawer.open();
    expect(document.body.textContent).toContain('这台手机');
    phone.drawer.close();
  });
});

describe('createDeviceDrawer 画中画', () => {
  const openRoot = () => document.querySelector('.dd-root.dd-open') ?? document;
  const buttonByText = (text: string) =>
    [...openRoot().querySelectorAll('button')].find((b) => b.textContent?.includes(text));

  it('宿主没有画中画能力时不渲染相关控件', () => {
    const { drawer } = setup();
    drawer.open();
    expect(document.body.textContent).not.toContain('画中画');
    drawer.close();
  });

  it('开启浮窗后收起面板；自动开关反映状态并回调取反值；状态变化即时重绘', () => {
    let state = {
      active: false,
      auto: false,
      aspect: 'portrait' as 'portrait' | 'square' | 'landscape',
      follow: 'opened' as 'opened' | 'latest',
      supported: true,
    };
    const listeners = new Set<() => void>();
    const toggle = vi.fn(() => {
      state = { ...state, active: !state.active };
      for (const l of listeners) l();
    });
    const setAuto = vi.fn();
    const setAspect = vi.fn();
    const setFollow = vi.fn();
    const pip = {
      state: () => state,
      onChange: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      toggle,
      setAuto,
      setAspect,
      setFollow,
    };
    const { drawer } = setup({ pip });
    drawer.open();
    const sw = openRoot().querySelector<HTMLButtonElement>('[aria-label="切后台自动画中画"]');
    expect(sw?.getAttribute('role')).toBe('switch');
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    expect(document.body.textContent).toContain('浮窗支持双指放大');
    sw?.click();
    expect(setAuto).toHaveBeenCalledWith(true);
    buttonByText('方形')?.click();
    expect(setAspect).toHaveBeenCalledWith('square');
    buttonByText('最新活跃')?.click();
    expect(setFollow).toHaveBeenCalledWith('latest');

    state = { ...state, auto: true };
    for (const l of listeners) l();
    expect(
      openRoot().querySelector('[aria-label="切后台自动画中画"]')?.getAttribute('aria-checked')
    ).toBe('true');

    buttonByText('开启画中画浮窗')?.click();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(drawer.isOpen()).toBe(false);
    expect(listeners.size).toBe(0);

    drawer.open();
    buttonByText('关闭画中画浮窗')?.click();
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(drawer.isOpen()).toBe(true);
    expect(buttonByText('开启画中画浮窗')).toBeDefined();
    drawer.close();
  });

  it('原生不支持画中画时控件禁用', () => {
    const { drawer } = setup({
      pip: {
        state: () => ({ active: false, auto: false, supported: false }),
        onChange: () => () => {},
        toggle: vi.fn(),
        setAuto: vi.fn(),
      },
    });
    drawer.open();
    expect(buttonByText('开启画中画浮窗')?.disabled).toBe(true);
    expect(
      openRoot().querySelector<HTMLButtonElement>('[aria-label="切后台自动画中画"]')?.disabled
    ).toBe(true);
    drawer.close();
  });
});

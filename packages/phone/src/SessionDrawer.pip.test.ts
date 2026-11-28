import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDrawer } from './SessionDrawer';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params
        ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? ''))
        : key,
    locale: 'zh',
  }),
}));
vi.mock('./theme', () => ({
  getThemePreference: () => 'auto',
  setThemePreference: () => {},
  subscribeTheme: () => () => {},
}));

const storage = vi.hoisted(() => {
  vi.stubGlobal('__COMMIT__', 'test');
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
  return data;
});

const baseProps = {
  open: true,
  projects: [],
  catalog: [],
  activeId: null,
  canCreate: false,
  devices: [],
  activeDevicePairId: null,
  connected: true,
  connectionLabel: '',
  pushEnabled: false,
  pushBusy: false,
  pushError: null,
  pushAvailability: 'ok' as const,
  pushConfigReady: true,
  onTogglePush: () => {},
  onClose: () => {},
  onSelect: () => {},
  onNewConversation: () => {},
  onSwitchDevice: () => {},
  onAddDevice: () => {},
  onRenameDevice: () => {},
  onUnpairDevice: () => {},
};

const pip = (active: boolean) => ({
  active,
  auto: true,
  aspect: 'portrait' as const,
  follow: 'opened' as const,
  supported: true,
  onToggle: () => {},
  onAutoChange: () => {},
  onAspectChange: () => {},
  onFollowChange: () => {},
});

describe('SessionDrawer 画中画', () => {
  beforeEach(() => storage.clear());

  it('不传 pip 时没有画中画控件', () => {
    const html = renderToStaticMarkup(createElement(SessionDrawer, baseProps));
    expect(html).toContain('推送通知');
    expect(html).not.toContain('画中画');
  });

  it('传入 pip 时在推送通知下方给出开关浮窗与自动画中画', () => {
    const html = renderToStaticMarkup(
      createElement(SessionDrawer, { ...baseProps, pip: pip(false) })
    );
    expect(html.indexOf('推送通知')).toBeLessThan(html.indexOf('开启画中画浮窗'));
    expect(html).toContain('切后台自动画中画');
    expect(html).toContain('浮窗比例');
    expect(html).toContain('竖屏大窗');
    expect(html).toContain('跟随会话');
    expect(html).toContain('当前打开');
    expect(html).toContain('最新活跃');
    expect(html).toContain('浮窗支持双指放大');
    expect(html).toMatch(
      /role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/
    );

    const active = renderToStaticMarkup(
      createElement(SessionDrawer, { ...baseProps, pip: pip(true) })
    );
    expect(active).toContain('关闭画中画浮窗');
  });
});

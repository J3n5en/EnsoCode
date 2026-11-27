import { translate } from '@shared/i18n';
import type { UpdateCheckResult } from '@shared/types/updater';
import { MotionGlobalConfig } from 'framer-motion';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeneralSettings } from './GeneralSettings';

const harness = vi.hoisted(() => ({
  check: vi.fn<() => Promise<UpdateCheckResult | undefined>>(),
  toast: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate('zh', key, params),
    tNode: (key: string) => translate('zh', key),
    locale: 'zh',
  }),
}));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.toast }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({
      language: 'zh',
      setLanguage: vi.fn(),
      autoUpdate: true,
      setAutoUpdate: vi.fn(),
      autoRestartForUpdate: 'off',
      setAutoRestartForUpdate: vi.fn(),
      updateChannel: 'stable',
      setUpdateChannel: vi.fn(),
      notifyMainAgentOnly: false,
      setNotifyMainAgentOnly: vi.fn(),
      proxyMode: 'system',
      customProxyUrl: '',
      setProxyMode: vi.fn(),
      setCustomProxyUrl: vi.fn(),
      customCaCertPath: '',
      setCustomCaCertPath: vi.fn(),
    }),
}));
vi.mock('@/components/ui/spinner', () => ({
  Spinner: () => <span role="status" aria-label="Loading" />,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked, ...props }: { checked?: boolean }) => (
    <button type="button" role="switch" aria-checked={checked === true} {...props} />
  ),
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./ConfigSyncSettings', () => ({ ConfigSyncSettings: () => null }));
vi.mock('./FileOpeningSettings', () => ({ FileOpeningSettings: () => null }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select?: (state: Record<string, unknown>) => unknown) =>
    select ? select({}) : {},
}));

let root: Root;
let container: HTMLElement;

const checkButton = () =>
  [...container.querySelectorAll('button')].find((button) =>
    /检查更新|检查中/.test(button.textContent ?? '')
  );

beforeEach(async () => {
  MotionGlobalConfig.skipAnimations = true;
  vi.clearAllMocks();
  harness.check.mockResolvedValue({ ok: true, status: 'up-to-date' });
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('navigator', { language: 'zh-CN', userAgent: 'node' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    electronAPI: {
      env: { platform: 'win32' },
      updater: {
        getState: async () => ({ host: 'desktop', status: null }),
        onStatus: () => () => {},
        checkForUpdates: harness.check,
        downloadUpdate: vi.fn(),
        setAutoUpdateEnabled: vi.fn(),
        setAutoRestartMode: vi.fn(),
        setChannel: vi.fn(),
        restart: vi.fn(),
      },
      caCert: { status: async () => null, apply: vi.fn() },
      proxy: { apply: vi.fn() },
      dialog: { selectFile: vi.fn() },
    },
  });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => root.render(<GeneralSettings />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('检查更新按钮有进行中状态和结果提示', () => {
  it('点击后变成检查中并禁用，带上 Spinner', async () => {
    let release!: (result: UpdateCheckResult) => void;
    harness.check.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const button = checkButton();
    expect(button?.textContent).toContain('检查更新');
    expect(button?.hasAttribute('disabled')).toBe(false);

    await act(async () => button?.click());
    const pending = checkButton();
    expect(pending?.textContent).toContain('检查中…');
    expect(pending?.hasAttribute('disabled')).toBe(true);
    expect(pending?.querySelector('[role="status"]')).not.toBeNull();
    expect(harness.toast).not.toHaveBeenCalled();

    await act(async () => release({ ok: true, status: 'up-to-date' }));
    expect(checkButton()?.textContent).toContain('检查更新');
    expect(checkButton()?.hasAttribute('disabled')).toBe(false);
  });

  it.each([
    [
      { ok: true, status: 'up-to-date' },
      { type: 'success', title: '已是最新' },
    ],
    [
      { ok: true, status: 'available' },
      { type: 'info', title: '发现新版本' },
    ],
    [
      { ok: true, status: 'downloaded' },
      { type: 'success', title: '更新已下载可重启安装' },
    ],
    [
      { ok: true, status: 'unsupported' },
      { type: 'warning', title: '当前平台不支持自动更新' },
    ],
    [
      { ok: false, error: '网络连接失败' },
      { type: 'error', title: '检查失败：网络连接失败' },
    ],
  ] as const)('结果 %j 弹出对应提示', async (result, toast) => {
    harness.check.mockResolvedValue(result);
    await act(async () => checkButton()?.click());
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining(toast));
  });
});

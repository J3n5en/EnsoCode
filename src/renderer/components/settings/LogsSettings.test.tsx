import type { AppLogEntry } from '@shared/appLog';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findNestedBoxes } from './kit/boxes';
import { LogsSettings } from './LogsSettings';

const harness = vi.hoisted(() => ({
  errors: vi.fn(),
  exportLogs: vi.fn(),
  revealExport: vi.fn(async () => undefined),
  addToast: vi.fn(),
  appLoggingEnabled: true,
  setAppLoggingEnabled: vi.fn(),
  pluginLoggingEnabled: false,
  setPluginLoggingEnabled: vi.fn(),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.addToast }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({
      appLoggingEnabled: harness.appLoggingEnabled,
      setAppLoggingEnabled: harness.setAppLoggingEnabled,
      pluginLoggingEnabled: harness.pluginLoggingEnabled,
      setPluginLoggingEnabled: harness.setPluginLoggingEnabled,
    }),
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    className: _className,
    ...rest
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    className?: string;
  } & Record<string, unknown>) => (
    <button
      type="button"
      aria-pressed={checked === true}
      onClick={() => onCheckedChange?.(checked !== true)}
      {...rest}
    />
  ),
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
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectPopup: () => null,
  SelectItem: () => null,
}));

const ENTRIES: AppLogEntry[] = [
  {
    time: Date.parse('2025-01-01T00:00:02Z'),
    level: 'error',
    source: 'mcp',
    message: '[mcp] connect failed',
    detail: '[mcp] connect failed\n    at connect (mcp.ts:1)',
  },
  {
    time: Date.parse('2025-01-01T00:00:01Z'),
    level: 'error',
    source: 'agent',
    message: 'worker exited',
    detail: 'worker exited',
  },
];

let root: Root;
let container: HTMLElement;

const button = (text: string) => {
  const found = [...container.querySelectorAll('button')].find(
    (el) => el.textContent?.includes(text) || el.getAttribute('aria-label') === text
  );
  expect(found, text).not.toBeUndefined();
  return found as HTMLElement;
};

async function mount() {
  await act(async () => root.render(<LogsSettings />));
}

beforeEach(async () => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, {
    electronAPI: {
      logs: {
        errors: harness.errors,
        export: harness.exportLogs,
        revealExport: harness.revealExport,
      },
    },
  });
  vi.clearAllMocks();
  harness.appLoggingEnabled = true;
  harness.pluginLoggingEnabled = false;
  harness.errors.mockResolvedValue(ENTRIES);
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await mount();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('LogsSettings', () => {
  /** 按标签找控件：只认 label 与控件的 id 关联 */
  const toggle = (label: string) => {
    const row = [...container.querySelectorAll('label')].find((el) =>
      el.textContent?.includes(label)
    );
    expect(row, label).not.toBeUndefined();
    const control = container.querySelector(`[id="${row?.getAttribute('for')}"]`);
    expect(control?.getAttribute('aria-labelledby')).toBe(row?.id);
    return control as HTMLElement;
  };

  it('顶部有应用日志、插件日志两个独立开关，各写各的设置项', async () => {
    harness.appLoggingEnabled = false;
    await mount();
    const app = toggle('Record app logs');
    const plugin = toggle('Record plugin logs');
    expect(app.getAttribute('aria-pressed')).toBe('false');
    expect(plugin.getAttribute('aria-pressed')).toBe('false');
    await act(async () => app.click());
    expect(harness.setAppLoggingEnabled).toHaveBeenCalledWith(true);
    expect(harness.setPluginLoggingEnabled).not.toHaveBeenCalled();
    await act(async () => plugin.click());
    expect(harness.setPluginLoggingEnabled).toHaveBeenCalledWith(true);
  });

  it('应用日志关闭时最近错误显示未开启与开启入口，历史日志仍可查看', async () => {
    harness.appLoggingEnabled = false;
    await mount();
    expect(container.textContent).toContain('App logging is off');
    expect(container.textContent).toContain('[mcp] connect failed');
    expect(container.textContent).toContain(
      'App logging is off. The export only includes logs recorded earlier.'
    );
    await act(async () => button('Enable app logging').click());
    expect(harness.setAppLoggingEnabled).toHaveBeenCalledWith(true);
  });

  it('应用日志打开时不显示未开启提示', () => {
    expect(container.textContent).not.toContain('App logging is off');
  });

  it('默认只拉 error，列表显示来源，点开看到堆栈', async () => {
    expect(harness.errors).toHaveBeenCalledWith('error');
    expect(container.textContent).toContain('MCP');
    expect(container.textContent).toContain('Agent worker');
    expect(container.textContent).not.toContain('at connect');
    await act(async () => button('[mcp] connect failed').click());
    expect(container.textContent).toContain('at connect (mcp.ts:1)');
  });

  it('切到 warn 筛选并可刷新', async () => {
    await act(async () => button('Warnings and errors').click());
    expect(harness.errors).toHaveBeenLastCalledWith('warn');
    harness.errors.mockResolvedValue([]);
    await act(async () => button('Refresh').click());
    expect(harness.errors).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('No errors recorded.');
  });

  it('导出默认 24 小时，成功后提示并可打开所在文件夹；取消不提示', async () => {
    harness.exportLogs.mockResolvedValue({ ok: true, path: '/tmp/x.zip', files: 3 });
    await act(async () => button('Export').click());
    expect(harness.exportLogs).toHaveBeenCalledWith(24);
    const toast = harness.addToast.mock.calls[0]?.[0];
    expect(toast).toMatchObject({ type: 'success', description: '/tmp/x.zip' });
    toast.actions[0].onClick();
    expect(harness.revealExport).toHaveBeenCalled();

    harness.addToast.mockClear();
    harness.exportLogs.mockResolvedValue({ ok: true, cancelled: true });
    await act(async () => button('Export').click());
    expect(harness.addToast).not.toHaveBeenCalled();
  });

  it('页面里没有卡片套卡片（含展开的堆栈与日志关闭提示）', async () => {
    harness.appLoggingEnabled = false;
    await mount();
    await act(async () => button('[mcp] connect failed').click());
    expect(findNestedBoxes(container)).toEqual([]);
    harness.errors.mockResolvedValue([]);
    await act(async () => button('Refresh').click());
    expect(findNestedBoxes(container)).toEqual([]);
  });
});

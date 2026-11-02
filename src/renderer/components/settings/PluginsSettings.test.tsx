import { parseHTML } from 'linkedom';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnsoPluginsSettings as PluginsSettings } from './PluginsSettings';

const harness = vi.hoisted(() => ({
  logs: vi.fn(),
  artifacts: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({
      plugins: [],
      addPlugins: vi.fn(),
      setPluginEnabled: vi.fn(),
      removePlugin: vi.fn(),
    }),
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
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/components/ui/input', () => ({
  Input: (props: ComponentProps<'input'>) => <input {...props} />,
}));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => <span>loading</span> }));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
  }) => (
    <button
      type="button"
      aria-pressed={checked === true}
      onClick={() => onCheckedChange?.(checked !== true)}
      {...props}
    />
  ),
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectPopup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));
// 弹窗层：只有 open 时才渲染内容，这样"开弹窗"与"插进页面"能被测试区分开
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div data-dialog="open">{children}</div> : null,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  DialogPanel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/plugins/artifactViews', () => ({ PluginArtifactList: () => <div>artifacts</div> }));
vi.mock('@/plugins/pluginMeta', () => ({
  pluginPermissionLabel: (permission: string) => `label:${permission}`,
}));
vi.mock('@/plugins/configValue', () => ({ coerceConfigValue: () => '' }));
vi.mock('./NewSessionBadge', () => ({ NewSessionBadge: () => null }));
vi.mock('./RegistryNoticeBanner', () => ({ RegistryNoticeBanner: () => null }));

const plugin = {
  id: 'local.missionops',
  name: 'Mission Ops',
  version: '0.1.0',
  state: 'enabled' as const,
  permissions: ['agent.tool', 'agent.observe'],
  events: [
    { event: 'tool_call', mode: 'intercept' },
    { event: 'tool_result', mode: 'observe' },
  ],
  schedules: [{ id: 'observer', intervalSeconds: 60 }],
  resident: true,
  running: true,
  configurable: true,
  crossSessionInject: false,
};

let root: Root;
let container: HTMLElement;

const render = async () => {
  await act(async () => root.render(<PluginsSettings />));
};

const byLabel = (label: string) => {
  const found = [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === label
  );
  expect(found).not.toBeUndefined();
  return found as HTMLElement;
};

const byText = (text: string) => {
  const found = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.startsWith(text)
  );
  expect(found).not.toBeUndefined();
  return found as HTMLElement;
};

beforeEach(async () => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, {
    electronAPI: {
      extensionPlugins: {
        list: harness.list,
        registryNotice: async () => null,
        onChanged: () => () => {},
        logs: harness.logs,
        artifactsList: harness.artifacts,
        configGet: async () => ({ ok: true, fields: [] }),
      },
      assets: { listInstalledPlugins: async () => [] },
    },
  });
  harness.list.mockResolvedValue([plugin]);
  harness.logs.mockResolvedValue({ ok: true, text: 'plugin log line' });
  harness.artifacts.mockResolvedValue({ ok: true, artifacts: [] });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  vi.clearAllMocks();
  harness.list.mockResolvedValue([plugin]);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('ExtensionPluginsSection', () => {
  it('能力详情默认折叠，点开后显示权限与事件', async () => {
    expect(container.textContent).toContain('Mission Ops');
    expect(container.textContent).not.toContain('agent.tool');
    expect(container.textContent).toContain('2 项权限');

    await act(async () => byText('详情').click());
    expect(container.textContent).toContain('agent.tool');
    expect(container.textContent).toContain('事件 tool_call · 拦截');
    expect(container.textContent).toContain('允许向任意运行中的会话发送消息');

    await act(async () => byText('收起详情').click());
    expect(container.textContent).not.toContain('agent.tool');
  });

  it('日志、配置、产出都开在弹窗层，不插进页面', async () => {
    expect(container.querySelector('[data-dialog="open"]')).toBeNull();

    await act(async () => byLabel('Plugin logs').click());
    expect(harness.logs).toHaveBeenCalledWith('local.missionops');
    expect(container.querySelector('[data-dialog="open"]')).not.toBeNull();
    expect(container.textContent).toContain('plugin log line');

    await act(async () => byLabel('Configure').click());
    expect(container.textContent).toContain('Save');

    await act(async () => byLabel('产出文件').click());
    expect(harness.artifacts).toHaveBeenCalledWith('local.missionops');
  });
});

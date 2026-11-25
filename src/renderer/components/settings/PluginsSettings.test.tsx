import { pluginInstallSettingsLink } from '@shared/extensionPlugins/pluginProtocol';
import { MotionGlobalConfig } from 'framer-motion';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnsoPluginsSettings as PluginsSettings } from './PluginsSettings';

const harness = vi.hoisted(() => ({
  logs: vi.fn(),
  artifacts: vi.fn(),
  list: vi.fn(),
  setDevWatch: vi.fn(async () => ({ ok: true })),
  configGet: vi.fn(async () => ({ ok: true as const, fields: [] as unknown[] })),
  marketStage: vi.fn(),
  restage: vi.fn(),
  commit: vi.fn(),
  discard: vi.fn(),
  setEnabled: vi.fn(async () => ({ ok: true })),
  addToast: vi.fn(),
  pluginLoggingEnabled: true,
  setPluginLoggingEnabled: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.addToast }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({
      pluginAutoUpdate: true,
      setPluginAutoUpdate: vi.fn(),
      pluginLoggingEnabled: harness.pluginLoggingEnabled,
      setPluginLoggingEnabled: harness.setPluginLoggingEnabled,
    }),
}));
vi.mock('@/stores/appView', () => ({
  openSettings: (...args: unknown[]) => harness.openSettings(...args),
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
vi.mock('@/components/ui/textarea', () => ({
  // linkedom 读不回 textarea 的 value，挂到 data-value 上断言
  Textarea: ({ value, ...props }: ComponentProps<'textarea'>) => (
    <textarea {...props} data-value={value} />
  ),
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
// 弹窗层：只有 open 时才渲染内容，这样"开弹窗"与"插进页面"能被测试区分开；dialog-dismiss 模拟 ESC/点遮罩
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: React.ReactNode;
  }) =>
    open ? (
      <div data-dialog="open">
        <button type="button" data-dismiss="" onClick={() => onOpenChange?.(false)} />
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  DialogPanel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./PluginMarket', () => ({
  PluginMarket: ({
    disabled,
    installedKey,
    onInstall,
  }: {
    disabled: boolean;
    installedKey: string;
    onInstall: (id: string) => void;
  }) => (
    <div data-market="" data-installed={installedKey}>
      <button
        type="button"
        aria-label="market-install"
        disabled={disabled}
        onClick={() => onInstall('market.a')}
      />
    </div>
  ),
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
  themes: [],
};

let root: Root;
let container: HTMLElement;

const stagedPreview = {
  token: 'tok-1',
  id: 'market.a',
  name: 'Market A',
  version: '1.0.0',
  permissions: ['agent.tool'],
  env: [],
  interop: [],
  resident: false,
  styles: false,
  hasRenderer: false,
  events: [],
  schedules: [],
  mcpServers: [],
  mcpTools: [],
  warnings: [],
};

const render = async () => {
  await act(async () => root.render(<PluginsSettings />));
};

const byLabel = (label: string) => {
  const found = [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === label
  );
  if (found) return found as HTMLElement;
  const row = [...container.querySelectorAll('[data-slot="settings-row"]')].find((element) =>
    [...element.querySelectorAll('label')].some((node) => node.textContent === label)
  );
  const button = row?.querySelector('button');
  expect(button).not.toBeUndefined();
  return button as HTMLElement;
};

const byText = (text: string) => {
  const found = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.startsWith(text)
  );
  expect(found).not.toBeUndefined();
  return found as HTMLElement;
};

const detailsToggle = () => {
  const found = container.querySelector('button[aria-expanded]') as HTMLElement | null;
  expect(found).not.toBeNull();
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
        configGet: harness.configGet,
        setDevWatch: harness.setDevWatch,
        marketStage: harness.marketStage,
        restage: harness.restage,
        commit: harness.commit,
        discard: harness.discard,
        setEnabled: harness.setEnabled,
      },
    },
  });
  harness.list.mockResolvedValue([plugin]);
  harness.logs.mockResolvedValue({ ok: true, text: 'plugin log line' });
  harness.artifacts.mockResolvedValue({ ok: true, artifacts: [] });
  harness.configGet.mockReset();
  harness.configGet.mockResolvedValue({ ok: true, fields: [] });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  MotionGlobalConfig.skipAnimations = true;
  vi.clearAllMocks();
  harness.list.mockResolvedValue([plugin]);
  await render();
});

afterEach(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('ExtensionPluginsSection', () => {
  it('能力详情默认折叠，点开后显示权限与事件', async () => {
    expect(container.textContent).toContain('Mission Ops');
    expect(container.textContent).not.toContain('agent.tool');
    expect(container.textContent).toContain('2 项权限');

    await act(async () => detailsToggle().click());
    expect(container.textContent).toContain('agent.tool');
    expect(container.textContent).toContain('事件 tool_call · 拦截');
    expect(container.textContent).toContain('允许向任意运行中的会话发送消息');

    await act(async () => detailsToggle().click());
    expect(container.textContent).not.toContain('agent.tool');
  });

  it('只带主题 CSS 的插件不再声称无特殊权限', async () => {
    harness.list.mockResolvedValue([
      { ...plugin, permissions: [], themes: [{ id: 'lab', name: 'Lab', css: 'x.css' }] },
    ]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    await act(async () => detailsToggle().click());
    expect(container.textContent).toContain('修改界面样式');
    expect(container.textContent).not.toContain('无特殊权限');
  });

  it('带界面模块的插件标为受信任界面代码', async () => {
    harness.list.mockResolvedValue([{ ...plugin, permissions: [], hasRenderer: true }]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    expect(container.textContent).toContain('受信任界面');
    expect(container.textContent).toContain('界面代码');
    await act(async () => detailsToggle().click());
    expect(container.textContent).toContain('界面代码：运行在主界面里');
    expect(container.textContent).not.toContain('无特殊权限');
  });

  it('待授权更新新增界面模块时单独列出', async () => {
    harness.list.mockResolvedValue([
      { ...plugin, pendingVersion: '2.0.0', pendingPermissions: [], pendingRenderer: true },
    ]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    await act(async () => detailsToggle().click());
    expect(container.textContent).toContain('待同意');
    expect(container.textContent).toContain('新增界面代码');
  });

  it('目录来源的插件可开开发模式，开着时卡片标出', async () => {
    harness.list.mockResolvedValue([{ ...plugin, source: { kind: 'dir' }, devWatch: true }]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    expect(container.textContent).toContain('开发模式');
    await act(async () => detailsToggle().click());
    await act(async () => byLabel('开发模式：目录改动后自动重装').click());
    expect(harness.setDevWatch).toHaveBeenCalledWith('local.missionops', false);
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

  it('multiline 的字符串配置用多行框，普通字符串仍是单行', async () => {
    harness.configGet.mockResolvedValue({
      ok: true,
      fields: [
        {
          key: 'name',
          title: 'Name',
          description: '',
          secret: false,
          type: 'string',
          set: false,
        },
        {
          key: 'prompt',
          title: 'Prompt',
          description: '',
          secret: false,
          type: 'string',
          multiline: true,
          set: true,
          value: 'line1\nline2',
        },
      ],
    });

    await act(async () => byLabel('Configure').click());
    const dialog = container.querySelector('[data-dialog="open"]');
    expect(dialog?.querySelector('input')?.getAttribute('type')).toBe('text');
    expect(dialog?.querySelector('textarea')?.getAttribute('data-value')).toBe('line1\nline2');
  });

  it('插件日志开关只在设置 → 日志页，插件页不再重复', async () => {
    await render();
    expect(container.textContent).not.toContain('Record plugin logs');
  });
});

describe('ExtensionPluginLogs', () => {
  const LOG = [
    '2026-11-06T12:29:34.080Z [info] started at /Users/me/plugin',
    '2026-11-06T12:48:54.789Z [warn] 已丢弃 3 行',
    '2026-11-06T13:15:49.129Z [error] renderer.call 失败： Error: 请先登录 Telegram',
    '    at Object.invoke (file:///Users/me/vendor/gramjs.mjs:2161:47198)',
    '',
  ].join('\n');

  const openLogs = async (text: string) => {
    harness.logs.mockResolvedValue({ ok: true, text });
    await act(async () => byLabel('Plugin logs').click());
  };
  const lines = () => [...container.querySelectorAll('[data-log-level]')];

  it('复制按钮把完整日志原文写入剪贴板', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await openLogs(LOG);
    await act(async () => byLabel('Copy').click());
    expect(writeText).toHaveBeenCalledWith(LOG);
  });

  it('空日志显示暂无日志，复制按钮禁用', async () => {
    await openLogs('');
    expect(container.textContent).toContain('No logs yet');
    expect(byLabel('Copy').hasAttribute('disabled')).toBe(true);
  });

  it('按行渲染：error 行与其续行带错误样式，warn 行带警告样式，info 行都没有', async () => {
    await openLogs(LOG);
    const rendered = lines();
    expect(rendered.map((line) => line.getAttribute('data-log-level'))).toEqual([
      'info',
      'warn',
      'error',
      'error',
    ]);
    expect(rendered[0]?.className).not.toMatch(/color-(warning|destructive)/);
    expect(rendered[1]?.className).toContain('color-warning');
    expect(rendered[2]?.className).toContain('color-destructive');
    expect(rendered[3]?.className).toBe(rendered[2]?.className);
  });

  it('行首时间戳单独渲染', async () => {
    await openLogs(LOG);
    const stamp = lines()[2]?.querySelector('[data-log-time]');
    expect(stamp?.textContent).toBe('2026-11-06T13:15:49.129Z');
    expect(lines()[3]?.querySelector('[data-log-time]')).toBeNull();
  });

  it('超大日志退回纯文本并提示', async () => {
    const big = Array.from(
      { length: 5001 },
      (_, i) => `2026-11-06T12:00:00.000Z [info] line-${i}`
    ).join('\n');
    await openLogs(big);
    expect(lines()).toHaveLength(0);
    expect(container.textContent).toContain('Log too large, showing plain text');
    expect(container.querySelector('pre')?.textContent).toBe(big);
  });

  it('开关关闭时日志面板显示未开启提示并提供开启入口', async () => {
    harness.pluginLoggingEnabled = false;
    harness.openSettings.mockClear();
    harness.setPluginLoggingEnabled.mockClear();
    await openLogs('');
    expect(container.textContent).toContain('Plugin logging is off');
    const enableBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Enable plugin logging')
    );
    expect(enableBtn).toBeDefined();
    await act(async () => (enableBtn as HTMLButtonElement).click());
    expect(harness.openSettings).toHaveBeenCalledWith({ category: 'logs', rowId: 'logs.root' });
    expect(harness.setPluginLoggingEnabled).not.toHaveBeenCalled();
    harness.pluginLoggingEnabled = true;
  });

  it('开关关闭但已有历史日志时同时保留未开启提示与历史日志查看', async () => {
    harness.pluginLoggingEnabled = false;
    await openLogs(LOG);
    expect(container.textContent).toContain('Plugin logging is off');
    expect(lines()).toHaveLength(4);
    harness.pluginLoggingEnabled = true;
  });
});

describe('插件市场安装', () => {
  const marketDialog = () =>
    [...container.querySelectorAll('[data-dialog="open"]')].find((dialog) =>
      dialog.querySelector('[data-market]')
    ) as HTMLElement | undefined;
  const marketList = () => marketDialog()?.querySelector('[data-market]')?.parentElement;
  const dialogButton = (text: string) => {
    const found = [...(marketDialog()?.querySelectorAll('button') ?? [])].find(
      (element) => element.textContent === text
    );
    expect(found).not.toBeUndefined();
    return found as HTMLElement;
  };
  const openAndInstall = async () => {
    await act(async () => byText('Marketplace').click());
    await act(async () => byLabel('market-install').click());
  };
  /** 确认按钮出现后要等一小会儿才可点，防止连点/按住回车误确认 */
  const armConfirm = () =>
    act(async () => {
      vi.advanceTimersByTime(1000);
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    harness.marketStage.mockResolvedValue({ ok: true, preview: stagedPreview });
    harness.commit.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('点安装后市场仍开着，权限确认就地显示在市场里', async () => {
    await openAndInstall();
    expect(harness.marketStage).toHaveBeenCalledWith('market.a');
    expect(marketDialog()).not.toBeUndefined();
    expect(container.querySelectorAll('[data-dialog="open"]')).toHaveLength(1);
    expect(marketDialog()?.textContent).toContain('Market A');
    expect(marketDialog()?.textContent).toContain('label:agent.tool');
    expect(marketList()?.hasAttribute('hidden')).toBe(true);
  });

  it('暂存失败时错误显示在市场里，市场不关', async () => {
    harness.marketStage.mockResolvedValue({ ok: false, error: '下载失败 boom' });
    await openAndInstall();
    expect(marketDialog()?.textContent).toContain('下载失败 boom');
    expect(marketList()?.hasAttribute('hidden')).toBe(false);
  });

  it('确认安装后回到市场列表并刷新已装状态，可接着装下一个', async () => {
    await openAndInstall();
    harness.list.mockResolvedValue([
      plugin,
      { ...plugin, id: 'market.a', name: 'Market A', version: '1.0.0' },
    ]);
    await armConfirm();
    await act(async () => dialogButton('Install').click());
    expect(harness.commit).toHaveBeenCalledWith('tok-1');
    expect(harness.setEnabled).toHaveBeenCalledWith('market.a', true);
    expect(marketDialog()).not.toBeUndefined();
    expect(marketList()?.hasAttribute('hidden')).toBe(false);
    expect(
      marketDialog()?.querySelector('[data-market]')?.getAttribute('data-installed')
    ).toContain('market.a@1.0.0');
    expect(byLabel('market-install').hasAttribute('disabled')).toBe(false);
  });

  it('提交失败时错误留在市场里', async () => {
    harness.commit.mockResolvedValue({ ok: false, error: '试载失败' });
    await openAndInstall();
    await armConfirm();
    await act(async () => dialogButton('Install').click());
    expect(marketDialog()?.textContent).toContain('试载失败');
    expect(marketList()?.hasAttribute('hidden')).toBe(false);
  });

  it('确认按钮刚出现时点不动，连点或按住回车不会直接装上；取消随时可点', async () => {
    await openAndInstall();
    const install = dialogButton('Install');
    expect(install.hasAttribute('disabled')).toBe(true);
    await act(async () => install.click());
    expect(harness.commit).not.toHaveBeenCalled();
    expect(dialogButton('Cancel').hasAttribute('disabled')).toBe(false);
    await armConfirm();
    await act(async () => dialogButton('Install').click());
    expect(harness.commit).toHaveBeenCalledWith('tok-1');
  });

  it('升级确认里标出新增的权限，并说明扩大授权要再允许一次', async () => {
    harness.marketStage.mockResolvedValue({
      ok: true,
      preview: {
        ...stagedPreview,
        version: '2.0.0',
        existingVersion: '1.0.0',
        expands: true,
        permissions: ['agent.tool', 'session.readAll'],
        addedPermissions: ['session.readAll'],
      },
    });
    await openAndInstall();
    const items = [...(marketDialog()?.querySelectorAll('li') ?? [])];
    const line = (permission: string) =>
      items.find((item) => item.textContent?.includes(permission))?.textContent;
    expect(line('session.readAll')).toContain('Added');
    expect(line('agent.tool')).not.toContain('Added');
    expect(marketDialog()?.textContent).toContain('This update asks for more than');
  });

  it('扩大授权的升级确认后进入待授权，市场按待授权状态刷新', async () => {
    harness.marketStage.mockResolvedValue({
      ok: true,
      preview: { ...stagedPreview, version: '2.0.0', existingVersion: '1.0.0', expands: true },
    });
    await openAndInstall();
    harness.list.mockResolvedValue([
      plugin,
      { ...plugin, id: 'market.a', version: '1.0.0', pendingVersion: '2.0.0' },
    ]);
    await armConfirm();
    await act(async () => dialogButton('Install').click());
    expect(harness.setEnabled).not.toHaveBeenCalled();
    // 还没装上新版：不报「已安装」，由 Main 的待授权通知提示去允许
    expect(harness.addToast).not.toHaveBeenCalled();
    expect(
      marketDialog()?.querySelector('[data-market]')?.getAttribute('data-installed')
    ).toContain('market.a@1.0.0>2.0.0');
  });

  it('取消确认丢弃暂存并回到市场列表', async () => {
    await openAndInstall();
    await act(async () => dialogButton('Cancel').click());
    expect(harness.discard).toHaveBeenCalledWith('tok-1');
    expect(marketDialog()).not.toBeUndefined();
    expect(marketList()?.hasAttribute('hidden')).toBe(false);
  });

  it('有未确认的暂存时关闭市场会丢弃它', async () => {
    await openAndInstall();
    const dismiss = marketDialog()?.querySelector('[data-dismiss]') as HTMLElement;
    await act(async () => dismiss.click());
    expect(marketDialog()).toBeUndefined();
    expect(harness.discard).toHaveBeenCalledWith('tok-1');
    expect(container.querySelector('[data-dialog="open"]')).toBeNull();
  });

  it('暂存途中关掉市场，晚到的结果被丢弃而不弹确认', async () => {
    let resolve: (value: unknown) => void = () => {};
    harness.marketStage.mockReturnValue(new Promise((r) => (resolve = r)));
    await openAndInstall();
    expect(byLabel('market-install').hasAttribute('disabled')).toBe(true);
    const dismiss = marketDialog()?.querySelector('[data-dismiss]') as HTMLElement;
    await act(async () => dismiss.click());
    await act(async () => resolve({ ok: true, preview: stagedPreview }));
    expect(harness.discard).toHaveBeenCalledWith('tok-1');
    expect(container.querySelector('[data-dialog="open"]')).toBeNull();
  });

  it('从已装列表重装仍走页面上的确认弹窗', async () => {
    harness.list.mockResolvedValue([{ ...plugin, source: { kind: 'dir' } }]);
    harness.restage.mockResolvedValue({ ok: true, preview: { ...stagedPreview, id: plugin.id } });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    await act(async () => byLabel('Reinstall from source').click());
    expect(harness.restage).toHaveBeenCalledWith('local.missionops');
    expect(marketDialog()).toBeUndefined();
    expect(container.querySelector('[data-dialog="open"]')?.textContent).toContain('Market A');
  });
});

describe('enso://install-plugin 深链', () => {
  it('高亮落在「从链接安装」那一行：链接已填入输入框并聚焦，不是页头', async () => {
    const source = 'https://github.com/owner/repo';
    const link = pluginInstallSettingsLink(source);
    const stageFromUrl = vi.fn(async () => ({ ok: false as const, error: 'offline' }));
    Object.assign(window.electronAPI.extensionPlugins, { stageFromUrl });
    const focused: Element[] = [];
    const focus = vi.spyOn(window.HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement
    ) {
      focused.push(this);
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<PluginsSettings requestedInstallUrl={source} />));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));

    const row = container.querySelector(`[data-settings-row="${link.rowId}"]`);
    expect(row?.tagName).not.toBe('HEADER');
    const input = row?.querySelector('input');
    expect((input as HTMLInputElement | null | undefined)?.value).toBe(source);
    expect(focused).toContain(input);
    expect(stageFromUrl).toHaveBeenCalledWith(source);
    focus.mockRestore();
  });
});

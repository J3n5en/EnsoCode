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
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({
      pluginAutoUpdate: true,
      setPluginAutoUpdate: vi.fn(),
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
  themes: [],
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
        configGet: harness.configGet,
        setDevWatch: harness.setDevWatch,
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

  it('只带主题 CSS 的插件不再声称无特殊权限', async () => {
    harness.list.mockResolvedValue([
      { ...plugin, permissions: [], themes: [{ id: 'lab', name: 'Lab', css: 'x.css' }] },
    ]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    await act(async () => byText('详情').click());
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
    await act(async () => byText('详情').click());
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

    await act(async () => byText('详情').click());
    expect(container.textContent).toContain('待同意');
    expect(container.textContent).toContain('新增界面代码');
  });

  it('目录来源的插件可开开发模式，开着时卡片标出', async () => {
    harness.list.mockResolvedValue([{ ...plugin, source: { kind: 'dir' }, devWatch: true }]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    expect(container.textContent).toContain('开发模式');
    await act(async () => byText('详情').click());
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
});

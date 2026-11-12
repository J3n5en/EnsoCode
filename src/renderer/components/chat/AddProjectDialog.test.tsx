import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddProjectDialog } from './AddProjectDialog';

// t 必须稳定：DirBrowser 的 load 依赖 t，每次新建会让加载 effect 无限重跑
const i18n = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('@/i18n', () => ({ useI18n: () => i18n }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select({ projects: [] }),
}));
vi.mock('@/components/chat/SshHostKeyDialog', () => ({
  hostKeyFromSshFailure: () => null,
  SshHostKeyDialog: () => null,
}));
vi.mock('@/components/ui/autocomplete', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Autocomplete: Wrap,
    AutocompleteEmpty: () => null,
    AutocompleteInput: () => null,
    AutocompleteItem: () => null,
    AutocompleteList: () => null,
    AutocompletePopup: () => null,
  };
});
vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? createElement('div', null, children) : null,
    DialogContent: Wrap,
    DialogDescription: Wrap,
    DialogFooter: Wrap,
    DialogHeader: Wrap,
    DialogPanel: Wrap,
    DialogTitle: Wrap,
  };
});
vi.mock('@/components/ui/field', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Field: Wrap, FieldLabel: Wrap };
});
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<'button'> & { size?: string; variant?: string }) =>
    createElement('button', { type: 'button', ...props }, children),
}));
vi.mock('@/components/ui/input', () => ({
  Input: ({
    onChange,
    size: _size,
    ...props
  }: Omit<ComponentProps<'input'>, 'size'> & { size?: string }) =>
    createElement('input', { ...props, onInput: onChange }),
}));
// Select / Tabs：点子项即回调 onValueChange
vi.mock('@/components/ui/select', async () => {
  const react = await import('react');
  const Pick = react.createContext<(value: string) => void>(() => {});
  const Wrap = ({ children }: { children?: ReactNode }) =>
    react.createElement('div', null, children);
  function SelectItem({ value, children }: { value: string; children?: ReactNode }) {
    const pick = react.useContext(Pick);
    return react.createElement('button', { type: 'button', onClick: () => pick(value) }, children);
  }
  return {
    Select: ({
      onValueChange,
      children,
    }: {
      onValueChange: (v: string) => void;
      children?: ReactNode;
    }) => react.createElement(Pick.Provider, { value: onValueChange }, children),
    SelectItem,
    SelectPopup: Wrap,
    SelectTrigger: Wrap,
    SelectValue: () => null,
  };
});
vi.mock('@/components/ui/tabs', async () => {
  const react = await import('react');
  const Pick = react.createContext<(value: string) => void>(() => {});
  function TabsTab({ value, children }: { value: string; children?: ReactNode }) {
    const pick = react.useContext(Pick);
    return react.createElement('button', { type: 'button', onClick: () => pick(value) }, children);
  }
  return {
    Tabs: ({
      onValueChange,
      children,
    }: {
      onValueChange: (v: string) => void;
      children?: ReactNode;
    }) => react.createElement(Pick.Provider, { value: onValueChange }, children),
    TabsList: ({ children }: { children?: ReactNode }) =>
      react.createElement('div', null, children),
    TabsTab,
  };
});

let root: Root;
let container: HTMLElement;
const onAdd = vi.fn();
const onOpenChange = vi.fn();
const sshTest = vi.fn();
const createHostDir = vi.fn();
let resolveTest: (result: { ok: boolean; error?: string }) => void = () => {};

const render = (open: boolean) =>
  act(async () => root.render(createElement(AddProjectDialog, { open, onOpenChange, onAdd })));
const click = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
};
const type = (input: Element | null, value: string) =>
  act(async () => {
    if (!(input instanceof window.HTMLInputElement)) throw new Error('Missing input');
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const press = (input: Element | null, key: string, isComposing: boolean) =>
  act(async () => {
    if (!input) throw new Error('Missing input');
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { key: { value: key }, isComposing: { value: isComposing } });
    input.dispatchEvent(event);
  });
const submit = () =>
  act(async () => {
    container
      .querySelector('form')
      ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
const fillSsh = async () => {
  await click('Remote (SSH)');
  await click('Prod (me@example.com)');
  await type(container.querySelector('input[placeholder="/home/user/project"]'), '/srv/app');
};

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onAdd.mockReset();
  onOpenChange.mockReset();
  createHostDir.mockReset().mockReturnValue(new Promise(() => {}));
  // 同一个结果同时交给所有进行中的连接测试
  const pending = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    resolveTest = resolve;
  });
  sshTest.mockReset().mockReturnValue(pending);
  Object.assign(window, {
    electronAPI: {
      sshConnections: {
        list: vi.fn(async () => [{ id: 'conn-1', name: 'Prod', host: 'example.com', user: 'me' }]),
        test: sshTest,
        listDirs: vi.fn(),
        trustHost: vi.fn(),
      },
      projects: {
        getRecent: vi.fn(async () => []),
        listHostDirs: vi.fn(async () => ({ ok: true, path: '/home', dirs: [] })),
        createHostDir,
      },
      dialog: { selectDirectory: vi.fn() },
    },
  });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('AddProjectDialog SSH 提交', () => {
  it('测试连接期间连点添加只添加一次', async () => {
    await render(true);
    await fillSsh();
    await submit();
    await submit();
    await act(async () => resolveTest({ ok: true }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('关闭弹窗后连接测试才成功时不再添加项目', async () => {
    await render(true);
    await fillSsh();
    await submit();
    await render(false);
    await act(async () => resolveTest({ ok: true }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('连接测试失败后可以改完再次提交', async () => {
    await render(true);
    await fillSsh();
    await submit();
    await act(async () => resolveTest({ ok: false, error: 'Connection refused' }));
    expect(container.textContent).toContain('Connection refused');
    await submit();
    expect(sshTest).toHaveBeenCalledTimes(2);
  });
});

describe('AddProjectDialog 新建文件夹', () => {
  // 真实场景：macOS 中文输入法按回车确认候选词时，keydown 是 key=Enter、isComposing=true
  it('输入法组字中按回车不创建文件夹', async () => {
    Object.assign(window.electronAPI, { remote: {} });
    await render(true);
    await click('Browse');
    await click('New Folder');
    const input = container.querySelector('input[placeholder="Folder name"]');
    await type(input, '文档');
    await press(input, 'Enter', true);
    expect(createHostDir).not.toHaveBeenCalled();
  });
});

import type { GithubRepoSearchResult, HostDirSearchResult } from '@shared/types';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddProjectDialog, cloneFolderName, validateNewFolderName } from './AddProjectDialog';

// t 必须稳定：DirBrowser 的 load 依赖 t，每次新建会让加载 effect 无限重跑
const i18n = vi.hoisted(() => ({
  t: (key: string, params?: Record<string, string | number>) =>
    params ? key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? '')) : key,
}));
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
        searchHostDirs: vi.fn(async () => ({ ok: true, host: 'test-host', results: [] })),
        searchGithubRepos: vi.fn(async () => ({ ok: true, repos: [] })),
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

describe('AddProjectDialog 本机目录搜索', () => {
  const searchInput = () => container.querySelector('input[placeholder="Search for directory"]');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('停顿后搜索，点结果填入路径并可提交', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const search = vi.fn(
      async (): Promise<HostDirSearchResult> => ({
        ok: true,
        host: 'mbp',
        results: [{ path: '/Users/me/proj', displayPath: '~/proj' }],
      })
    );
    window.electronAPI.projects.searchHostDirs = search;
    await render(true);
    expect(container.textContent).not.toContain('Find a directory on mbp');
    await type(searchInput(), '  proj');
    expect(search).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Searching...');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(search).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('proj');
    expect(container.textContent).toContain('Find a directory on mbp');
    expect(container.textContent).toContain('~/proj');
    await click('~/proj');
    expect(searchInput()).toHaveProperty('value', '');
    expect(container.textContent).not.toContain('~/proj');
    const add = [...container.querySelectorAll('button')].find((el) => el.textContent === 'Add');
    expect(add?.hasAttribute('disabled')).toBe(false);
    await submit();
    expect(onAdd).toHaveBeenCalledWith({ path: '/Users/me/proj' });
  });

  it('没有匹配时显示空结果，空白输入不搜索', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const search = vi.fn(
      async (): Promise<HostDirSearchResult> => ({ ok: true, host: 'mbp', results: [] })
    );
    window.electronAPI.projects.searchHostDirs = search;
    await render(true);
    await type(searchInput(), '   ');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(search).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('No matching directories');
    await type(searchInput(), 'nope');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(container.textContent).toContain('No matching directories');
    expect(container.textContent).toContain('Find a directory on mbp');
  });

  it('新输入作废尚未返回的旧搜索', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolveOld: (value: HostDirSearchResult) => void = () => {};
    const search = vi.fn((query: string): Promise<HostDirSearchResult> => {
      if (query === 'old')
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      return Promise.resolve<HostDirSearchResult>({
        ok: true,
        host: 'mbp',
        results: [{ path: '/work/new', displayPath: '~/new' }],
      });
    });
    window.electronAPI.projects.searchHostDirs = search;
    await render(true);
    await type(searchInput(), 'old');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await type(searchInput(), 'new');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(container.textContent).toContain('~/new');
    await act(async () => {
      resolveOld({
        ok: true,
        host: 'mbp',
        results: [{ path: '/work/old', displayPath: '~/old' }],
      });
    });
    expect(container.textContent).not.toContain('~/old');
    expect(container.textContent).toContain('~/new');
  });

  it('关闭再打开不保留上次搜索，远程页没有本机搜索', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    window.electronAPI.projects.searchHostDirs = vi.fn(
      async (): Promise<HostDirSearchResult> => ({
        ok: true,
        host: 'mbp',
        results: [{ path: '/Users/me/proj', displayPath: '~/proj' }],
      })
    );
    await render(true);
    await type(searchInput(), 'proj');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(container.textContent).toContain('~/proj');
    await render(false);
    await render(true);
    expect(container.textContent).not.toContain('~/proj');
    expect(searchInput()).toHaveProperty('value', '');
    await click('Remote (SSH)');
    expect(searchInput()).toBeNull();
  });
});

describe('AddProjectDialog 新建与克隆', () => {
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((el) => el.textContent === text);
  const input = (placeholder: string) =>
    container.querySelector(`input[placeholder="${placeholder}"]`);

  it('非法文件夹名显示红字并禁用创建', async () => {
    await render(true);
    await click('New folder');
    const create = () => button('Create and add');
    expect(create()?.hasAttribute('disabled')).toBe(true);

    await type(input('Folder name'), 'bad/name');
    expect(container.textContent).toContain(
      'Folder name cannot contain slashes or control characters.'
    );
    expect(create()?.hasAttribute('disabled')).toBe(true);

    await type(input('Folder name'), 'bad\\name');
    expect(create()?.hasAttribute('disabled')).toBe(true);
    await type(input('Folder name'), '..');
    expect(container.textContent).toContain('Enter a folder name');
    expect(create()?.hasAttribute('disabled')).toBe(true);
    await type(input('Folder name'), 'a\u0001b');
    expect(container.textContent).toContain(
      'Folder name cannot contain slashes or control characters.'
    );

    await type(input('Search parent directory'), '/Users/me');
    await submit();
    expect(createHostDir).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('创建成功后只添加新目录一次', async () => {
    let resolveCreate: (result: {
      ok: boolean;
      path?: string;
      parent?: string | null;
      dirs?: string[];
      error?: string;
    }) => void = () => {};
    createHostDir.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );
    await render(true);
    await click('New folder');
    await type(input('Folder name'), '  demo  ');
    await type(input('Search parent directory'), '/Users/me/src/');
    expect(container.textContent).toContain('/Users/me/src/demo');
    expect(button('Create and add')?.hasAttribute('disabled')).toBe(false);
    await submit();
    await submit();
    expect(createHostDir).toHaveBeenCalledTimes(1);
    expect(createHostDir).toHaveBeenCalledWith('/Users/me/src', 'demo');
    expect(onAdd).not.toHaveBeenCalled();
    expect(button('Create and add')?.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      resolveCreate({ ok: true, path: '/Users/me/src/demo', parent: '/Users/me/src', dirs: [] });
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({ path: '/Users/me/src/demo' });
  });

  it('创建失败时显示错误且不添加项目', async () => {
    createHostDir.mockResolvedValue({ ok: false, error: 'Permission denied' });
    await render(true);
    await click('New folder');
    await type(input('Folder name'), 'demo');
    await type(input('Search parent directory'), '/Users/me');
    await submit();
    expect(container.textContent).toContain('Permission denied');
    expect(onAdd).not.toHaveBeenCalled();
    expect(button('Create and add')?.hasAttribute('disabled')).toBe(false);
  });

  it('从仓库地址推导目录名，克隆成功后添加返回路径', async () => {
    expect(cloneFolderName('https://github.com/acme/widget.git')).toBe('widget');
    expect(cloneFolderName('git@github.com:acme/widget.git')).toBe('widget');
    expect(cloneFolderName('acme/widget')).toBe('widget');
    expect(cloneFolderName('https://github.com/acme/widget.git/')).toBe('widget');
    expect(validateNewFolderName('ok')).toBeNull();

    let resolveClone: (result: { ok: true; path: string } | { ok: false; error: string }) => void =
      () => {};
    const gitClone = vi.fn(
      () =>
        new Promise<{ ok: true; path: string } | { ok: false; error: string }>((resolve) => {
          resolveClone = resolve;
        })
    );
    window.electronAPI.projects.gitClone = gitClone;
    await render(true);
    await click('Clone');
    expect(container.textContent).not.toContain('Search for directory');
    await type(input('owner/repo or a git URL'), 'https://github.com/acme/widget.git');
    await type(input('Search parent directory'), '/Users/me/src');
    expect(container.textContent).toContain('/Users/me/src/widget');
    await submit();
    await submit();
    expect(gitClone).toHaveBeenCalledTimes(1);
    expect(gitClone).toHaveBeenCalledWith({
      url: 'https://github.com/acme/widget.git',
      parentDir: '/Users/me/src',
    });
    expect(createHostDir).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
    await act(async () => {
      resolveClone({ ok: false, error: 'Clone failed.' });
    });
    expect(container.textContent).toContain('Clone failed.');
    expect(onAdd).not.toHaveBeenCalled();

    await submit();
    expect(gitClone).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveClone({ ok: true, path: '/Users/me/src/widget' });
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({ path: '/Users/me/src/widget' });
  });
});

describe('AddProjectDialog 仓库与位置搜索', () => {
  const input = (placeholder: string) =>
    container.querySelector(`input[placeholder="${placeholder}"]`);
  const buttonIncluding = (text: string) =>
    [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(text));

  afterEach(() => {
    vi.useRealTimers();
  });

  it('输入仓库关键词后选中结果，回填克隆地址并更新目标目录', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const search = vi.fn(
      async (): Promise<GithubRepoSearchResult> => ({
        ok: true,
        repos: [
          {
            name: 'widget',
            nameWithOwner: 'acme/widget',
            description: 'A demo repository for widgets',
            isPrivate: true,
            url: 'https://github.com/acme/widget',
          },
        ],
      })
    );
    window.electronAPI.projects.searchGithubRepos = search;
    await render(true);
    await click('Clone');
    await type(input('owner/repo or a git URL'), 'acme/widget');
    expect(container.textContent).toContain('acme/widget');
    expect(container.textContent).toContain('Searching...');
    expect(search).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(search).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('acme/widget', 10);
    expect(container.textContent).toContain('Search your repositories');
    expect(container.textContent).toContain('A demo repository for widgets');
    const repo = buttonIncluding('acme/widget');
    if (!repo) throw new Error('Missing repo result');
    await act(async () => repo.click());
    expect(input('owner/repo or a git URL')).toHaveProperty(
      'value',
      'https://github.com/acme/widget'
    );
    expect(container.textContent).not.toContain('A demo repository for widgets');
    await type(input('Search parent directory'), '/Users/me/src');
    expect(container.textContent).toContain('/Users/me/src/widget');
  });

  it('新的仓库关键词作废尚未返回的旧搜索', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolveOld: (value: GithubRepoSearchResult) => void = () => {};
    const search = vi.fn((query: string): Promise<GithubRepoSearchResult> => {
      if (query === 'old') {
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        repos: [
          {
            name: 'new',
            nameWithOwner: 'acme/new',
            description: null,
            isPrivate: false,
            url: 'https://github.com/acme/new',
          },
        ],
      });
    });
    window.electronAPI.projects.searchGithubRepos = search;
    await render(true);
    await click('Clone');
    await type(input('owner/repo or a git URL'), 'old');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await type(input('owner/repo or a git URL'), 'new');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(container.textContent).toContain('acme/new');
    await act(async () => {
      resolveOld({
        ok: true,
        repos: [
          {
            name: 'old',
            nameWithOwner: 'acme/old',
            description: null,
            isPrivate: false,
            url: 'https://github.com/acme/old',
          },
        ],
      });
    });
    expect(container.textContent).not.toContain('acme/old');
    expect(container.textContent).toContain('acme/new');
  });

  it('gh 未登录时提示登录，而不是空结果', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    window.electronAPI.projects.searchGithubRepos = vi.fn(
      async (): Promise<GithubRepoSearchResult> => ({
        ok: false,
        error: 'Sign in to GitHub with gh CLI.',
      })
    );
    await render(true);
    await click('Clone');
    await type(input('owner/repo or a git URL'), 'enso');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(container.textContent).toContain('Sign in to GitHub with gh CLI.');
    expect(container.textContent).not.toContain('No repositories found');
  });

  it('克隆和新建文件夹都能搜索位置并回填父目录', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const search = vi.fn(
      async (): Promise<HostDirSearchResult> => ({
        ok: true,
        host: 'mbp',
        results: [{ path: '/Users/me/src', displayPath: '~/src' }],
      })
    );
    window.electronAPI.projects.searchHostDirs = search;
    await render(true);
    await click('Clone');
    const parent = () => container.querySelector('input[placeholder="Search parent directory"]');
    await type(parent(), 'src');
    expect(search).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(search).toHaveBeenCalledWith('src');
    expect(container.textContent).toContain('~/src');
    await click('~/src');
    expect(parent()).toHaveProperty('value', '/Users/me/src');
    expect(container.textContent).not.toContain('~/src');

    await click('New folder');
    await type(input('Folder name'), 'demo');
    expect(container.textContent).toContain('/Users/me/src/demo');
    await type(parent(), 'lib');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(search).toHaveBeenLastCalledWith('lib');
    await click('~/src');
    expect(parent()).toHaveProperty('value', '/Users/me/src');
    expect(container.textContent).toContain('/Users/me/src/demo');
  });
});

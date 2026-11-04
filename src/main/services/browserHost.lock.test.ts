import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  dir: '',
  contents: [] as any[],
  exec: (async () => 'ok') as (script: string) => Promise<unknown>,
}));
vi.mock('../windows/createAppWindow', () => ({ getWorkbenchView: () => null }));
vi.mock('./proxyConfig', () => ({ getProxyConfig: () => ({ attachSession: () => {} }) }));
vi.mock('electron', () => ({
  app: { getPath: () => mock.dir, isPackaged: false },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      webRequest: { onBeforeRequest() {} },
    }),
  },
  WebContentsView: class {
    webContents: any;
    constructor() {
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const contents = {
        id: mock.contents.length + 1,
        url: '',
        scripts: [] as string[],
        on: (name: string, fn: (...args: any[]) => void) => {
          listeners[name] = [...(listeners[name] ?? []), fn];
        },
        once: (name: string, fn: (...args: any[]) => void) => {
          listeners[name] = [...(listeners[name] ?? []), fn];
        },
        emit: (name: string, ...args: any[]) => {
          for (const fn of listeners[name] ?? []) fn(...args);
        },
        setWindowOpenHandler() {},
        getURL: () => contents.url,
        getTitle: () => '',
        isLoading: () => false,
        isDestroyed: () => false,
        navigationHistory: {
          clear() {},
          canGoBack: () => false,
          canGoForward: () => false,
          getActiveIndex: () => 0,
          getEntryAtIndex: () => undefined,
        },
        executeJavaScript: (script: string) => {
          contents.scripts.push(script);
          return mock.exec(script);
        },
        loadURL: async (url: string) => {
          contents.url = url;
        },
        debugger: {
          isAttached: () => false,
          attach() {},
          detach() {},
          on() {},
          sendCommand: async () => ({}),
        },
      };
      mock.contents.push(contents);
      this.webContents = contents;
    }
    setBackgroundColor() {}
    setBounds() {}
    setBorderRadius() {}
    setVisible() {}
  },
}));

import { PAGE_LOCK_OVERLAY_SCRIPT, PAGE_UNLOCK_OVERLAY_SCRIPT } from '@shared/browser/pageScripts';
import { BrowserHost } from './browserHost';

mock.dir = mkdtempSync(join(tmpdir(), 'browser-lock-'));
afterAll(() => rmSync(mock.dir, { recursive: true, force: true }));

beforeEach(() => {
  mock.contents.length = 0;
  mock.exec = async () => 'ok';
});

const openTab = async (host: BrowserHost, tabId: string, sessionId = 'conv') => {
  await host.userNavigate(tabId, sessionId, 'https://example.com');
  const contents = mock.contents[mock.contents.length - 1];
  contents.emit('dom-ready');
  return contents;
};

it('unlock 只在遮罩确实移除后才落 locked=false', async () => {
  const host = new BrowserHost();
  const contents = await openTab(host, 'tab-a');
  await host.setLocked('conv', true);
  expect(host.state('tab-a').locked).toBe(true);

  mock.exec = async () => {
    throw new Error('context destroyed');
  };
  await host.setLocked('conv', false);
  expect(host.state('tab-a').locked).toBe(true);

  mock.exec = async () => 'stuck';
  await host.setLocked('conv', false);
  expect(host.state('tab-a').locked).toBe(true);

  mock.exec = async () => 'ok';
  contents.scripts.length = 0;
  await host.setLocked('conv', false);
  expect(host.state('tab-a').locked).toBe(false);
  expect(contents.scripts).toContain(PAGE_UNLOCK_OVERLAY_SCRIPT);
});

it('lock op 如实回报真实状态，解锁失败不谎报 released', async () => {
  const host = new BrowserHost();
  await openTab(host, 'tab-a');
  expect(await host.invoke('conv', 'lock', {})).toEqual({ locked: true });

  mock.exec = async () => 'stuck';
  expect(await host.invoke('conv', 'lock', { release: true })).toEqual({ locked: true });

  mock.exec = async () => 'ok';
  expect(await host.invoke('conv', 'lock', { release: true })).toEqual({ locked: false });
});

it('did-finish-load 始终把遮罩对齐 locked，清掉 BFCache 带回来的残留', async () => {
  const host = new BrowserHost();
  const contents = await openTab(host, 'tab-a');

  contents.scripts.length = 0;
  contents.emit('did-finish-load');
  await Promise.resolve();
  expect(contents.scripts).toContain(PAGE_UNLOCK_OVERLAY_SCRIPT);

  await host.setLocked('conv', true);
  contents.scripts.length = 0;
  contents.emit('did-finish-load');
  await Promise.resolve();
  expect(contents.scripts).toContain(PAGE_LOCK_OVERLAY_SCRIPT);
});

it('release 解锁会话下所有 tab，加锁仍只作用于当前 tab', async () => {
  const host = new BrowserHost();
  const first = await openTab(host, 'tab-a');
  await host.setLocked('conv', true);
  const second = await openTab(host, 'tab-b');
  expect(host.state('tab-b').locked).toBe(false);

  await host.setLocked('conv', true);
  expect(host.state('tab-a').locked).toBe(true);
  expect(host.state('tab-b').locked).toBe(true);

  first.scripts.length = 0;
  second.scripts.length = 0;
  await host.setLocked('conv', false);
  expect(host.state('tab-a').locked).toBe(false);
  expect(host.state('tab-b').locked).toBe(false);
  expect(first.scripts).toContain(PAGE_UNLOCK_OVERLAY_SCRIPT);
  expect(second.scripts).toContain(PAGE_UNLOCK_OVERLAY_SCRIPT);
});

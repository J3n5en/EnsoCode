import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  dir: '',
  contents: [] as any[],
  bounds: [] as { width: number; height: number }[],
  workbench: { name: 'workbench', setBounds() {} } as any,
}));
vi.mock('../windows/createAppWindow', () => ({ getWorkbenchView: () => mock.workbench }));
vi.mock('./proxyConfig', () => ({ getProxyConfig: () => ({ attachSession: () => {} }) }));
vi.mock('electron', () => ({
  app: { getPath: () => mock.dir, isPackaged: false },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      webRequest: { onBeforeRequest() {} },
      cookies: { flushStore: async () => {} },
      flushStorageData: async () => {},
    }),
  },
  WebContentsView: class {
    name = 'guest';
    webContents: any;
    constructor() {
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const contents = {
        id: mock.contents.length + 1,
        url: '',
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
        isDevToolsOpened: () => false,
        close() {},
        closeDevTools() {},
        navigationHistory: {
          clear() {},
          canGoBack: () => false,
          canGoForward: () => false,
          getActiveIndex: () => 0,
          getEntryAtIndex: () => undefined,
        },
        executeJavaScript: async () => 'ok',
        loadURL: async (url: string) => {
          contents.url = url;
        },
        debugger: {
          isAttached: () => true,
          attach() {},
          detach() {},
          on() {},
          sendCommand: async (method: string) =>
            method === 'Page.captureScreenshot' ? { data: 'png' } : {},
        },
      };
      mock.contents.push(contents);
      this.webContents = contents;
    }
    setBackgroundColor() {}
    setBounds(bounds: { width: number; height: number }) {
      mock.bounds.push({ width: bounds.width, height: bounds.height });
    }
    getBounds() {
      return { x: 0, y: 0, ...(mock.bounds.at(-1) ?? { width: 0, height: 0 }) };
    }
    setBorderRadius() {}
    setVisible() {}
  },
}));

import { BrowserHost } from './browserHost';

mock.dir = mkdtempSync(join(tmpdir(), 'browser-zorder-'));
afterAll(() => rmSync(mock.dir, { recursive: true, force: true }));

const makeWindow = () => {
  const children: any[] = [];
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    getContentBounds: () => ({ width: 1200, height: 800 }),
    contentView: {
      children,
      addChildView: (view: any, index?: number) => {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
        if (index === undefined) children.push(view);
        else children.splice(index, 0, view);
      },
      removeChildView: (view: any) => {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
      },
    },
  };
};

const raised = (win: ReturnType<typeof makeWindow>) => {
  const { children } = win.contentView;
  const guest = children.findIndex((c) => c.name === 'guest');
  return guest > children.indexOf(mock.workbench);
};

const viewport = { x: 0, y: 0, width: 600, height: 400 };

beforeEach(() => {
  mock.contents.length = 0;
  mock.bounds.length = 0;
});

const setup = async () => {
  const host = new BrowserHost();
  const win = makeWindow();
  host.setHostWindow(() => win as any);
  await host.userNavigate('tab-a', 'conv', 'https://example.com');
  mock.contents[0].emit('dom-ready');
  host.setViewport('tab-a', 'conv', viewport);
  return { host, win };
};

it('浮层上报方消失后不再永久压住 guest', async () => {
  const { host, win } = await setup();
  expect(raised(win)).toBe(true);

  host.setOverlayActive(true);
  expect(raised(win)).toBe(false);

  host.resetOverlayReports();
  expect(raised(win)).toBe(true);
  // 新 renderer 从 count=0 起步，不会补发 false；重置后必须能再次沉下去
  host.setOverlayActive(true);
  expect(raised(win)).toBe(false);
});

it('covered 闩锁同样在上报方消失后回落', async () => {
  const { host, win } = await setup();
  host.setViewport('tab-a', 'conv', viewport, true);
  expect(raised(win)).toBe(false);

  host.resetOverlayReports();
  expect(raised(win)).toBe(true);
});

it('hibernateAll 关掉 guest webContents，进托盘才能丢掉 renderer', async () => {
  const { host, win } = await setup();
  let closed = false;
  mock.contents[0].close = () => {
    closed = true;
    mock.contents[0].isDestroyed = () => true;
  };
  expect(win.contentView.children.some((c) => c.name === 'guest')).toBe(true);

  await host.hibernateAll();

  expect(closed).toBe(true);
  expect(host.state('tab-a').tabId).toBe(null);
  expect(win.contentView.children.some((c) => c.name === 'guest')).toBe(false);
  expect(host.listSearchableTabs().some((tab) => tab.url.startsWith('https://example.com'))).toBe(
    true
  );
});

// CDP 截图会直接改 guest 页面视图尺寸并还原到截图开始时的旧值；Windows 不随容器自愈，必须按容器重新对齐
const bounced = () =>
  mock.bounds
    .slice(-2)
    .map((b) => b.height)
    .join() === `${viewport.height + 1},${viewport.height}`;

it('截图后按当前容器尺寸重新对齐显示中的 guest', async () => {
  const { host } = await setup();
  mock.bounds.length = 0;
  await host.invoke('conv', 'screenshot', {});
  expect(bounced()).toBe(true);
});

it('隐藏时截过图，再以相同矩形显示也要重新对齐', async () => {
  const { host } = await setup();
  host.setViewport('tab-a', 'conv', null);
  await host.invoke('conv', 'screenshot', {});
  mock.bounds.length = 0;
  host.setViewport('tab-a', 'conv', viewport);
  expect(bounced()).toBe(true);
  mock.bounds.length = 0;
  host.setViewport('tab-a', 'conv', { ...viewport, x: 1 });
  expect(bounced()).toBe(false);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  dir: '',
  contents: [] as any[],
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
          sendCommand: async () => ({}),
        },
      };
      mock.contents.push(contents);
      this.webContents = contents;
    }
    setBackgroundColor() {}
    setBounds() {}
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

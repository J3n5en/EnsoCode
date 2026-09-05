import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  dir: '',
  listeners: {} as Record<string, (...args: any[]) => void>,
  url: '',
  request: undefined as any,
  open: undefined as any,
  clearHistory: vi.fn(),
  back: vi.fn(),
  historyUrl: 'file:///etc/passwd',
}));
vi.mock('../windows/createAppWindow', () => ({ getWorkbenchView: () => null }));
vi.mock('./proxyConfig', () => ({ getProxyConfig: () => ({ attachSession: () => {} }) }));
vi.mock('electron', () => ({
  app: { getPath: () => mock.dir, isPackaged: false },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      webRequest: {
        onBeforeRequest: (_filter: unknown, handler: unknown) => {
          mock.request = handler;
        },
      },
    }),
  },
  WebContentsView: class {
    setBackgroundColor() {}
    webContents = {
      id: 42,
      on: (name: string, fn: (...args: any[]) => void) => {
        mock.listeners[name] = fn;
      },
      once() {},
      setWindowOpenHandler: (fn: unknown) => {
        mock.open = fn;
      },
      getURL: () => mock.url,
      getTitle: () => '',
      isLoading: () => false,
      navigationHistory: {
        clear: mock.clearHistory,
        canGoBack: () => true,
        canGoForward: () => true,
        getActiveIndex: () => 1,
        getEntryAtIndex: () => ({ url: mock.historyUrl }),
        goBack: mock.back,
        goForward: mock.back,
      },
      loadURL: async (url: string) => {
        mock.url = url;
        mock.listeners['did-navigate']?.();
      },
    };
  },
}));

import { setBrowserFileRootResolver } from './browserFileRoot';
import { BrowserHost } from './browserHost';

mock.dir = mkdtempSync(join(tmpdir(), 'browser-host-'));
afterAll(() => rmSync(mock.dir, { recursive: true, force: true }));
it('file 导航清除旧 HTTP 持久化；请求与页内导航守住工作区边界', async () => {
  setBrowserFileRootResolver(() => mock.dir);
  const host = new BrowserHost();
  writeFileSync(join(mock.dir, 'index.html'), 'ok');
  await host.userNavigate('tab', 'conversation', 'https://example.com');
  const file = pathToFileURL(join(mock.dir, 'index.html')).href;
  await host.userNavigate('tab', 'conversation', file);
  expect(JSON.parse(readFileSync(join(mock.dir, 'browser-tabs.json'), 'utf8'))).not.toHaveProperty(
    'tab'
  );
  const deny = vi.fn();
  mock.listeners['will-navigate']({ preventDefault: deny }, 'file:///etc/passwd');
  mock.listeners['will-redirect']({ preventDefault: deny }, 'file:///etc/passwd');
  expect(deny).toHaveBeenCalledTimes(2);
  expect(mock.open({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
  expect(mock.url).toBe(file);
  const callback = vi.fn();
  mock.request({ url: 'file:///etc/passwd', webContentsId: 42 }, callback);
  expect(callback).toHaveBeenCalledWith({ cancel: true });
  await expect(host.navigate('conversation', file)).rejects.toThrow();
  await expect(host.userNavigate('tab', 'other-conversation', file)).rejects.toThrow(/owner/);
  expect(mock.clearHistory).toHaveBeenCalledOnce();
  host.goBack('tab');
  host.goForward('tab');
  expect(mock.back).not.toHaveBeenCalled();
  mock.request({ url: file, webContentsId: 42 }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: false });
  mock.request({ url: file, webContentsId: 999 }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: true });
  rmSync(join(mock.dir, 'index.html'));
  symlinkSync('/etc/passwd', join(mock.dir, 'index.html'));
  mock.request({ url: file, webContentsId: 42 }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: true });
});

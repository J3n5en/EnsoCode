import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreHostBrowserTabs } from './browserTabs';

function stubApi(remote: object | undefined) {
  const restoreTabs = vi.fn(() => Promise.resolve());
  vi.stubGlobal('window', { electronAPI: { browser: { restoreTabs }, remote } });
  return restoreTabs;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('restoreHostBrowserTabs', () => {
  it('本机桌面恢复宿主内置浏览器标签', () => {
    const restoreTabs = stubApi(undefined);
    restoreHostBrowserTabs();
    expect(restoreTabs).toHaveBeenCalledTimes(1);
  });

  it('远程客户端不发起 browser:restore-tabs', () => {
    const restoreTabs = stubApi({});
    restoreHostBrowserTabs();
    expect(restoreTabs).not.toHaveBeenCalled();
  });
});

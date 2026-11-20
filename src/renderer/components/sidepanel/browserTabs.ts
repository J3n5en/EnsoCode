import { isRemoteClient } from '@/lib/remoteClient';

/** 恢复宿主内置浏览器标签；远程客户端看不到宿主浏览器，browser:* 也不对远端开放 */
export function restoreHostBrowserTabs(): void {
  if (isRemoteClient()) return;
  void window.electronAPI.browser.restoreTabs();
}

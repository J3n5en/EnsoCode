import type { RemoteApi } from '@shared/remoteBridge';

type RemoteEntryApi = Pick<RemoteApi, 'openDevices' | 'linkStatus' | 'onLinkStatus' | 'exitDesk'>;

/**
 * 侧栏底栏的手机链路入口：新版手机壳是电脑标签（打开壳里的「电脑与通知」抽屉），
 * 旧版壳只有 Info 弹层；电脑上（无 remote 或节点层）都不显示。
 */
export function phoneLinkEntry(remote: RemoteEntryApi | undefined): 'devices' | 'info' | null {
  if (!remote?.linkStatus || !remote.onLinkStatus) return null;
  return remote.openDevices ? 'devices' : 'info';
}

/** 「精简版」按钮：新版壳把它收进了抽屉 */
export function showCompactButton(remote: RemoteEntryApi | undefined): boolean {
  return Boolean(remote?.exitDesk) && !remote?.openDevices;
}

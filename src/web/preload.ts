/** 远程桌面 web-preload：复用桌面 preload 构造 window.electronAPI，再补远端专属能力 */
import '../preload/index';
import { REMOTE_LOCAL_IMAGE_PREFIX_KEY } from '@shared/localImage';
import type { RemoteApi, RemoteBridge } from '@shared/remoteBridge';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { remoteBridge, remoteFrame, uploadToHost } from './electronShim';

// iframe 路径形如 /desk/r/<pairId>/<build>/index.html → 本地图片走 /desk/li/<pairId>/
const match = /^(.*)\/r\/([^/]+)\/[^/]+\/[^/]*$/.exec(location.pathname);
const localImagePrefix = match ? `${match[1]}/li/${match[2]}/` : '/desk/li/_/';
(globalThis as Record<string, unknown>)[REMOTE_LOCAL_IMAGE_PREFIX_KEY] = localImagePrefix;

let leader = remoteBridge.leader();
remoteFrame.on(IPC_CHANNELS.REMOTE_LEADER_CHANGED, (value) => {
  leader = value === true;
});

const remote: RemoteApi = {
  isLeader: () => leader,
  onLeaderChanged: (callback) =>
    remoteFrame.on(IPC_CHANNELS.REMOTE_LEADER_CHANGED, (value) => callback(value === true)),
  upload: uploadToHost,
  localImagePrefix,
  exitDesk: () => remoteBridge.exitDesk(),
  ...(typeof remoteBridge.linkStatus === 'function'
    ? {
        linkStatus: () => remoteBridge.linkStatus(),
        onLinkStatus: (callback: (status: ReturnType<RemoteBridge['linkStatus']>) => void) =>
          remoteBridge.onLinkStatus(callback),
        vapidPublicKey: () => remoteBridge.vapidPublicKey(),
        setPushSubscription: (subscription: Parameters<RemoteBridge['setPushSubscription']>[0]) =>
          remoteBridge.setPushSubscription(subscription),
        setPushPending: (pending: Parameters<RemoteBridge['setPushPending']>[0]) =>
          remoteBridge.setPushPending(pending),
      }
    : {}),
};

(window as unknown as { electronAPI: { remote?: RemoteApi } }).electronAPI.remote = remote;

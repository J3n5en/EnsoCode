/** 远程桌面 web-preload：复用桌面 preload 构造 window.electronAPI，再补远端专属能力 */
import '../preload/index';
import { REMOTE_LOCAL_IMAGE_PREFIX_KEY } from '@shared/localImage';
import type { RemoteApi } from '@shared/remoteBridge';
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

// 只有手机壳提供链路/推送；节点设置窗口没有这组方法，此时保留原来的节点切换器
const { linkStatus, onLinkStatus, vapidPublicKey, setPushSubscription, setPushPending } =
  remoteBridge;

const remote: RemoteApi = {
  isLeader: () => leader,
  onLeaderChanged: (callback) =>
    remoteFrame.on(IPC_CHANNELS.REMOTE_LEADER_CHANGED, (value) => callback(value === true)),
  upload: uploadToHost,
  localImagePrefix,
  exitDesk: () => remoteBridge.exitDesk(),
  ...(linkStatus && onLinkStatus && vapidPublicKey && setPushSubscription && setPushPending
    ? { linkStatus, onLinkStatus, vapidPublicKey, setPushSubscription, setPushPending }
    : {}),
};

(window as unknown as { electronAPI: { remote?: RemoteApi } }).electronAPI.remote = remote;

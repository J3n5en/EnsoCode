import { IPC_CHANNELS } from '@shared/types/ipc';

/** 宿主原生能力或作用于宿主桌面的通道（打开窗口/对话框/定位文件/系统剪贴板等），远端一律不可调 */
const DENIED_PREFIXES = [
  'window:',
  'updater:',
  'dialog:',
  'computer:',
  'browser:',
  'nodes:',
  'node-remote:',
  'config-sync:',
  'app:',
  'notification:',
  'pair:',
  'logs:',
];

const DENIED: ReadonlySet<string> = new Set([
  IPC_CHANNELS.FILES_REVEAL,
  IPC_CHANNELS.FILES_REVEAL_EXTERNAL,
  IPC_CHANNELS.FILES_OPEN,
  IPC_CHANNELS.FILES_OPEN_CONTEXT,
  IPC_CHANNELS.FILES_COPY_PATH,
  IPC_CHANNELS.FILES_COPY_FILE,
  IPC_CHANNELS.PROJECTS_REVEAL,
  IPC_CHANNELS.PROJECTS_OPEN_IN_APPS,
  IPC_CHANNELS.RESOURCES_STORAGE_REVEAL,
  IPC_CHANNELS.DCG_INSTALL,
  IPC_CHANNELS.DCG_UNINSTALL,
  IPC_CHANNELS.DCG_CHECK_UPDATE,
  IPC_CHANNELS.DCG_RULE_STATE,
  IPC_CHANNELS.DCG_RULE_ALLOWED,
  IPC_CHANNELS.DCG_RULE_EXEMPT,
  IPC_CHANNELS.DCG_RULE_REVOKE,
  IPC_CHANNELS.DCG_EXEMPTIONS_LIST,
  IPC_CHANNELS.DCG_EXEMPTIONS_CLEAR,
  IPC_CHANNELS.BOT_OPEN_WORKSPACE,
  IPC_CHANNELS.BOT_ARTIFACT_OPEN,
  IPC_CHANNELS.SETTINGS_DEEP_LINK_CONSUME,
  IPC_CHANNELS.APPEARANCE_USER_CSS_OPEN,
  // 会在宿主桌面弹系统对话框的插件通道；其余插件管理远端与本机同等可用
  IPC_CHANNELS.EXTENSION_PLUGINS_PICK_AND_STAGE,
  IPC_CHANNELS.EXTENSION_PLUGINS_ARTIFACT_SAVE,
  IPC_CHANNELS.EXTENSION_PLUGINS_PICK_PATH,
]);

/** 宿主自身的更新/重启：只有无界面服务端开放（桌面宿主是用户本机，不让远端替它装更新） */
const HOST_CONTROL: ReadonlySet<string> = new Set([
  IPC_CHANNELS.UPDATER_GET_STATE,
  IPC_CHANNELS.UPDATER_CHECK,
  IPC_CHANNELS.UPDATER_DOWNLOAD_UPDATE,
  IPC_CHANNELS.UPDATER_QUIT_AND_INSTALL,
  IPC_CHANNELS.UPDATER_SET_AUTO_UPDATE_ENABLED,
  IPC_CHANNELS.UPDATER_SET_AUTO_RESTART_MODE,
  IPC_CHANNELS.UPDATER_RESTART,
]);

/** leader renderer 才需要的宿主桥接（pair 目录推送）；其余 pair:* 属配对管理，远端不可调 */
const LEADER_ONLY: ReadonlySet<string> = new Set([IPC_CHANNELS.PAIR_CATALOG]);

export function isRemoteChannelAllowed(
  channel: string,
  leader: boolean,
  hostControl = false
): boolean {
  if (HOST_CONTROL.has(channel)) return hostControl;
  if (LEADER_ONLY.has(channel)) return leader;
  if (DENIED.has(channel)) return false;
  return !DENIED_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

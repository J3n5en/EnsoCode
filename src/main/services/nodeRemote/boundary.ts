import { IPC_CHANNELS } from '@shared/types';

/**
 * 远程节点主界面是对方下发的代码，跑在本机进程里。它能请本机 main 代办的只有这里列出的：
 * 节点切换器与配对对话框、所在窗口的控件、打开该节点的设置、上报正在看的会话；参数在此收窄。
 * 节点增删改、本机文件夹、外壳集成、标题栏外观等一律拒绝。
 */

export interface LocalCall {
  channel: string;
  args: unknown[];
}

export interface HostNotification {
  sessionId: string;
  title: string;
  body: string;
}

type Narrow = (args: unknown[]) => unknown[] | null;

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;
const coordinate = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value));
const none: Narrow = () => [];

const menuItems = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 50 &&
  value.every((item) => {
    const { id, label } = (item ?? {}) as { id?: unknown; label?: unknown };
    return text(id) && text(label);
  });

const LOCAL_CALLS = new Map<string, Narrow>([
  [IPC_CHANNELS.NODES_LIST, none],
  [IPC_CHANNELS.NODES_ACTIVE, none],
  [IPC_CHANNELS.NODES_SWITCH, ([target]) => (text(target) ? [target] : null)],
  [IPC_CHANNELS.NODES_PAIR, ([uri]) => (text(uri) ? [uri] : null)],
  [IPC_CHANNELS.WINDOW_MINIMIZE, none],
  [IPC_CHANNELS.WINDOW_MAXIMIZE, none],
  [IPC_CHANNELS.WINDOW_CLOSE, none],
  [IPC_CHANNELS.WINDOW_IS_MAXIMIZED, none],
  [IPC_CHANNELS.WINDOW_IS_FULLSCREEN, none],
  [
    IPC_CHANNELS.WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE,
    ([visible]) => (typeof visible === 'boolean' ? [visible] : null),
  ],
  [
    IPC_CHANNELS.WINDOW_POPUP_MENU,
    ([items, x, y]) => (menuItems(items) && coordinate(x) && coordinate(y) ? [items, x, y] : null),
  ],
  // 深链由 parseSettingsDeepLink 收窄
  [IPC_CHANNELS.WINDOW_OPEN_SETTINGS, ([link]) => [link]],
  [IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION, ([id]) => (id === null || text(id) ? [id] : null)],
]);

/** payload：参数数组的 JSON */
export function parseLocalCall(channel: unknown, payload: unknown): LocalCall | null {
  if (typeof channel !== 'string' || typeof payload !== 'string') return null;
  const narrow = LOCAL_CALLS.get(channel);
  if (!narrow) return null;
  let args: unknown;
  try {
    args = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!Array.isArray(args)) return null;
  const narrowed = narrow(args);
  return narrowed ? { channel, args: narrowed } : null;
}

/** 宿主经隧道转来的系统通知（rpc-event 参数数组的 JSON） */
export function parseHostNotification(payload: string): HostNotification | null {
  let args: unknown;
  try {
    args = JSON.parse(payload);
  } catch {
    return null;
  }
  const value = Array.isArray(args) ? args[0] : null;
  if (!value || typeof value !== 'object') return null;
  const { sessionId, title, body } = value as Record<string, unknown>;
  if (!text(sessionId) || typeof title !== 'string' || typeof body !== 'string') return null;
  return { sessionId, title: title.slice(0, 200), body: body.slice(0, 300) };
}

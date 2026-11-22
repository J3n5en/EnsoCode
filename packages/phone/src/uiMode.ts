import { pickActive, type StoredDevice } from './deviceList';
import { parseSessionId } from './launchSession';

/** 手机版（index）与桌面模式（desk）共用同源 localStorage，记住上次所在界面 */
export type UiMode = 'phone' | 'desk';

export const UI_MODE_KEY = 'enso-phone-ui-mode';
/** 从桌面模式回手机版：带上 mode=phone，启动时据此落盘，避免又被跳回 desk */
export const PHONE_URL = '/?mode=phone';
/** 完整版里点「配对新电脑」：进精简版配对页，配完回完整版；不改记住的模式 */
export const PAIR_FROM_DESK_URL = '/?pair=desk';

/** 精简版启动时取出并抹掉 `?pair=desk` */
export function takePairFromDesk(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get('pair') !== 'desk') return false;
  params.delete('pair');
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  return true;
}

export function loadUiMode(): UiMode {
  return localStorage.getItem(UI_MODE_KEY) === 'desk' ? 'desk' : 'phone';
}

export function saveUiMode(mode: UiMode): void {
  localStorage.setItem(UI_MODE_KEY, mode);
}

export function deskUrl(pairId: string): string {
  return `/desk?device=${encodeURIComponent(pairId)}`;
}

/**
 * index 启动时要跳转的 desk 地址。
 * 显式 `?mode=phone` 留在手机版；通知深链（`?session=`）在桌面模式下带进 desk，不退回精简版。
 */
export function launchTarget(
  search: string,
  mode: UiMode,
  devices: readonly StoredDevice[],
  activeId: string | null
): string | null {
  if (mode !== 'desk') return null;
  const params = new URLSearchParams(search);
  if (params.get('mode') === 'phone' || params.get('pair') === 'desk') return null;
  const device = pickActive(devices, activeId);
  if (!device || device.scope === 'read') return null;
  const session = parseSessionId(params.get('session'));
  const target = new URLSearchParams({ device: device.pairId });
  if (session) target.set('session', session);
  return `/desk?${target}`;
}

import {
  type DeviceStoreDeps,
  deviceStore,
  renameStoredDevice,
  unpairStoredDevice,
} from '../deviceActions';
import type { StoredDevice } from '../deviceList';
import type { PushFailureReason, PushSubscribeResult } from '../push';
import { deskUrl, PAIR_FROM_DESK_URL, PHONE_URL, type UiMode } from '../uiMode';
import { withTimeout } from './launch';

/** 中继上的解绑最多等这么久再离开本页：跳转会掐掉在途请求 */
const REVOKE_WAIT_MS = 3000;

export interface DeskDevicesDeps {
  currentId: string;
  load(): StoredDevice[];
  store?: DeviceStoreDeps;
  /** 离开本页（切电脑、回精简版、去配对） */
  navigate(url: string): void;
  saveUiMode(mode: UiMode): void;
  /** 当前这台改了名：链路状态里的电脑名跟着变 */
  onCurrentLabel(label: string): void;
  /** 取消当前这台前停链，不再往它的存储里写 */
  stopCurrent(): void;
  /** 清这台在完整版壳里的本地副本 */
  forgetDesk(pairId: string): void;
  revokeWaitMs?: number;
}

/** 只读的电脑用不了完整版：切过去落在精简版 */
const targetUrl = (device: StoredDevice) =>
  device.scope === 'read' ? PHONE_URL : deskUrl(device.pairId);

/** 完整版「电脑与通知」抽屉的动作；数据全在手机本地，renderer 拿不到 */
export function createDeskDevices(deps: DeskDevicesDeps) {
  const store = deps.store ?? deviceStore;
  return {
    list: () => deps.load(),
    switchTo(pairId: string): void {
      if (pairId === deps.currentId) return;
      const device = deps.load().find((d) => d.pairId === pairId);
      if (!device) return;
      store.saveActiveDeviceId(pairId);
      deps.navigate(targetUrl(device));
    },
    rename(pairId: string, label: string): void {
      const trimmed = label.trim();
      if (!trimmed) return;
      renameStoredDevice(deps.load(), pairId, trimmed, store.saveDevices);
      if (pairId === deps.currentId) deps.onCurrentLabel(trimmed);
    },
    async unpair(pairId: string): Promise<void> {
      const current = pairId === deps.currentId;
      if (current) deps.stopCurrent();
      const outcome = unpairStoredDevice(deps.load(), pairId, deps.currentId, store);
      deps.forgetDesk(pairId);
      if (!current) return;
      await withTimeout(outcome.revoked, deps.revokeWaitMs ?? REVOKE_WAIT_MS, undefined);
      if (outcome.fallback) {
        deps.navigate(targetUrl(outcome.fallback));
        return;
      }
      deps.saveUiMode('phone');
      deps.navigate(PHONE_URL);
    },
    pairNew: () => deps.navigate(PAIR_FROM_DESK_URL),
    exitDesk: () => deps.navigate(PHONE_URL),
  };
}

export type DeskDevices = ReturnType<typeof createDeskDevices>;

export interface PushPending {
  busy: boolean;
  enabled: boolean;
  error: PushFailureReason | null;
}

export interface DeskPushDeps {
  enabled(): boolean;
  vapidPublicKey(): string | null;
  setPending(pending: PushPending): void;
  /** 申请权限并订阅，成功时已报给桌面 */
  turnOn(key: string): Promise<PushSubscribeResult>;
  turnOff(): void;
}

/** 抽屉里的推送开关：点击发生在壳页面，权限就在壳里申请 */
export async function toggleDeskPush(deps: DeskPushDeps): Promise<void> {
  if (deps.enabled()) {
    deps.turnOff();
    return;
  }
  const key = deps.vapidPublicKey();
  if (!key) return;
  deps.setPending({ busy: true, enabled: true, error: null });
  const result = await deps.turnOn(key);
  deps.setPending(
    result.ok
      ? { busy: false, enabled: true, error: null }
      : { busy: false, enabled: false, error: result.reason }
  );
}

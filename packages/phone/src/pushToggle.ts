import {
  PHONE_PUSH_ENABLED_KEY,
  type PushFailureReason,
  type PushSubscribeResult,
  subscribePush,
  unsubscribePush,
  type WebPushSubscription,
} from './push';

/** 精简版与完整版壳共用的推送开关：订阅在本页申请，结果经各自的链路报给桌面 */

export type PushUplink =
  | { type: 'push-subscribe'; subscription: WebPushSubscription }
  | { type: 'push-unsubscribe' };

export interface PushToggleDeps {
  send(message: PushUplink): void;
  storage: Pick<Storage, 'setItem'>;
  subscribe(key: string): Promise<PushSubscribeResult>;
  unsubscribe(): Promise<void>;
}

export function pushDeps(send: (message: PushUplink) => void): PushToggleDeps {
  return { send, storage: localStorage, subscribe: subscribePush, unsubscribe: unsubscribePush };
}

export function turnPushOff(deps: PushToggleDeps): void {
  deps.storage.setItem(PHONE_PUSH_ENABLED_KEY, 'off');
  deps.send({ type: 'push-unsubscribe' });
  void deps.unsubscribe();
}

export function acceptPushSubscription(
  subscription: WebPushSubscription,
  deps: Pick<PushToggleDeps, 'send' | 'storage'>
): void {
  deps.send({ type: 'push-subscribe', subscription });
  deps.storage.setItem(PHONE_PUSH_ENABLED_KEY, 'on');
}

/** 申请权限并订阅；成功才登记并记住「已开启」 */
export async function turnPushOn(key: string, deps: PushToggleDeps): Promise<PushSubscribeResult> {
  const result = await deps.subscribe(key);
  if (result.ok) acceptPushSubscription(result.subscription, deps);
  return result;
}

export const PUSH_ERROR_TEXT: Record<PushFailureReason, string> = {
  unsupported: '当前浏览器不支持推送。',
  'permission-denied': '通知权限被拒绝，请在浏览器站点设置中允许后重试。',
  'service-unreachable': '无法连接 Google 推送服务（FCM），请检查网络或代理后重试。',
  'subscribe-failed': '订阅失败，请稍后重试。',
};

export interface PushHintInput {
  busy: boolean;
  error: PushFailureReason | null;
  availability: 'ok' | 'needs-install' | 'unsupported';
  connected: boolean;
  configReady: boolean;
}

/** 开关下方的说明，按出现顺序 */
export function pushHints(s: PushHintInput): { text: string; error: boolean }[] {
  const hints: { text: string; error: boolean }[] = [];
  if (s.busy) hints.push({ text: '正在开启…', error: false });
  if (s.error && !s.busy) hints.push({ text: PUSH_ERROR_TEXT[s.error], error: true });
  if (s.availability === 'ok' && s.connected && !s.configReady)
    hints.push({ text: '需先升级桌面端 EnsoCode 才能开启推送。', error: false });
  if (s.availability === 'needs-install')
    hints.push({
      text: 'iOS 需先用分享菜单「添加到主屏幕」，从主屏幕打开后才能开启。',
      error: false,
    });
  if (s.availability === 'unsupported')
    hints.push({ text: '当前浏览器不支持推送。', error: false });
  return hints;
}

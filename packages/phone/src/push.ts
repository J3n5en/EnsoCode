import type { PushSubscriptionJson } from '@enso/pair';

/**
 * Web Push 订阅管理（手机侧）。
 * iOS 只允许「添加到主屏幕」后的 standalone PWA 订阅推送；浏览器标签页里
 * Notification/pushManager 直接缺席，调用方据 isPushSupported 降级提示。
 */

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** SW 常驻注册：通知点击路由依赖它，与是否开启推送无关 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

/** VAPID 公钥是 base64url，applicationServerKey 要原始字节 */
function toServerKey(base64url: string): Uint8Array {
  const padded = base64url + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** 订阅失败原因（UI 据此给出可自救的提示） */
export type PushFailureReason =
  | 'unsupported'
  | 'permission-denied'
  | 'service-unreachable'
  | 'subscribe-failed';

export type PushSubscribeResult =
  | { ok: true; subscription: PushSubscriptionJson }
  | { ok: false; reason: PushFailureReason };

/** 把 subscribe 抛出的 DOMException 归类：AbortError = 推送服务（FCM）不可达 */
export function classifyPushError(errorName: string): PushFailureReason {
  if (errorName === 'AbortError') return 'service-unreachable';
  if (errorName === 'NotAllowedError') return 'permission-denied';
  return 'subscribe-failed';
}

/** 申请权限并订阅；失败返回原因，调用方据此提示 */
export async function subscribePush(vapidPublicKey: string): Promise<PushSubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'permission-denied' };
  const registration = await navigator.serviceWorker.ready;
  try {
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: toServerKey(vapidPublicKey) as BufferSource,
    });
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, reason: 'subscribe-failed' };
    }
    return {
      ok: true,
      subscription: {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      },
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { ok: false, reason: classifyPushError(name) };
  }
}

/** 本地退订（配合上行 push-unsubscribe 使用） */
export async function unsubscribePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {}
}

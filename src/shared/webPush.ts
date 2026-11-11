/**
 * 手机 PWA 的 Web Push。精简版和完整版壳都在这个源站上订，
 * 权限必须在收到点击的那个 window 里申请。
 */

export const PHONE_PUSH_ENABLED_KEY = 'enso-phone-push';

export type PushFailureReason =
  | 'unsupported'
  | 'permission-denied'
  | 'service-unreachable'
  | 'subscribe-failed';

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushSubscribeResult =
  | { ok: true; subscription: WebPushSubscription }
  | { ok: false; reason: PushFailureReason };

function viewStandalone(view: Window): boolean {
  return (
    view.matchMedia('(display-mode: standalone)').matches ||
    (view.navigator as { standalone?: boolean }).standalone === true
  );
}

/** 顶层 PWA 才是 standalone；完整版按钮在 iframe 里，也要认父页面 */
export function isStandalone(): boolean {
  if (viewStandalone(window)) return true;
  try {
    return window.top != null && window.top !== window && viewStandalone(window.top);
  } catch {
    return false;
  }
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushAvailability(): 'ok' | 'needs-install' | 'unsupported' {
  if (isPushSupported()) return 'ok';
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return isIos && !isStandalone() ? 'needs-install' : 'unsupported';
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

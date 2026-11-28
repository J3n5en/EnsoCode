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

interface NativePushBridge {
  readonly push?: boolean;
  subscribePush?(vapidPublicKey: string, gatewayOrigin: string): Promise<PushSubscribeResult>;
  unsubscribePush?(): void;
}

type NativePushGatewayResolver = () => Promise<string | null>;

/** 原生 iOS 壳注入的推送桥接；完整版按钮在 iframe 里时也识别顶层窗口 */
function nativePushBridge(): NativePushBridge | null {
  if (typeof window === 'undefined') return null;
  const readFrom = (view: Window): NativePushBridge | null => {
    const candidate = (view as unknown as { __ensoNative?: NativePushBridge }).__ensoNative;
    if (candidate?.push && typeof candidate.subscribePush === 'function') return candidate;
    return null;
  };
  const selfBridge = readFrom(window);
  if (selfBridge) return selfBridge;
  try {
    if (window.top && window.top !== window) return readFrom(window.top);
  } catch {}
  return null;
}

/** 壳页注册 APNs 网关解析器（按当前连接的中继 `/healthz` 判断是否启用 APNs），同源 iframe 共享 */
export function setNativePushGatewayResolver(resolver: NativePushGatewayResolver | null): void {
  if (typeof window === 'undefined') return;
  (
    window as unknown as { __ensoPushGatewayResolver?: NativePushGatewayResolver | null }
  ).__ensoPushGatewayResolver = resolver;
}

async function resolveNativeGatewayOrigin(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const readResolver = (view: Window): NativePushGatewayResolver | null => {
    const fn = (view as unknown as { __ensoPushGatewayResolver?: NativePushGatewayResolver | null })
      .__ensoPushGatewayResolver;
    return typeof fn === 'function' ? fn : null;
  };
  let resolver = readResolver(window);
  try {
    if (!resolver && window.top && window.top !== window) resolver = readResolver(window.top);
  } catch {}
  if (!resolver) return null;
  try {
    const origin = await resolver();
    return typeof origin === 'string' && origin.startsWith('https://') ? origin : null;
  } catch {
    return null;
  }
}

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
  if (nativePushBridge()) return true;
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
  const native = nativePushBridge();
  if (native?.subscribePush) {
    try {
      const gatewayOrigin = await resolveNativeGatewayOrigin();
      if (!gatewayOrigin) return { ok: false, reason: 'service-unreachable' };
      return await native.subscribePush(vapidPublicKey, gatewayOrigin);
    } catch {
      return { ok: false, reason: 'subscribe-failed' };
    }
  }
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
  const native = nativePushBridge();
  if (native) {
    try {
      native.unsubscribePush?.();
    } catch {}
    return;
  }
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {}
}

import path from 'node:path';
import type { PushSubscriptionJson } from '@enso/pair';
import { app } from '@platform';
import { shouldMuteCoworkerCompletionNotification } from '@shared/coworkerNotification';
import { buildNotificationCopy, type NotificationLocale } from '@shared/notificationCopy';
import { shouldSilenceTurn } from '@shared/secretary/silence';
import type { ApprovalRequestInfo } from '@shared/types/agent';
import webPush from 'web-push';
import { readSettings } from '../ipc/settings';
import { SecureJsonFile } from './secureFile';

/**
 * Web Push 直发（不经中继）：VAPID 密钥对首次生成后落盘，
 * 每台已配对设备最多一份 PushSubscription。载荷走 Web Push 加密（RFC 8291），
 * 正文可以带审批命令、提问原文这类短摘要。
 */

export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
  /** true 表示待处理项（审批/提问）：service worker 据它计角标，不再靠标题文字匹配 */
  pending: boolean;
}

/** 推送语言跟随桌面设置，与系统通知一致 */
function pushLocale(): NotificationLocale {
  const state = (readSettings()?.['enso-settings'] as { state?: { language?: string } } | undefined)
    ?.state;
  return (state?.language ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * 事件 → 推送载荷的纯映射。返回 null 表示该事件不值得推送。
 * 文案与桌面系统通知共用 @shared/notificationCopy：标题带会话名，
 * 回合完成正文带 assistant 摘要，失败正文带错误原文。
 */
export function buildPushPayload(
  event: {
    type: string;
    sessionId?: string;
    identity?: { sessionId?: string };
    request?: Partial<ApprovalRequestInfo>;
    ask?: { question?: string; relay?: unknown };
    error?: string;
    silent?: boolean;
    digest?: { firstUserText?: string; userText?: string; assistantText?: string };
  },
  sessionTitle: string | undefined,
  notifyMainAgentOnly = true,
  muted = false
): PushPayload | null {
  if (shouldMuteCoworkerCompletionNotification(event, notifyMainAgentOnly)) return null;
  // 代审中（reviewing）的审批可能由代审模型直接放行，不打扰真人；
  // 升级为等人决策时会以无 phase 的 approval-request 再发一次
  if (event.type === 'approval-request' && event.request?.phase === 'reviewing') return null;
  // 转给秘书的提问由秘书处理，不打扰真人
  if (event.type === 'ask-request' && event.ask?.relay) return null;
  // 与桌面一致：秘书标记静默、或纯系统注入的回合不打扰用户
  if (
    event.type === 'turn-completed' &&
    (event.silent === true ||
      (event.digest &&
        shouldSilenceTurn(event.digest.userText ?? '', event.digest.assistantText ?? '')))
  ) {
    return null;
  }
  const sessionId = event.identity?.sessionId ?? event.sessionId;
  if (!sessionId) return null;
  if (muted) return null;
  const copy = buildNotificationCopy(event, sessionTitle, pushLocale(), {
    turnDoneSummary: true,
  });
  if (!copy) return null;
  return { title: copy.title, body: copy.body, sessionId, pending: copy.pending };
}

// ── 持久化（与 pairStore 同一套加密姿态）─────────────────────────

interface PushStore {
  vapid?: { publicKey: string; privateKey: string };
  /** pairId → 订阅 */
  subscriptions: Record<string, PushSubscriptionJson>;
}

const pushFile = new SecureJsonFile<PushStore>(
  () => path.join(app.getPath('userData'), 'phone-push.bin'),
  () => ({ subscriptions: {} }),
  (raw) => {
    const parsed = raw && typeof raw === 'object' ? (raw as PushStore) : { subscriptions: {} };
    if (!parsed.subscriptions) parsed.subscriptions = {};
    return parsed;
  }
);

export function pushStoreReady(): Promise<void> {
  return pushFile.ready();
}

function loadStore(): PushStore {
  return pushFile.get();
}

function saveStore(store: PushStore): void {
  void pushFile.set(store);
}

/** VAPID 公钥（手机订阅用）；首次调用生成并持久化密钥对 */
export function getVapidPublicKey(): string {
  const store = loadStore();
  if (!store.vapid) {
    store.vapid = webPush.generateVAPIDKeys();
    saveStore(store);
  }
  return store.vapid.publicKey;
}

export function setPushSubscription(pairId: string, subscription: PushSubscriptionJson): void {
  const store = loadStore();
  store.subscriptions[pairId] = subscription;
  saveStore(store);
}

export function clearPushSubscription(pairId: string): void {
  const store = loadStore();
  if (!(pairId in store.subscriptions)) return;
  delete store.subscriptions[pairId];
  saveStore(store);
}

export function hasPushSubscription(pairId: string): boolean {
  return pairId in loadStore().subscriptions;
}

/** 发送推送；404/410（订阅已失效）时自动清除该设备订阅 */
export async function sendPush(pairId: string, payload: PushPayload): Promise<void> {
  const store = loadStore();
  const subscription = store.subscriptions[pairId];
  if (!subscription || !store.vapid) return;
  try {
    await webPush.sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: {
        subject: 'https://github.com/enso-code',
        publicKey: store.vapid.publicKey,
        privateKey: store.vapid.privateKey,
      },
      // 审批类通知过期没意义，1 小时足够
      TTL: 3600,
    });
    console.log(`[push] sent "${payload.title}" to ${pairId}`);
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      clearPushSubscription(pairId);
      return;
    }
    console.warn('[push] send failed', error);
  }
}

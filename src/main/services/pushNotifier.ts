import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PushSubscriptionJson } from '@enso/pair';
import { app, safeStorage } from 'electron';
import webPush from 'web-push';
import { isSecureStorageAvailable } from './pairStore';

/**
 * Web Push 直发（不经中继）：VAPID 密钥对首次生成后落盘，
 * 每台已配对设备最多一份 PushSubscription。推送载荷只含通用文案 + sessionId
 * ——推送途经 Apple/Google 服务器，消息内容不出加密信道。
 */

export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
}

const PUSH_TITLES: Record<string, string> = {
  'approval-request': '需要审批',
  'ask-request': '等待你的回答',
  'turn-completed': '回合已完成',
  'turn-failed': '回合失败',
};

/**
 * 事件 → 推送载荷的纯映射。返回 null 表示该事件不值得推送。
 * body 用会话标题（不含消息正文），缺标题时退化为「会话」。
 */
export function buildPushPayload(
  event: { type: string; sessionId?: string; identity?: { sessionId?: string } },
  sessionTitle: string | undefined
): PushPayload | null {
  const title = PUSH_TITLES[event.type];
  if (!title) return null;
  const sessionId = event.identity?.sessionId ?? event.sessionId;
  if (!sessionId) return null;
  return { title, body: sessionTitle || '会话', sessionId };
}

// ── 持久化（与 pairStore 同一套 safeStorage 姿态）─────────────────────────

interface PushStore {
  vapid?: { publicKey: string; privateKey: string };
  /** pairId → 订阅 */
  subscriptions: Record<string, PushSubscriptionJson>;
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'phone-push.bin');
}

let cache: PushStore | null = null;

function loadStore(): PushStore {
  if (cache) return cache;
  try {
    const file = storePath();
    if (!existsSync(file)) {
      cache = { subscriptions: {} };
      return cache;
    }
    const raw = readFileSync(file);
    const json = isSecureStorageAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf-8');
    const parsed = JSON.parse(json) as PushStore;
    cache = parsed && typeof parsed === 'object' ? parsed : { subscriptions: {} };
    if (!cache.subscriptions) cache.subscriptions = {};
  } catch {
    cache = { subscriptions: {} };
  }
  return cache;
}

function saveStore(store: PushStore): void {
  cache = store;
  try {
    const file = storePath();
    const json = JSON.stringify(store);
    const data = isSecureStorageAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf-8');
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (error) {
    console.warn('[push] save store failed', error);
  }
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
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      clearPushSubscription(pairId);
      return;
    }
    console.warn('[push] send failed', error);
  }
}

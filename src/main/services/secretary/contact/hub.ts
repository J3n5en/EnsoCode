import { bindCommandCode, type ContactRouteClaim, routeTarget } from '@shared/secretary/contact';
import type { SecretaryContactPollState } from '@shared/types/secretary';
import {
  createTelegramApi,
  type TelegramApi,
  type TelegramMessage,
  type TelegramUpdate,
} from './client';
import { ContactPoller } from './poller';
import { TELEGRAM_GENERAL_TOPIC_ID } from './store';

/**
 * 一个秘书的 Telegram 渠道在 hub 上的样子：hub 只负责「同一个 token 只轮询一次」
 * 和「这条更新归谁」，收到之后的一切仍由秘书自己的渠道处理。
 */
export interface TelegramSubscriber {
  readonly secretaryId: string;
  token(): string;
  /** 这个秘书在当前 bot 上认领的私聊、整群与话题 */
  claims(): ContactRouteClaim[];
  /** 正在等的绑定码；没在绑定时为 null */
  bindCode(): string | null;
  /** 主人的 Telegram 用户 id：没带消息的按钮回调按点按钮的人认秘书 */
  ownerId(): number | undefined;
  /** 有路由或在等绑定码才需要轮询 */
  wantsPolling(): boolean;
  pollOffset(): number;
  savePollOffset(offset: number): void;
  handleUpdate(update: TelegramUpdate): Promise<void>;
  /** 绑定码对不上：给正在等码的秘书各记一次失败 */
  bindFailure(code: string): void;
  /** 私聊里发了不带码的 /start：正在等码的秘书据此提示用户，而不是一直等 */
  bindNotice?(reason: 'missing-code'): void;
  /** 哪个秘书都没认领：不响应，只记审计 */
  rejectUnrouted(update: TelegramUpdate): void;
  /** 路由之前每个订阅者都看一眼：记下见过的论坛话题名，不管最后归谁 */
  observe?(message: TelegramMessage): void;
  onPollStatus(): void;
}

interface Connection {
  token: string;
  poller: ContactPoller;
  api: TelegramApi;
  subscribers: Set<TelegramSubscriber>;
}

export interface TelegramHubPorts {
  /** 测试注入假 API；生产按 token 现建 */
  api?(token: string): TelegramApi | undefined;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  onError?(error: unknown): void;
}

function messageOf(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.callback_query?.message;
}

/** 只认论坛话题：普通超级群的回复串也带 message_thread_id，但发不进去 */
export function telegramTopicOf(message: TelegramMessage): string | undefined {
  const thread = message.message_thread_id;
  if (thread === undefined || !Number.isInteger(thread)) return undefined;
  return message.is_topic_message || message.chat.is_forum ? String(thread) : undefined;
}

/** 论坛的 General 不带 message_thread_id：路由匹配时记为话题 1，单独绑了 General 也能命中 */
export function telegramRouteTopicOf(message: TelegramMessage): string | undefined {
  return (
    telegramTopicOf(message) ?? (message.chat.is_forum ? TELEGRAM_GENERAL_TOPIC_ID : undefined)
  );
}

/**
 * Telegram 连接中心：同一个 token 全局只有一个 getUpdates 长轮询，不管几个秘书在用；
 * 不同 token 各一个。更新按 bot + chat + 话题路由给认领它的秘书，没人认领就不响应。
 */
export class TelegramHub {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly ports: TelegramHubPorts) {}

  /** 这个 token 的 API：发消息等请求也算连通性信号，与轮询共用一个状态 */
  apiFor(token: string): TelegramApi {
    return this.connection(token).api;
  }

  status(token: string): { state: SecretaryContactPollState; lastError?: string } {
    const connection = token ? this.connections.get(token) : undefined;
    return connection ? connection.poller.status() : { state: 'stopped' };
  }

  /** 订阅者的 token、路由或绑定状态变了：按需开关轮询 */
  sync(subscriber: TelegramSubscriber): void {
    for (const connection of this.connections.values()) {
      if (connection.token !== subscriber.token()) connection.subscribers.delete(subscriber);
    }
    const token = subscriber.token();
    if (token && subscriber.wantsPolling()) {
      this.connection(token).subscribers.add(subscriber);
    } else if (token) {
      this.connections.get(token)?.subscribers.delete(subscriber);
    }
    void this.reconcile();
  }

  detach(subscriber: TelegramSubscriber): Promise<void> {
    for (const connection of this.connections.values()) connection.subscribers.delete(subscriber);
    return this.reconcile();
  }

  /** 在跑的轮询数：一个 token 一个 */
  pollingTokens(): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      const state = connection.poller.status().state;
      if (state !== 'stopped' && state !== 'error') count += 1;
    }
    return count;
  }

  async stopAll(): Promise<void> {
    for (const connection of this.connections.values()) connection.subscribers.clear();
    await this.reconcile();
  }

  private connection(token: string): Connection {
    const existing = this.connections.get(token);
    if (existing) return existing;
    const subscribers = new Set<TelegramSubscriber>();
    const poller: ContactPoller = new ContactPoller({
      api: () => (this.connections.get(token) ? api : null),
      // 游标存在各秘书自己的 contact.json：取最大的，写的时候每个订阅者都写
      offset: () => Math.max(0, ...[...subscribers].map((subscriber) => subscriber.pollOffset())),
      setOffset: (offset) => {
        for (const subscriber of subscribers) subscriber.savePollOffset(offset);
      },
      onUpdate: (update) => this.route(subscribers, update),
      onStatus: () => {
        for (const subscriber of subscribers) subscriber.onPollStatus();
      },
      onError: (error) => this.ports.onError?.(error),
      sleep: this.ports.sleep,
    });
    const raw = this.ports.api?.(token) ?? createTelegramApi(token);
    const api = tracked(raw, poller);
    const connection: Connection = { token, poller, api, subscribers };
    this.connections.set(token, connection);
    return connection;
  }

  private async reconcile(): Promise<void> {
    for (const connection of this.connections.values()) {
      if (connection.subscribers.size > 0) connection.poller.start();
      else await connection.poller.stop();
    }
  }

  private async route(
    subscribers: ReadonlySet<TelegramSubscriber>,
    update: TelegramUpdate
  ): Promise<void> {
    const list = [...subscribers];
    const text = update.message?.text?.trim();
    const code = text ? bindCommandCode(text) : null;
    if (
      !code &&
      text &&
      update.message?.chat.type === 'private' &&
      /^\/start(?:@\w+)?$/u.test(text)
    ) {
      for (const subscriber of list) {
        if (subscriber.bindCode() !== null) subscriber.bindNotice?.('missing-code');
      }
    }
    if (code) {
      const owner = list.find((subscriber) => subscriber.bindCode() === code);
      if (owner) {
        await owner.handleUpdate(update);
        return;
      }
      const waiting = list.filter((subscriber) => subscriber.bindCode() !== null);
      if (waiting.length > 0) {
        for (const subscriber of waiting) subscriber.bindFailure(code);
        return;
      }
    }
    const message = messageOf(update);
    if (!message) {
      // 太旧的按钮回调不带原消息：先认绑了这个人私聊的秘书，再按主人认，认不出就交给唯一的订阅者
      const fromId = update.callback_query?.from?.id;
      const owner =
        (fromId !== undefined
          ? (list.find((candidate) =>
              candidate
                .claims()
                .some((claim) => claim.chatId === String(fromId) && claim.topicId === undefined)
            ) ?? list.find((candidate) => candidate.ownerId() === fromId))
          : undefined) ?? (list.length === 1 ? list[0] : undefined);
      if (owner && update.callback_query) await owner.handleUpdate(update);
      return;
    }
    for (const candidate of list) candidate.observe?.(message);
    // 同一个连接上的订阅者用的是同一个 bot：这里只按 chat + 话题分
    const claims = list.flatMap((subscriber) =>
      subscriber.claims().map((claim) => ({ ...claim, botId: 0 }))
    );
    const target = routeTarget(claims, 0, String(message.chat.id), telegramRouteTopicOf(message));
    const subscriber = target ? list.find((candidate) => candidate.secretaryId === target) : null;
    if (subscriber) {
      await subscriber.handleUpdate(update);
      return;
    }
    // 哪个秘书都没绑这里：完全不响应，各秘书的审计里留一笔
    for (const candidate of list) candidate.rejectUnrouted(update);
  }
}

/** 轮询以外的请求结果交给轮询器判断连通性；getUpdates 由轮询器自己管 */
function tracked(api: TelegramApi, poller: ContactPoller): TelegramApi {
  return new Proxy(api, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key === 'getUpdates' || typeof value !== 'function') return value;
      return (...args: unknown[]) => poller.track(() => value.apply(target, args));
    },
  });
}

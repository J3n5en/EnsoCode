/**
 * Telegram Bot API 的最小客户端：只做联系方式要用的四个方法。
 * 走全局 fetch，因此复用应用现有的代理设置（proxyConfig 装的是全局 dispatcher）；
 * 连不上时统一报 'network'，由界面翻成「连不上 api.telegram.org，检查代理」。
 */

export type TelegramFailureKind = 'network' | 'unauthorized' | 'api';

export class TelegramApiError extends Error {
  constructor(
    readonly kind: TelegramFailureKind,
    message: string
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
  username?: string;
  title?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

export interface TelegramApi {
  getMe(): Promise<TelegramUser>;
  getUpdates(params: {
    offset?: number;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  sendMessage(params: {
    chatId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboard;
    /** 命令回复用 HTML：正文由调用方转义，避免特殊字符发不出去 */
    parseMode?: 'HTML';
  }): Promise<number>;
  /** 翻页时原地换掉这一条，不刷屏 */
  editMessageText(params: {
    chatId: number;
    messageId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboard;
    parseMode?: 'HTML';
  }): Promise<void>;
  /** 命令菜单：只登记当前可用的命令 */
  setMyCommands(commands: { command: string; description: string }[]): Promise<void>;
  answerCallbackQuery(params: { callbackQueryId: string; text?: string }): Promise<void>;
}

/** 测试与真机验收用假服务替换；生产不设这个变量 */
export function telegramApiBase(): string {
  const override = process.env.ENSO_TELEGRAM_API_BASE?.trim();
  return (override || 'https://api.telegram.org').replace(/\/+$/, '');
}

type ApiEnvelope<T> = { ok: boolean; result?: T; description?: string; error_code?: number };

const REQUEST_TIMEOUT_MS = 15_000;
/** 长轮询要等 25 秒，超时必须比它长，否则每轮都被自己掐断 */
const LONG_POLL_TIMEOUT_MS = 40_000;

async function request<T>(
  base: string,
  token: string,
  method: string,
  body: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let response: Response;
  try {
    response = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch (error) {
    // 代理不通、DNS 失败、被 abort 都归到这一类：调用方只需要知道「连不上」
    throw new TelegramApiError('network', error instanceof Error ? error.message : 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new TelegramApiError('api', `http ${response.status}`);
  }
  if (envelope.ok) return envelope.result as T;
  const description = envelope.description ?? `http ${response.status}`;
  if (response.status === 401 || response.status === 403 || envelope.error_code === 401) {
    throw new TelegramApiError('unauthorized', description);
  }
  throw new TelegramApiError('api', description);
}

export function createTelegramApi(token: string, base = telegramApiBase()): TelegramApi {
  return {
    getMe: () => request<TelegramUser>(base, token, 'getMe', undefined),
    getUpdates: ({ offset, timeout, signal }) =>
      request<TelegramUpdate[]>(
        base,
        token,
        'getUpdates',
        { offset, timeout: timeout ?? 0, allowed_updates: ['message', 'callback_query'] },
        signal,
        LONG_POLL_TIMEOUT_MS
      ),
    sendMessage: async ({ chatId, text, replyMarkup, parseMode }) => {
      const sent = await request<TelegramMessage>(base, token, 'sendMessage', {
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      return sent.message_id;
    },
    editMessageText: async ({ chatId, messageId, text, replyMarkup, parseMode }) => {
      await request<unknown>(base, token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
    },
    setMyCommands: async (commands) => {
      await request<boolean>(base, token, 'setMyCommands', { commands });
    },
    answerCallbackQuery: async ({ callbackQueryId, text }) => {
      await request<boolean>(base, token, 'answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      });
    },
  };
}

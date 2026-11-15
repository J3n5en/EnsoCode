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
  /** 秒级时间戳 */
  date?: number;
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

/**
 * 一个按钮要么带 callback_data（点了回机器人），要么带 url（Telegram 自己打开）。
 * url 只认 http(s) 与 tg://：别的 scheme 会被 BUTTON_URL_INVALID 整条拒掉。
 */
export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

/**
 * 命令的作用范围。chat 只对绑定的那个私聊生效；
 * 注意 Telegram 不支持给 chat scope 单独指定 language_code。
 */
export type TelegramCommandScope =
  | { type: 'default' }
  | { type: 'all_private_chats' }
  | { type: 'chat'; chat_id: number };

export interface TelegramCommandOptions {
  scope?: TelegramCommandScope;
  languageCode?: string;
}

export interface TelegramMenuButton {
  type: 'default' | 'commands';
}

export interface TelegramApi {
  getMe(): Promise<TelegramUser>;
  getUpdates(params: {
    offset?: number;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  /**
   * 「正在输入…」：Telegram 侧只亮约 5 秒，要一直显示得由调用方续发。
   * 没有返回值，失败照样抛 TelegramApiError。
   */
  sendChatAction(params: { chatId: number; action: 'typing' }): Promise<void>;
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
  /** 只换按钮不动正文：正文改不动时至少把按钮清掉 */
  editMessageReplyMarkup(params: {
    chatId: number;
    messageId: number;
    replyMarkup: TelegramInlineKeyboard;
  }): Promise<void>;
  /** 命令菜单：只登记当前可用的命令 */
  setMyCommands(
    commands: { command: string; description: string }[],
    options?: TelegramCommandOptions
  ): Promise<void>;
  deleteMyCommands(options?: TelegramCommandOptions): Promise<void>;
  /** 左下角菜单按钮：commands 才会弹出命令面板 */
  setChatMenuButton(menuButton: TelegramMenuButton): Promise<void>;
  answerCallbackQuery(params: { callbackQueryId: string; text?: string }): Promise<void>;
}

/** 测试与真机验收用假服务替换；生产不设这个变量 */
export function telegramApiBase(): string {
  const override = process.env.ENSO_TELEGRAM_API_BASE?.trim();
  return (override || 'https://api.telegram.org').replace(/\/+$/, '');
}

/** scope 与 language_code 只在给了的时候才带上 */
function scopeBody(options?: TelegramCommandOptions): Record<string, unknown> {
  if (!options) return {};
  return {
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.languageCode ? { language_code: options.languageCode } : {}),
  };
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
    sendChatAction: async ({ chatId, action }) => {
      await request<boolean>(base, token, 'sendChatAction', { chat_id: chatId, action });
    },
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
    editMessageReplyMarkup: async ({ chatId, messageId, replyMarkup }) => {
      await request<unknown>(base, token, 'editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      });
    },
    setMyCommands: async (commands, options) => {
      await request<boolean>(base, token, 'setMyCommands', {
        commands,
        ...scopeBody(options),
      });
    },
    deleteMyCommands: async (options) => {
      await request<boolean>(base, token, 'deleteMyCommands', scopeBody(options));
    },
    setChatMenuButton: async (menuButton) => {
      await request<boolean>(base, token, 'setChatMenuButton', { menu_button: menuButton });
    },
    answerCallbackQuery: async ({ callbackQueryId, text }) => {
      await request<boolean>(base, token, 'answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      });
    },
  };
}

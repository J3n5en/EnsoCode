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
  /** 超级群开了论坛话题 */
  is_forum?: boolean;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  /** 图片、文件附带的说明文字 */
  caption?: string;
  /** 压缩过的图片：同一张的多个尺寸，最后一个最大 */
  photo?: TelegramPhotoSize[];
  /** 原图或别的文件 */
  document?: TelegramDocument;
  video?: unknown;
  voice?: unknown;
  audio?: unknown;
  animation?: unknown;
  video_note?: unknown;
  sticker?: unknown;
  /** 秒级时间戳 */
  date?: number;
  /** 论坛话题 id；普通超级群里回复串也会带，要配合 is_topic_message 看 */
  message_thread_id?: number;
  is_topic_message?: boolean;
  /** 话题里的消息回复的是建话题那条服务消息：从这里读话题名 */
  reply_to_message?: TelegramMessage;
  forum_topic_created?: { name?: string };
  forum_topic_edited?: { name?: string };
}

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
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

/** sendPhoto / sendDocument 的 multipart 上传；threadId 回到原话题 */
export interface TelegramUpload {
  chatId: number;
  threadId?: number;
  data: Buffer;
  fileName: string;
  mimeType?: string;
  caption?: string;
}

export interface TelegramApi {
  getMe(): Promise<TelegramUser>;
  /** 绑群前确认 bot 在群里、群是否开了论坛话题 */
  getChat(chatId: number): Promise<TelegramChat>;
  getUpdates(params: {
    offset?: number;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  /**
   * 「正在输入…」：Telegram 侧只亮约 5 秒，要一直显示得由调用方续发。
   * 没有返回值，失败照样抛 TelegramApiError。
   */
  sendChatAction(params: {
    chatId: number;
    action: 'typing';
    messageThreadId?: number;
  }): Promise<void>;
  sendMessage(params: {
    chatId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboard;
    /** 命令回复用 HTML：正文由调用方转义，避免特殊字符发不出去 */
    parseMode?: 'HTML';
    /** 发进论坛话题；缺省进群的 General */
    messageThreadId?: number;
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
  /** 图片：multipart 上传，≤10MB，宽高之和 ≤10000，caption ≤1024 */
  sendPhoto(params: TelegramUpload): Promise<number>;
  /** 文件：multipart 上传，≤50MB，caption ≤1024 */
  sendDocument(params: TelegramUpload): Promise<number>;
  /** 下载对方发来的文件；超过 maxBytes 返回 'too-large'，不读进内存 */
  downloadFile(fileId: string, maxBytes: number): Promise<Buffer | 'too-large'>;
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
/** 上传 10MB 走代理可能很慢 */
const UPLOAD_TIMEOUT_MS = 120_000;

async function download(
  base: string,
  token: string,
  filePath: string,
  maxBytes: number
): Promise<Buffer | 'too-large'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/file/bot${token}/${filePath}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new TelegramApiError('api', `http ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      return 'too-large';
    }
    const data = Buffer.from(await response.arrayBuffer());
    return data.length > maxBytes ? 'too-large' : data;
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    throw new TelegramApiError('network', error instanceof Error ? error.message : 'network');
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(
  base: string,
  token: string,
  method: string,
  body: Record<string, unknown> | FormData | undefined,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let response: Response;
  try {
    // FormData 由 fetch 自己写 multipart 边界，不能手动设 Content-Type
    response = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      ...(body instanceof FormData
        ? { body }
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
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

function uploadForm(field: 'photo' | 'document', params: TelegramUpload): FormData {
  const form = new FormData();
  form.set('chat_id', String(params.chatId));
  if (params.threadId !== undefined) form.set('message_thread_id', String(params.threadId));
  if (params.caption) form.set('caption', params.caption);
  const blob = new Blob([new Uint8Array(params.data)], {
    type: params.mimeType ?? 'application/octet-stream',
  });
  form.set(field, blob, params.fileName);
  return form;
}

export function createTelegramApi(token: string, base = telegramApiBase()): TelegramApi {
  const upload = async (
    method: 'sendPhoto' | 'sendDocument',
    field: 'photo' | 'document',
    params: TelegramUpload
  ): Promise<number> => {
    const sent = await request<TelegramMessage>(
      base,
      token,
      method,
      uploadForm(field, params),
      undefined,
      UPLOAD_TIMEOUT_MS
    );
    return sent.message_id;
  };
  return {
    getMe: () => request<TelegramUser>(base, token, 'getMe', undefined),
    getChat: (chatId) => request<TelegramChat>(base, token, 'getChat', { chat_id: chatId }),
    getUpdates: ({ offset, timeout, signal }) =>
      request<TelegramUpdate[]>(
        base,
        token,
        'getUpdates',
        { offset, timeout: timeout ?? 0, allowed_updates: ['message', 'callback_query'] },
        signal,
        LONG_POLL_TIMEOUT_MS
      ),
    sendChatAction: async ({ chatId, action, messageThreadId }) => {
      await request<boolean>(base, token, 'sendChatAction', {
        chat_id: chatId,
        action,
        ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
      });
    },
    sendMessage: async ({ chatId, text, replyMarkup, parseMode, messageThreadId }) => {
      const sent = await request<TelegramMessage>(base, token, 'sendMessage', {
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
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
    sendPhoto: (params) => upload('sendPhoto', 'photo', params),
    sendDocument: (params) => upload('sendDocument', 'document', params),
    downloadFile: async (fileId, maxBytes) => {
      const file = await request<{ file_path?: string; file_size?: number }>(
        base,
        token,
        'getFile',
        { file_id: fileId }
      );
      if (file.file_size !== undefined && file.file_size > maxBytes) return 'too-large';
      if (!file.file_path) throw new TelegramApiError('api', 'no file_path');
      return download(base, token, file.file_path, maxBytes);
    },
  };
}

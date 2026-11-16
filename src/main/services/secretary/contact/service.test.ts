import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { telegramUrlButtonSupported } from '@shared/secretary/contact';
import type { FeedCursor } from '@shared/secretary/feed';
import { parseInboundMessage } from '@shared/secretary/inbound';
import type { SecretaryAuditEntry, SecretaryProfile } from '@shared/types/secretary';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowingStore } from '../following';
import type { ChannelCaps, ChannelMessage, ContactChannel } from './channel';
import type {
  TelegramApi,
  TelegramCommandOptions,
  TelegramInlineKeyboard,
  TelegramMenuButton,
  TelegramUpdate,
  TelegramUser,
} from './client';
import { TelegramApiError } from './client';
import { ContactService, type ContactServicePorts } from './service';
import { ContactStore } from './store';
import { deliverToSecretary } from './wake';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

/** 假 Telegram：不碰网络，更新由用例 push，出站全部记下来 */
class FakeApi implements TelegramApi {
  sent: {
    chatId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboard;
    parseMode?: 'HTML';
  }[] = [];
  edited: {
    chatId: number;
    messageId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboard;
    parseMode?: 'HTML';
  }[] = [];
  /** 只换按钮不动正文的那些调用 */
  markupEdits: {
    chatId: number;
    messageId: number;
    replyMarkup: TelegramInlineKeyboard;
  }[] = [];
  /** 每次 setMyCommands 连同 scope/language_code 一起记下来 */
  commands: {
    commands: { command: string; description: string }[];
    options?: TelegramCommandOptions;
  }[] = [];
  deleted: (TelegramCommandOptions | undefined)[] = [];
  menuButtons: TelegramMenuButton[] = [];
  callbacks: { callbackQueryId: string; text?: string }[] = [];
  /** 「正在输入…」：只记 chat 与 action */
  chatActions: { chatId: number; action: 'typing' }[] = [];
  polls = 0;
  /** 菜单接口失败时用 */
  menuError: Error | null = null;
  /** sendChatAction 失败时用 */
  typingError: Error | null = null;
  /** 带 parse_mode 的发送一律报解析错误，用来看降级 */
  rejectHtml = false;
  /** 正文改不动：editMessageText 报错，用来看是否退到只清按钮 */
  editTextError: Error | null = null;
  /** 连按钮都清不掉：消息被删或太旧 */
  markupError: Error | null = null;
  me: TelegramUser = { id: 42, username: 'enso_secretary_bot', first_name: 'Enso' };
  meError: Error | null = null;
  private queue: TelegramUpdate[] = [];
  private waiter: ((updates: TelegramUpdate[]) => void) | null = null;

  push(update: TelegramUpdate): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter([update]);
      return;
    }
    this.queue.push(update);
  }

  async getMe(): Promise<TelegramUser> {
    if (this.meError) throw this.meError;
    return this.me;
  }

  getUpdates(params: { signal?: AbortSignal }): Promise<TelegramUpdate[]> {
    this.polls += 1;
    if (this.queue.length > 0) return Promise.resolve(this.queue.splice(0));
    return new Promise((resolve) => {
      this.waiter = resolve;
      params.signal?.addEventListener('abort', () => resolve([]), { once: true });
    });
  }

  async sendMessage(params: {
    chatId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboard;
    parseMode?: 'HTML';
  }): Promise<number> {
    if (this.rejectHtml && params.parseMode) {
      throw new TelegramApiError('api', "Bad Request: can't parse entities");
    }
    this.check(params.text, params.replyMarkup);
    this.sent.push(params);
    return this.sent.length;
  }

  async editMessageText(params: {
    chatId: number;
    messageId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboard;
    parseMode?: 'HTML';
  }): Promise<void> {
    if (this.editTextError) throw this.editTextError;
    this.check(params.text, params.replyMarkup);
    this.edited.push(params);
  }

  async editMessageReplyMarkup(params: {
    chatId: number;
    messageId: number;
    replyMarkup: TelegramInlineKeyboard;
  }): Promise<void> {
    if (this.markupError) throw this.markupError;
    this.check(undefined, params.replyMarkup);
    this.markupEdits.push(params);
  }

  /**
   * 照 Telegram 的规则校验：正文 4096、callback_data 64 字节、
   * url 只认 http(s) 与 tg://（enso:// 会被整条拒掉）。
   */
  private check(text: string | undefined, markup?: TelegramInlineKeyboard): void {
    if (text !== undefined && text.length > 4096) {
      throw new TelegramApiError('api', 'Bad Request: message is too long');
    }
    for (const row of markup?.inline_keyboard ?? []) {
      for (const button of row) {
        if (button.callback_data === undefined && button.url === undefined) {
          throw new TelegramApiError('api', 'Bad Request: BUTTON_DATA_INVALID');
        }
        if (button.callback_data !== undefined && Buffer.byteLength(button.callback_data) > 64) {
          throw new TelegramApiError('api', 'Bad Request: BUTTON_DATA_INVALID');
        }
        if (button.url !== undefined && !telegramUrlButtonSupported(button.url)) {
          throw new TelegramApiError('api', 'Bad Request: BUTTON_URL_INVALID');
        }
      }
    }
  }

  async sendChatAction(params: { chatId: number; action: 'typing' }): Promise<void> {
    if (this.typingError) throw this.typingError;
    this.chatActions.push(params);
  }

  async setMyCommands(
    commands: { command: string; description: string }[],
    options?: TelegramCommandOptions
  ): Promise<void> {
    if (this.menuError) throw this.menuError;
    this.commands.push({ commands, options });
  }

  async deleteMyCommands(options?: TelegramCommandOptions): Promise<void> {
    if (this.menuError) throw this.menuError;
    this.deleted.push(options);
  }

  async setChatMenuButton(menuButton: TelegramMenuButton): Promise<void> {
    if (this.menuError) throw this.menuError;
    this.menuButtons.push(menuButton);
  }

  /** 最近一次注册里某 scope 的命令名 */
  menuNames(pick: (options?: TelegramCommandOptions) => boolean): string[] {
    const entry = [...this.commands].reverse().find((call) => pick(call.options));
    return entry?.commands.map((command) => command.command) ?? [];
  }

  async answerCallbackQuery(params: { callbackQueryId: string; text?: string }): Promise<void> {
    this.callbacks.push(params);
  }
}

const dirs: string[] = [];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-contact-'));
  dirs.push(dir);
  const store = new ContactStore(dir);
  const following = new FollowingStore(dir);
  const api = new FakeApi();
  const audits: SecretaryAuditEntry[] = [];
  const clock = { now: 1_000_000 };
  const world = {
    mode: 'with-done' as SecretaryProfile['notify'],
    /** 手机命令读到的假数据 */
    statusText: '进行中 1\n▸ 修登录',
    memoryText: '秘书记得 1\n▸ 部署窗口',
    feedPages: [] as string[],
    memoryAllowed: false,
    commandCalls: [] as string[],
    conversationId: 'sec-1' as string | null,
    delivered: [] as string[],
    answers: [] as { requestId: string; answer: string }[],
    answerOk: true,
    deliverOk: true,
    proposalOk: true,
    resolved: [] as { proposalId: string; action: 'confirm' | 'reject' }[],
    opened: [] as { conversationId?: string; proposalId?: string }[],
    /** /last 读到的秘书会话消息 */
    recap: [] as { role: 'user' | 'assistant'; text: string }[],
    recapCalls: [] as number[],
    name: '爱酱',
  };
  const ports: ContactServicePorts = {
    audit: (entry) => audits.push(entry),
    publish: () => {},
    now: () => clock.now,
    random: () => 0.123456,
    lang: () => 'zh',
    notifyMode: () => world.mode,
    secretaryName: () => world.name,
    secretaryConversationId: () => world.conversationId,
    recentTurns: async (rounds) => {
      world.recapCalls.push(rounds);
      return world.recap;
    },
    deliver: async (_id, text) => {
      world.delivered.push(text);
      return world.deliverOk ? { ok: true } : { ok: false, error: 'stale-session' };
    },
    answerAsk: (_id, requestId, answer) => {
      if (!world.answerOk) return { ok: false, error: 'no-such-ask' };
      world.answers.push({ requestId, answer });
      return { ok: true };
    },
    resolveProposal: async (proposalId, action) => {
      if (!world.proposalOk) return { ok: false, error: 'not-found' };
      world.resolved.push({ proposalId, action });
      return { ok: true };
    },
    openInApp: (target) => {
      world.opened.push(target);
    },
    following,
    api: () => api,
    commands: {
      run: async (name) => {
        world.commandCalls.push(name);
        if (name === 'memory') {
          return {
            text: store.file().allowMemory ? world.memoryText : '记忆标题默认不在 Telegram 显示。',
          };
        }
        if (name === 'feed') {
          return {
            text: world.feedPages[0] ?? '最近动态',
            next: { at: 10, id: 'e1' } as FeedCursor,
          };
        }
        return { text: world.statusText };
      },
      feedPage: async (before) => {
        world.commandCalls.push(`feed:${before.id}`);
        return { text: world.feedPages[1] ?? '更早的动态' };
      },
    },
  };
  const service = new ContactService(store, ports);
  return {
    dir,
    store,
    following,
    ports,
    api,
    audits,
    clock,
    world,
    service,
    /** 模拟重启：新的 store 从磁盘读，新的服务没有内存态 */
    restart: () => new ContactService(new ContactStore(dir), ports),
  };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function privateMessage(text: string, chatId = 777): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, username: 'j3n5en', first_name: 'J' },
      text,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('token 校验', () => {
  it('形状不对当场拒绝，不发网络请求也不落盘', async () => {
    const h = harness();
    const result = await h.service.bind('not-a-token');
    expect(result).toEqual({ ok: false, error: 'token-invalid' });
    expect(h.api.polls).toBe(0);
    expect(h.store.token()).toBe('');
    expect(h.service.state().telegram.status).toBe('unbound');
  });

  it('getMe 失败时报错，界面拿得到错误码', async () => {
    const h = harness();
    h.api.meError = new Error('boom');
    const result = await h.service.bind(TOKEN);
    expect(result).toEqual({ ok: false, error: 'api' });
    expect(h.service.state().telegram.status).toBe('unbound');
  });

  it('通过 getMe 后显示 bot 名字与 @username，token 只留前几位', async () => {
    const h = harness();
    expect(await h.service.bind(TOKEN)).toEqual({ ok: true });
    const telegram = h.service.state().telegram;
    expect(telegram.status).toBe('awaiting-start');
    expect(telegram.bot).toEqual({ id: 42, username: 'enso_secretary_bot', name: 'Enso' });
    expect(telegram.tokenHint).toBe('123456789:AA…');
    expect(JSON.stringify(telegram)).not.toContain('HdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  });
});

describe('绑定码', () => {
  it('给出 6 位码与 t.me 深链', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    const bind = h.service.state().telegram.bind;
    expect(bind?.code).toBe('123456');
    expect(bind?.link).toBe('https://t.me/enso_secretary_bot?start=123456');
    expect(bind?.expiresAt).toBe(h.clock.now + 10 * 60 * 1000);
  });

  it('码对不上就忽略，不绑任何人', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 000000'));
    await waitFor(() => h.audits.some((entry) => entry.op === 'contact_bind_rejected'), 'rejected');
    expect(h.service.state().telegram.status).toBe('awaiting-start');
    expect(h.audits.find((entry) => entry.op === 'contact_bind_rejected')?.detail).toBe(
      'code-mismatch'
    );
  });

  it('码过期后不再接受，要求重新生成', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.clock.now += 10 * 60 * 1000 + 1;
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.audits.some((entry) => entry.op === 'contact_bind_rejected'), 'rejected');
    expect(h.service.state().telegram.status).toBe('awaiting-start');
    // 重新生成：同一个 bot 换一个新码
    h.clock.now += 1;
    expect(await h.service.regenerate()).toEqual({ ok: true });
    expect(h.service.state().telegram.bind?.expiresAt).toBe(h.clock.now + 10 * 60 * 1000);
  });

  it('对不上太多次就作废这个码，要求重新生成', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      h.api.push(privateMessage(`/start 00000${attempt}`));
      await waitFor(
        () => h.audits.filter((entry) => entry.op === 'contact_bind_rejected').length > attempt,
        `rejected ${attempt}`
      );
    }
    const telegram = h.service.state().telegram;
    expect(telegram.bind).toBeUndefined();
    expect(telegram.status).toBe('unbound');
    expect(h.audits.at(-1)?.detail).toBe('too-many-attempts');
    // bot 与 token 留着：界面上直接重新生成
    expect(telegram.bot?.username).toBe('enso_secretary_bot');
  });

  it('群里的 /start 不算，只认私聊', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push({
      update_id: 1,
      message: { message_id: 1, chat: { id: -100, type: 'group' }, text: '/start 123456' },
    });
    await waitFor(() => h.audits.some((entry) => entry.op === 'contact_bind_rejected'), 'rejected');
    expect(h.audits.find((entry) => entry.op === 'contact_bind_rejected')?.detail).toBe(
      'not-private'
    );
    expect(h.service.state().telegram.status).toBe('awaiting-start');
  });

  it('对上了就绑定，并给用户发一条欢迎消息', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    const telegram = h.service.state().telegram;
    expect(telegram.chat).toEqual({ id: 777, username: 'j3n5en', name: 'J' });
    expect(telegram.bind).toBeUndefined();
    expect(h.api.sent.at(-1)?.chatId).toBe(777);
    expect(h.api.sent.at(-1)?.text).toContain('已连上 Enso');
  });
});

describe('入站只认绑定的 chat', () => {
  it('别的 chat 发什么都不进秘书会话，只记审计', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.api.push(privateMessage('把登录修一下', 999));
    await waitFor(
      () => h.audits.some((entry) => entry.detail === 'foreign-chat'),
      'foreign chat rejected'
    );
    expect(h.world.delivered).toHaveLength(0);
  });

  it('绑定的 chat 发来的话进秘书会话，标注来自 Telegram 并包成不可信内容', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.api.push(privateMessage('把登录修一下'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    const body = h.world.delivered[0];
    expect(body).toContain('[来自 Telegram @j3n5en]');
    expect(body).toContain(
      '<untrusted-content source="telegram:@j3n5en">把登录修一下</untrusted-content>'
    );
    // 审计只记长度与 hash，不记正文
    const inbound = h.audits.find((entry) => entry.op === 'contact_inbound');
    expect(inbound?.detail).toMatch(/^len=\d+ hash=[0-9a-f]{12}$/);
    // 记下投到哪个秘书会话：排查「手机说的话去哪了」只看审计就够
    expect(inbound?.secretaryConversationId).toBe('sec-1');
    expect(JSON.stringify(h.audits)).not.toContain('把登录修一下');
  });

  it('过长的回复分条发，不会因为超限整条丢掉', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.api.push(privateMessage('写个长报告'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    const before = h.api.sent.length;
    h.service.onTurnReply('sec-1', 'x'.repeat(5000));
    await waitFor(() => h.api.sent.length > before + 1, 'reply split');
    const sent = h.api.sent.slice(before);
    expect(sent.length).toBe(2);
    expect(sent.every((entry) => entry.text.length <= 3900)).toBe(true);
    expect(sent.every((entry) => entry.parseMode === 'HTML')).toBe(true);
    expect(sent.map((entry) => entry.text).join('')).toHaveLength(5000);
  });

  it('秘书的回复在用户从手机说话后回发手机', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.api.push(privateMessage('在吗'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    const before = h.api.sent.length;
    h.service.onTurnReply('sec-1', '在，刚把登录修完');
    await waitFor(() => h.api.sent.length > before, 'reply sent');
    expect(h.api.sent.at(-1)?.text).toBe('在，刚把登录修完');
    // 没有手机消息的那一轮不回发
    h.service.onTurnReply('sec-1', '巡检正常');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent.at(-1)?.text).toBe('在，刚把登录修完');
  });
});

describe('出站遵循 notify 与静默', () => {
  it('off 一条都不发', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.world.mode = 'off';
    const before = h.api.sent.length;
    h.service.onMilestone({ kind: 'needs-user', title: 'A · B', conversationId: 'c1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent.length).toBe(before);
  });

  it('needs-user 只发要人处理的，完成与中间进度都不发', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.world.mode = 'needs-user';
    const before = h.api.sent.length;
    h.service.onMilestone({ kind: 'goal-complete', title: 'A · B', conversationId: 'c1' });
    h.service.onMilestone({ kind: 'turn-ended', title: 'A · B', conversationId: 'c1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent.length).toBe(before);
    h.service.onMilestone({ kind: 'needs-user', title: 'A · B', conversationId: 'c1' });
    await waitFor(() => h.api.sent.length > before, 'needs-user sent');
    expect(h.api.sent.at(-1)?.text).toContain('👉 需要你 · A · B');
  });

  it('with-done 发完成，带会话标题与回应用的深链', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onMilestone({
      kind: 'goal-complete',
      title: 'EnsoCode · 修登录',
      lastText: '已合并到 main',
      conversationId: 'c1',
    });
    await waitFor(() => h.api.sent.length > 1, 'milestone sent');
    const text = h.api.sent.at(-1)?.text ?? '';
    expect(text).toContain('✅ 完成 · EnsoCode · 修登录');
    expect(text).toContain('已合并到 main');
    expect(text).toContain('enso://secretary?conversation=c1');
  });
});

describe('提问：两边谁先答算谁的', () => {
  it('秘书的 ask_user 带选项按钮发到手机，点按钮就是回答', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onAskRequest('sec-1', {
      requestId: 'ask-1',
      question: '用哪个分支？',
      options: ['main', 'dev'],
    });
    await waitFor(() => h.api.sent.length > 1, 'ask sent');
    const ask = h.api.sent.at(-1);
    expect(ask?.text).toContain('用哪个分支？');
    expect(ask?.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual([
      'main',
      'dev',
    ]);
    const data = ask?.replyMarkup?.inline_keyboard[1][0].callback_data ?? '';
    expect(data).toBe('ask:1:1');
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data } });
    await waitFor(() => h.world.answers.length > 0, 'answered');
    expect(h.world.answers[0]).toEqual({ requestId: 'ask-1', answer: 'dev' });
    expect(h.api.callbacks.at(-1)?.text).toContain('已回答：dev');
  });

  it('应用里先答了：手机再点按钮只提示已失效', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onAskRequest('sec-1', { requestId: 'ask-1', question: '走哪条？', options: ['A'] });
    await waitFor(() => h.api.sent.length > 1, 'ask sent');
    h.world.answerOk = false;
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'ask:1:0' } });
    await waitFor(() => h.api.callbacks.length > 0, 'callback answered');
    expect(h.api.callbacks.at(-1)?.text).toBe('已在应用里回答过了');
    expect(h.world.answers).toHaveLength(0);
  });

  it('挂着提问时手机回一句话就是回答，不再投给秘书', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onAskRequest('sec-1', { requestId: 'ask-9', question: '几点发版？' });
    await waitFor(() => h.api.sent.length > 1, 'ask sent');
    h.api.push(privateMessage('晚上八点'));
    await waitFor(() => h.world.answers.length > 0, 'answered');
    expect(h.world.answers[0]).toEqual({ requestId: 'ask-9', answer: '晚上八点' });
    expect(h.world.delivered).toHaveLength(0);
  });

  it('提问在应用里收尾后，手机上的按钮失效', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onAskRequest('sec-1', { requestId: 'ask-1', question: '走哪条？', options: ['A'] });
    await waitFor(() => h.api.sent.length > 1, 'ask sent');
    h.service.onAskResolved('sec-1', 'ask-1');
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'ask:1:0' } });
    await waitFor(() => h.api.callbacks.length > 0, 'callback answered');
    expect(h.api.callbacks.at(-1)?.text).toBe('这条提问已经结束了');
  });

  it('点了按钮：原消息换成已回答，按钮一起清掉', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onAskRequest('sec-1', {
      requestId: 'ask-1',
      question: '用哪个分支？',
      options: ['main', 'dev'],
    });
    await waitFor(() => h.api.sent.length > 1, 'ask sent');
    // 假 API 的 sendMessage 返回已发条数，也就是这条提问的 message_id
    const askMessageId = h.api.sent.length;
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'ask:1:1' } });
    await waitFor(() => h.api.edited.length > 0, 'ask edited');
    const edited = h.api.edited.at(-1);
    expect(edited?.messageId).toBe(askMessageId);
    expect(edited?.replyMarkup?.inline_keyboard).toEqual([]);
    // 原问题留着方便回看，只在后面追加一行
    expect(edited?.text).toContain('用哪个分支？');
    expect(edited?.text).toContain('✅ 已回答：dev');
    expect(edited?.parseMode).toBe('HTML');
    expect(h.audits.at(-1)?.op).toBe('contact_ask_settled');
    expect(h.audits.at(-1)?.detail).toBe('answered');
  });

  it('应用里先答了：手机那条消息同步标成已在应用里回答', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onAskRequest('sec-1', { requestId: 'ask-1', question: '走哪条？', options: ['A'] });
    await waitFor(() => h.api.sent.length > 1, 'ask sent');
    h.service.onAskResolved('sec-1', 'ask-1', { by: 'user', answer: 'A' });
    await waitFor(() => h.api.edited.length > 0, 'ask edited');
    expect(h.api.edited.at(-1)?.text).toContain('✅ 已在应用里回答');
    expect(h.api.edited.at(-1)?.replyMarkup?.inline_keyboard).toEqual([]);
    expect(h.audits.at(-1)?.detail).toBe('app');
  });

  it('超时收尾：手机那条消息标成已过期', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onAskRequest('sec-1', {
      requestId: 'ask-1',
      question: '几点发版？',
      options: ['八点'],
    });
    await waitFor(() => h.api.sent.length > 1, 'ask sent');
    h.service.onAskResolved('sec-1', 'ask-1', { by: 'timeout' });
    await waitFor(() => h.api.edited.length > 0, 'ask edited');
    expect(h.api.edited.at(-1)?.text).toContain('⌛ 已过期');
    expect(h.api.edited.at(-1)?.replyMarkup?.inline_keyboard).toEqual([]);
  });

  it('重复点同一个按钮：只回已经回答过了，不再触发一次', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onAskRequest('sec-1', { requestId: 'ask-1', question: '走哪条？', options: ['A'] });
    await waitFor(() => h.api.sent.length > 1, 'ask sent');
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'ask:1:0' } });
    await waitFor(() => h.world.answers.length > 0, 'answered');
    h.api.push({ update_id: 3, callback_query: { id: 'cb-2', data: 'ask:1:0' } });
    await waitFor(() => h.api.callbacks.length > 1, 'second callback');
    expect(h.api.callbacks.at(-1)?.text).toBe('已经回答过了');
    expect(h.world.answers).toHaveLength(1);
  });

  it('消息太旧改不动：退到只清按钮，不抛异常', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onAskRequest('sec-1', { requestId: 'ask-1', question: '走哪条？', options: ['A'] });
    await waitFor(() => h.api.sent.length > 1, 'ask sent');
    h.api.editTextError = new TelegramApiError('api', 'Bad Request: message to edit not found');
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'ask:1:0' } });
    await waitFor(() => h.api.markupEdits.length > 0, 'markup only');
    expect(h.api.markupEdits.at(-1)?.replyMarkup.inline_keyboard).toEqual([]);
    expect(h.world.answers).toHaveLength(1);
    // 先记一条正文改不动的失败，再记一条「只清按钮」的成功
    const settled = h.audits.filter((entry) => entry.op === 'contact_ask_settled').at(-1);
    expect(settled?.ok).toBe(true);
    expect(settled?.detail).toBe('answered markup-only');
  });

  it('连按钮都清不掉：静默降级，回答照旧生效', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onAskRequest('sec-1', { requestId: 'ask-1', question: '走哪条？', options: ['A'] });
    await waitFor(() => h.api.sent.length > 1, 'ask sent');
    h.api.editTextError = new TelegramApiError('api', 'Bad Request: message to edit not found');
    h.api.markupError = new TelegramApiError('api', 'Bad Request: message to edit not found');
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'ask:1:0' } });
    await waitFor(
      () => h.audits.some((entry) => entry.op === 'contact_ask_settled' && !entry.ok),
      'settle failed silently'
    );
    expect(h.world.answers).toHaveLength(1);
    expect(h.audits.find((entry) => entry.op === 'contact_ask_settled')?.detail).toBe(
      'answered api'
    );
    // 不改消息失败不能变成给用户的错误提示
    expect(h.audits.some((entry) => entry.op === 'contact_error')).toBe(false);
  });

  it('回调数据伪造或过期一律不认', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'ask:99:0' } });
    await waitFor(() => h.api.callbacks.length > 0, 'callback answered');
    expect(h.api.callbacks.at(-1)?.text).toBe('这条提问已经结束了');
    expect(h.world.answers).toHaveLength(0);
  });
});

describe('确认卡与审批', () => {
  const bound = async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    return h;
  };

  const card = { id: 'p1', kind: 'dispatch' as const, title: '修登录', conversationId: 'sec-1' };

  it('确认卡带「确认」与「在应用里打开」两个按钮，回调数据带上卡片 id', async () => {
    const h = await bound();
    h.service.syncPendingCards([card]);
    await waitFor(() => h.api.sent.length > 1, 'card notice sent');
    const message = h.api.sent.at(-1);
    expect(message?.text).toContain('有一张卡在等你 · 修登录');
    expect(message?.text).toContain('点「确认」直接处理');
    const rows = message?.replyMarkup?.inline_keyboard ?? [];
    expect(rows.flat().map((button) => button.text)).toEqual(['确认派发：修登录', '在应用里打开']);
    expect(rows[0][0].callback_data).toBe('card:c:p1');
    // enso:// 做不成 url 按钮：按钮走回调，正文里另给一份等宽可复制链接
    expect(rows[0][1].url).toBeUndefined();
    expect(rows[0][1].callback_data).toBe('card:o:p1');
    expect(message?.text).toContain(
      '<code>enso://secretary?conversation=sec-1&amp;proposal=p1</code>'
    );
    // 文案与实际形态一致：不再说「点下面的按钮」再甩一段裸链接
    expect(message?.text).not.toContain('点下面的按钮');
    expect(h.world.resolved).toHaveLength(0);
  });

  it('假 API 按 Telegram 的规则拒掉自定义 scheme 的 url 按钮', async () => {
    const h = await bound();
    await expect(
      h.api.sendMessage({
        chatId: 777,
        text: 'x',
        replyMarkup: {
          inline_keyboard: [[{ text: '在应用里打开', url: 'enso://secretary?conversation=c1' }]],
        },
      })
    ).rejects.toThrow('BUTTON_URL_INVALID');
    // http(s) 与 tg:// 才是合法的 url 按钮：支持时正文不再重复链接
    await expect(
      h.api.sendMessage({
        chatId: 777,
        text: 'x',
        replyMarkup: { inline_keyboard: [[{ text: '在应用里打开', url: 'https://a.b/c' }]] },
      })
    ).resolves.toBeGreaterThan(0);
  });

  it('开关打开时点确认：执行、回一条结果、原消息换成「✅ 已确认」并清掉按钮', async () => {
    const h = await bound();
    h.service.syncPendingCards([card]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    const messageId = h.api.sent.length;
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'card:c:p1' } });
    await waitFor(() => h.api.edited.length > 0, 'message edited');
    expect(h.world.resolved).toEqual([{ proposalId: 'p1', action: 'confirm' }]);
    expect(h.api.callbacks.at(-1)?.text).toBe('已确认：派发 修登录');
    const edited = h.api.edited.at(-1);
    expect(edited?.messageId).toBe(messageId);
    expect(edited?.text).toBe('✅ 已确认：派发 修登录');
    expect(edited?.replyMarkup).toEqual({ inline_keyboard: [] });
    // 另回一条结果，手机上不用翻原消息
    expect(h.api.sent.at(-1)?.text).toContain('✅ 已确认：派发 修登录');
    expect(
      h.audits.some(
        (entry) =>
          entry.op === 'contact_card_confirm' &&
          entry.ok &&
          entry.detail?.startsWith('派发') === true &&
          // 审计里带上卡片 id：事后能对上确认的是哪一张
          entry.detail.includes('p1')
      )
    ).toBe(true);
    // 「· 已处理」这种半截后缀不再出现
    expect(JSON.stringify([h.api.sent, h.api.edited])).not.toContain('· 已处理');
  });

  it('开关关着时点确认只回说明，不执行', async () => {
    const h = await bound();
    h.service.setAllowCardConfirm(false);
    h.service.syncPendingCards([card]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    const message = h.api.sent.at(-1);
    expect(message?.text).toContain('关着手机确认');
    // 按钮照样在，只是点了不执行
    const rows = message?.replyMarkup?.inline_keyboard ?? [];
    expect(rows.flat().map((button) => button.text)).toEqual(['确认派发：修登录', '在应用里打开']);
    const before = h.api.sent.length;
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'card:c:p1' } });
    await waitFor(() => h.api.callbacks.length > 0, 'callback');
    expect(h.api.callbacks.at(-1)?.text).toBe('已在设置里关闭手机确认，请回应用处理');
    expect(h.world.resolved).toHaveLength(0);
    expect(h.api.edited).toHaveLength(0);
    // 只回一条说明，附「在应用里打开」
    expect(h.api.sent.length).toBe(before + 1);
    const notice = h.api.sent.at(-1);
    expect(notice?.text).toContain('已在设置里关闭手机确认');
    expect(notice?.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual([
      '在应用里打开',
    ]);
    expect(
      h.audits.some(
        (entry) => entry.op === 'contact_card_confirm' && !entry.ok && entry.detail === 'disabled'
      )
    ).toBe(true);
  });

  it('开关打开后设置、技能、工具、接管卡片都能确认，按钮文案带类型', async () => {
    const h = await bound();
    h.service.syncPendingCards([
      { id: 'p-profile', kind: 'profile', title: '秘书', conversationId: 'sec-1' },
      { id: 'p-skill', kind: 'skill', title: 'review', conversationId: 'sec-1' },
      { id: 'p-tool', kind: 'tool', title: 'upper', conversationId: 'sec-1' },
      { id: 'p-takeover', kind: 'takeover', title: '修登录', conversationId: 'sec-1' },
    ]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    const rows = h.api.sent.at(-1)?.replyMarkup?.inline_keyboard ?? [];
    expect(rows.slice(0, 4).map((row) => row[0].text)).toEqual([
      '确认设置：秘书',
      '确认技能：review',
      '确认工具：upper',
      '确认接管：修登录',
    ]);
    // 多张卡时回应用入口单独一行，指向第一张
    expect(rows[4].map((button) => button.text)).toEqual(['在应用里打开']);
    expect(rows[4][0].callback_data).toBe('card:o:p-profile');
    for (const [index, proposalId] of ['p-profile', 'p-skill', 'p-tool', 'p-takeover'].entries()) {
      h.api.push({
        update_id: 10 + index,
        callback_query: { id: `cb-${index}`, data: rows[index][0].callback_data ?? '' },
      });
      await waitFor(() => h.world.resolved.length === index + 1, `resolved ${proposalId}`);
    }
    expect(h.world.resolved.map((entry) => entry.proposalId)).toEqual([
      'p-profile',
      'p-skill',
      'p-tool',
      'p-takeover',
    ]);
  });

  it('审批永远只有提示与回应用入口，没有确认按钮', async () => {
    const h = await bound();
    h.service.onCardWaiting({ count: 1, approval: true, conversationId: 'sec-1' });
    await waitFor(() => h.api.sent.length > 1, 'approval notice');
    const message = h.api.sent.at(-1);
    expect(message?.text).toContain('审批只能在应用里处理');
    const buttons = message?.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(buttons.map((button) => button.text)).toEqual(['在应用里打开']);
    expect(buttons[0].callback_data).toBe('card:o:approval:1');
    // 审批消息里没有确认按钮：点不到就不可能在手机上确认
    expect(buttons.some((button) => button.callback_data?.startsWith('card:c:'))).toBe(false);
    expect(h.world.resolved).toHaveLength(0);
  });

  it('「在应用里打开」只把卡片交给 Main，不确认', async () => {
    const h = await bound();
    h.service.syncPendingCards([card]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'card:o:p1' } });
    await waitFor(() => h.world.opened.length > 0, 'opened in app');
    expect(h.world.opened[0]).toEqual({ conversationId: 'sec-1', proposalId: 'p1' });
    expect(h.world.resolved).toHaveLength(0);
    expect(h.api.callbacks.at(-1)?.text).toBe('已在应用里打开');
  });

  it('卡片在应用里处理掉之后按钮失效，正文换成「✅ 已处理」', async () => {
    const h = await bound();
    h.service.syncPendingCards([card]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    // 界面里确认了：下一次状态同步里这张卡不再 pending
    h.service.syncPendingCards([]);
    await waitFor(() => h.api.edited.length > 0, 'message settled');
    const edited = h.api.edited.at(-1);
    expect(edited?.text).toBe('✅ 已处理：派发 修登录');
    expect(edited?.replyMarkup).toEqual({ inline_keyboard: [] });
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'card:c:p1' } });
    await waitFor(() => h.api.callbacks.length > 0, 'callback');
    expect(h.api.callbacks.at(-1)?.text).toBe('这张卡已经处理过了');
    expect(h.world.resolved).toHaveLength(0);
  });

  it('界面同步抢先收尾时，收尾文案仍按手机点的动作写', async () => {
    const h = await bound();
    h.service.syncPendingCards([card]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    // 确认期间 Main 把新状态推回来：这张卡已经不在 pending 里了
    h.ports.resolveProposal = async () => {
      h.service.syncPendingCards([]);
      return { ok: true };
    };
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'card:c:p1' } });
    await waitFor(() => h.api.edited.length > 0, 'message settled');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.api.edited.at(-1)?.text).toBe('✅ 已确认：派发 修登录');
  });

  it('正文改不动时至少把按钮清掉', async () => {
    const h = await bound();
    h.service.syncPendingCards([card]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    h.api.editTextError = new TelegramApiError('api', 'Bad Request: message is not modified');
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'card:c:p1' } });
    await waitFor(() => h.api.markupEdits.length > 0, 'markup cleared');
    expect(h.api.markupEdits.at(-1)?.replyMarkup).toEqual({ inline_keyboard: [] });
    expect(h.api.edited).toHaveLength(0);
  });

  it('同一张卡只推一次', async () => {
    const h = await bound();
    h.service.syncPendingCards([card]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    const sent = h.api.sent.length;
    h.service.syncPendingCards([card]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.api.sent.length).toBe(sent);
  });

  it('卡片已经处理过再点按钮只提示', async () => {
    const h = await bound();
    h.service.syncPendingCards([card]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    h.world.proposalOk = false;
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'card:c:p1' } });
    await waitFor(() => h.api.callbacks.length > 0, 'callback');
    expect(h.api.callbacks.at(-1)?.text).toBe('这张卡已经处理过了');
  });
});

describe('token 与审计', () => {
  it('token 不出现在审计、contact.json 或界面状态里', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onMilestone({ kind: 'goal-complete', title: 'A · B', conversationId: 'c1' });
    await waitFor(() => h.api.sent.length > 1, 'milestone sent');
    const auditText = JSON.stringify(h.audits);
    expect(auditText).not.toContain(TOKEN);
    expect(auditText).not.toContain('HdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    const contactJson = readFileSync(join(h.dir, 'contact.json'), 'utf8');
    expect(contactJson).not.toContain(TOKEN);
    expect(JSON.stringify(h.service.state())).not.toContain(TOKEN);
  });
});

describe('解绑与更换 bot', () => {
  it('解绑后清 chat、停止轮询，之后的 /start 不再绑定', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    await h.service.unbind();
    const telegram = h.service.state().telegram;
    expect(telegram.status).toBe('unbound');
    expect(telegram.chat).toBeUndefined();
    expect(telegram.poll.state).toBe('stopped');
    const polls = h.api.polls;
    h.api.push(privateMessage('/start 123456'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.api.polls).toBe(polls);
    expect(h.service.state().telegram.status).toBe('unbound');
    // bot 与 token 留着：重新绑定不必再贴一次
    expect(telegram.bot?.username).toBe('enso_secretary_bot');
    expect(telegram.tokenHint).toBe('123456789:AA…');
  });

  it('更换 bot 时把 token 一起清掉', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    await h.service.forgetBot();
    const telegram = h.service.state().telegram;
    expect(telegram.status).toBe('unbound');
    expect(telegram.bot).toBeUndefined();
    expect(telegram.tokenHint).toBeUndefined();
    expect(h.store.token()).toBe('');
  });

  it('发测试消息只在绑定后可用', async () => {
    const h = harness();
    expect(await h.service.sendTest()).toEqual({ ok: false, error: 'not-bound' });
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    expect(await h.service.sendTest()).toEqual({ ok: true });
    expect(h.api.sent.at(-1)?.text).toContain('测试消息');
  });
});

describe('只读命令', () => {
  async function bound(h: ReturnType<typeof harness>): Promise<void> {
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
  }

  it('绑定的 chat 发 /status：直接回面板数据，不进秘书会话', async () => {
    const h = harness();
    await bound(h);
    h.world.delivered.length = 0;
    h.api.sent.length = 0;
    h.api.push(privateMessage('/status'));
    await waitFor(() => h.api.sent.length > 0, 'command reply');
    expect(h.api.sent.at(-1)?.text).toContain('进行中 1');
    expect(h.api.sent.at(-1)?.parseMode).toBe('HTML');
    // 不唤醒秘书：没有任何投递
    expect(h.world.delivered).toEqual([]);
    expect(h.world.commandCalls).toEqual(['status']);
    // 审计只记命令名
    const entry = h.audits.find((item) => item.op === 'contact_command');
    expect(entry).toMatchObject({ ok: true, detail: 'status' });
    expect(JSON.stringify(entry)).not.toContain('修登录');
  });

  it('别的 chat 发命令一律忽略，只记审计', async () => {
    const h = harness();
    await bound(h);
    h.world.commandCalls.length = 0;
    h.api.sent.length = 0;
    h.api.push(privateMessage('/status', 999));
    await waitFor(
      () => h.audits.some((entry) => entry.op === 'contact_inbound_rejected'),
      'rejected'
    );
    expect(h.world.commandCalls).toEqual([]);
    expect(h.api.sent).toEqual([]);
    expect(h.audits.some((entry) => entry.op === 'contact_command')).toBe(false);
  });

  it('/memory 关着时只提示开关，打开后才给标题', async () => {
    const h = harness();
    await bound(h);
    h.api.sent.length = 0;
    h.api.push(privateMessage('/memory'));
    await waitFor(() => h.api.sent.length > 0, 'memory closed');
    expect(h.api.sent.at(-1)?.text).toContain('默认不在 Telegram 显示');

    h.service.setAllowMemory(true);
    h.api.sent.length = 0;
    h.api.push(privateMessage('/memory'));
    await waitFor(() => h.api.sent.length > 0, 'memory open');
    expect(h.api.sent.at(-1)?.text).toContain('部署窗口');
    expect(h.service.state().telegram.allowMemory).toBe(true);
  });

  it('/feed 带「更早」按钮，点了原地换下一页', async () => {
    const h = harness();
    await bound(h);
    h.api.sent.length = 0;
    h.api.push(privateMessage('/feed'));
    await waitFor(() => h.api.sent.length > 0, 'feed');
    const button = h.api.sent.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0];
    expect(button?.text).toBe('更早');
    expect(button?.callback_data).toMatch(/^feed:f\d+$/u);

    h.api.push({
      update_id: 9,
      callback_query: {
        id: 'cb-feed',
        data: button?.callback_data,
        message: { message_id: 55, chat: { id: 777, type: 'private' } },
      },
    });
    await waitFor(() => h.api.edited.length > 0, 'feed edited');
    expect(h.api.edited.at(-1)).toMatchObject({ messageId: 55, text: '更早的动态' });
    expect(h.world.commandCalls).toContain('feed:e1');
    expect(h.api.callbacks.at(-1)?.callbackQueryId).toBe('cb-feed');
  });

  it('翻页按钮过期只提示，不改消息', async () => {
    const h = harness();
    await bound(h);
    h.api.push({
      update_id: 10,
      callback_query: {
        id: 'cb-old',
        data: 'feed:f999',
        message: { message_id: 56, chat: { id: 777, type: 'private' } },
      },
    });
    await waitFor(() => h.api.callbacks.length > 0, 'expired toast');
    expect(h.api.edited).toEqual([]);
    expect(h.api.callbacks.at(-1)?.text).toContain('失效');
  });

  it('写错的命令给清单，也不进秘书会话', async () => {
    const h = harness();
    await bound(h);
    h.world.delivered.length = 0;
    h.api.sent.length = 0;
    h.api.push(privateMessage('/deploy'));
    await waitFor(() => h.api.sent.length > 0, 'unknown command');
    expect(h.api.sent.at(-1)?.text).toContain('/status');
    expect(h.world.delivered).toEqual([]);
    expect(h.audits.find((entry) => entry.op === 'contact_command')?.detail).toBe('unknown');
  });

  it('带斜杠的普通句子照常进秘书会话，不被当成命令', async () => {
    const h = harness();
    await bound(h);
    h.world.delivered.length = 0;
    h.api.push(privateMessage('/etc/hosts 这个文件要不要改'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    expect(h.world.delivered[0]).toContain('/etc/hosts');
  });

  it('绑定成功：欢迎消息带命令清单，菜单里先不登记 /memory', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    const welcome = h.api.sent.find((message) => message.text.includes('已连上'));
    expect(welcome?.text).toContain('/status');
    expect(welcome?.text).not.toContain('/memory');
    const menu = h.api.menuNames((options) => options?.scope?.type === 'chat');
    expect(menu).toContain('status');
    expect(menu).not.toContain('memory');

    h.service.setAllowMemory(true);
    await waitFor(
      () => h.api.menuNames((options) => options?.scope?.type === 'chat').includes('memory'),
      'menu'
    );
  });

  it('解绑后轮询停掉，命令不会再被执行', async () => {
    const h = harness();
    await bound(h);
    await h.service.unbind();
    h.world.commandCalls.length = 0;
    h.api.sent.length = 0;
    h.api.push(privateMessage('/status'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.world.commandCalls).toEqual([]);
    expect(h.api.sent).toEqual([]);
    expect(h.service.state().telegram.status).toBe('unbound');
  });

  describe('命令菜单注册', () => {
    async function bound(h: ReturnType<typeof harness>): Promise<void> {
      await h.service.bind(TOKEN);
      h.api.push(privateMessage('/start 123456'));
      await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    }

    const chatScope = (options?: TelegramCommandOptions) =>
      options?.scope?.type === 'chat' && options.scope.chat_id === 777;

    it('绑定成功：chat scope 只对绑定的 chat，另发中文与兜底两份，按钮设成 commands', async () => {
      const h = harness();
      await bound(h);
      await waitFor(() => h.api.menuButtons.length > 0, 'menu button');

      const chat = h.api.commands.filter((call) => chatScope(call.options)).at(-1);
      expect(chat?.options?.scope).toEqual({ type: 'chat', chat_id: 777 });
      expect(chat?.options?.languageCode).toBeUndefined();
      expect(chat?.commands.map((entry) => entry.command)).toContain('status');
      expect(chat?.commands[0]?.description).toMatch(/[\u4e00-\u9fa5]/);

      expect(h.api.commands.some((call) => call.options?.languageCode === 'zh')).toBe(true);
      expect(h.api.commands.some((call) => call.options === undefined)).toBe(true);
      expect(h.api.menuButtons.at(-1)).toEqual({ type: 'commands' });
      expect(h.audits.some((entry) => entry.op === 'contact_commands' && entry.ok)).toBe(true);
    });

    it('启动时已绑定：幂等地重新注册一次', async () => {
      const h = harness();
      await bound(h);
      await waitFor(() => h.api.menuButtons.length > 0, 'menu button');
      const before = h.api.commands.length;
      await h.service.stop();
      await h.service.start();
      await waitFor(() => h.api.commands.length > before, 're-register');
      expect(h.api.commands.filter((call) => chatScope(call.options)).length).toBeGreaterThan(1);
    });

    it('切换记忆开关：重新注册，关掉后菜单里没有 /memory', async () => {
      const h = harness();
      await bound(h);
      await waitFor(() => h.api.menuButtons.length > 0, 'menu button');
      const names = () => h.api.menuNames(chatScope);

      h.service.setAllowMemory(true);
      await waitFor(() => names().includes('memory'), 'memory on');
      h.service.setAllowMemory(false);
      await waitFor(() => !names().includes('memory'), 'memory off');
    });

    it('解绑：删掉 chat 与默认 scope 的菜单，按钮回默认', async () => {
      const h = harness();
      await bound(h);
      await waitFor(() => h.api.menuButtons.length > 0, 'menu button');
      h.api.deleted.length = 0;
      h.api.menuButtons.length = 0;

      await h.service.unbind();
      expect(h.api.deleted).toContainEqual({ scope: { type: 'chat', chat_id: 777 } });
      expect(h.api.deleted).toContainEqual({ languageCode: 'zh' });
      expect(h.api.deleted).toContainEqual(undefined);
      expect(h.api.menuButtons.at(-1)).toEqual({ type: 'default' });
    });

    it('更换 bot：先清菜单再忘掉 token', async () => {
      const h = harness();
      await bound(h);
      await waitFor(() => h.api.menuButtons.length > 0, 'menu button');
      h.api.deleted.length = 0;

      await h.service.forgetBot();
      expect(h.api.deleted).toHaveLength(3);
      expect(h.store.token()).toBe('');
      expect(h.service.state().telegram.status).toBe('unbound');
    });

    it('注册失败只记审计，不影响收发消息', async () => {
      const h = harness();
      h.api.menuError = new Error('boom');
      await bound(h);
      await waitFor(
        () => h.audits.some((entry) => entry.op === 'contact_commands' && !entry.ok),
        'failed audit'
      );
      expect(h.service.state().telegram.status).toBe('bound');

      h.api.sent.length = 0;
      h.api.push(privateMessage('/status'));
      await waitFor(() => h.api.sent.length > 0, 'command reply');
      expect(h.api.sent.at(-1)?.text).toContain('进行中');
    });
  });

  describe('出站格式', () => {
    async function bound(h: ReturnType<typeof harness>): Promise<void> {
      await h.service.bind(TOKEN);
      h.api.push(privateMessage('/start 123456'));
      await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
      h.api.push(privateMessage('写个总结'));
      await waitFor(() => h.world.delivered.length > 0, 'delivered');
    }

    it('秘书的 markdown 转成 Telegram HTML 再发', async () => {
      const h = harness();
      await bound(h);
      h.api.sent.length = 0;
      h.service.onTurnReply('sec-1', '**完成**\n\n- 改了 `a.ts`\n- 跑了测试');
      await waitFor(() => h.api.sent.length > 0, 'reply');
      const sent = h.api.sent.at(-1);
      expect(sent?.parseMode).toBe('HTML');
      expect(sent?.text).toContain('<b>完成</b>');
      expect(sent?.text).toContain('• 改了 <code>a.ts</code>');
      expect(sent?.text).not.toContain('**');
    });

    it('解析失败降级成纯文本重发，并记审计', async () => {
      const h = harness();
      await bound(h);
      h.api.sent.length = 0;
      h.api.rejectHtml = true;
      h.service.onTurnReply('sec-1', '**重点**：看这里');
      await waitFor(() => h.api.sent.length > 0, 'fallback');
      const sent = h.api.sent.at(-1);
      expect(sent?.parseMode).toBeUndefined();
      expect(sent?.text).toBe('重点：看这里');
      expect(h.audits.some((entry) => entry.op === 'contact_format' && !entry.ok)).toBe(true);
      expect(h.audits.some((entry) => entry.op === 'contact_format' && entry.ok)).toBe(true);
    });

    it('只读命令的回复也走同一套：HTML 发送', async () => {
      const h = harness();
      await bound(h);
      h.api.sent.length = 0;
      h.api.push(privateMessage('/status'));
      await waitFor(() => h.api.sent.length > 0, 'command reply');
      expect(h.api.sent.at(-1)?.parseMode).toBe('HTML');
    });
  });
});

describe('/last 回看最近几轮', () => {
  async function bound(h: ReturnType<typeof harness>): Promise<void> {
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.api.sent.length = 0;
    h.world.delivered.length = 0;
    h.world.commandCalls.length = 0;
  }

  const rounds = [
    { role: 'user' as const, text: '早' },
    { role: 'assistant' as const, text: '早，今天有三件事' },
    { role: 'user' as const, text: '登录修好了吗' },
    { role: 'assistant' as const, text: '修好了' },
  ];

  it('不带参数只发最近一轮，用「你：」与秘书昵称开头', async () => {
    const h = harness();
    await bound(h);
    h.world.recap = rounds;
    h.api.push(privateMessage('/last'));
    await waitFor(() => h.api.sent.length > 0, 'last');
    const sent = h.api.sent.at(-1);
    expect(sent?.text).toContain('你：登录修好了吗');
    expect(sent?.text).toContain('爱酱：修好了');
    expect(sent?.text).not.toContain('早，今天有三件事');
    expect(sent?.parseMode).toBe('HTML');
    // 只读：不进会话、不唤醒模型
    expect(h.world.delivered).toEqual([]);
    expect(h.world.commandCalls).toEqual([]);
    expect(h.world.recapCalls).toEqual([1]);
    expect(h.audits.find((entry) => entry.op === 'contact_command')).toMatchObject({
      ok: true,
      detail: 'last 1',
    });
  });

  it('带参数就回看几轮', async () => {
    const h = harness();
    await bound(h);
    h.world.recap = rounds;
    h.api.push(privateMessage('/last 2'));
    await waitFor(() => h.api.sent.length > 0, 'last 2');
    const text = h.api.sent.at(-1)?.text ?? '';
    expect(text).toContain('你：早');
    expect(text).toContain('你：登录修好了吗');
    expect(h.world.recapCalls).toEqual([2]);
  });

  it('超过十轮算写错：只回用法，不读会话', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('/last 11'));
    await waitFor(() => h.api.sent.length > 0, 'usage');
    expect(h.api.sent.at(-1)?.text).toContain('/last 3');
    expect(h.world.recapCalls).toEqual([]);
  });

  it('超长按行分条，代码块整块搬不切断', async () => {
    const h = harness();
    await bound(h);
    const code = [
      '```',
      ...Array.from({ length: 200 }, (_v, index) => `line ${index} ${'x'.repeat(40)}`),
      '```',
    ];
    h.world.recap = [
      { role: 'user', text: '看日志' },
      { role: 'assistant', text: code.join('\n') },
    ];
    h.api.push(privateMessage('/last'));
    await waitFor(() => h.api.sent.length > 1, 'split');
    const sent = h.api.sent;
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((entry) => entry.text.length <= 3900)).toBe(true);
    for (const entry of sent) {
      expect(entry.text.split('<pre>').length).toBe(entry.text.split('</pre>').length);
    }
    expect(sent.map((entry) => entry.text).join('\n')).toContain('line 199');
  });

  it('没有可回看的对话时说明白，不发空消息', async () => {
    const h = harness();
    await bound(h);
    h.world.recap = [];
    h.api.push(privateMessage('/last'));
    await waitFor(() => h.api.sent.length > 0, 'empty');
    expect(h.api.sent.at(-1)?.text).toContain('还没有可以回看的对话');
  });

  it('别的 chat 发 /last 一律忽略', async () => {
    const h = harness();
    await bound(h);
    h.world.recap = rounds;
    h.api.push(privateMessage('/last', 999));
    await waitFor(
      () => h.audits.some((entry) => entry.op === 'contact_inbound_rejected'),
      'rejected'
    );
    expect(h.api.sent).toEqual([]);
    expect(h.world.recapCalls).toEqual([]);
  });
});

describe('/sync 镜像秘书会话', () => {
  async function bound(h: ReturnType<typeof harness>): Promise<void> {
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.api.sent.length = 0;
    h.world.delivered.length = 0;
  }

  it('不带参数只报当前状态，默认关闭', async () => {
    const h = harness();
    await bound(h);
    expect(h.service.state().telegram.syncMirror).toBe(false);
    h.api.push(privateMessage('/sync'));
    await waitFor(() => h.api.sent.length > 0, 'status');
    expect(h.api.sent.at(-1)?.text).toContain('同步已关闭');
    expect(h.service.state().telegram.syncMirror).toBe(false);
    // 查状态不是开关动作，不记 contact_sync
    expect(h.audits.some((entry) => entry.op === 'contact_sync')).toBe(false);
  });

  it('/sync on 打开并记审计，之后每一轮回复都发', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('/sync on'));
    await waitFor(() => h.api.sent.length > 0, 'on');
    expect(h.api.sent.at(-1)?.text).toContain('已打开同步');
    expect(h.service.state().telegram.syncMirror).toBe(true);
    expect(h.audits.find((entry) => entry.op === 'contact_sync')).toMatchObject({
      ok: true,
      detail: 'on',
    });

    h.api.sent.length = 0;
    h.service.onTurnReply('sec-1', '巡检正常，没有异常');
    await waitFor(
      () => h.audits.some((entry) => entry.op === 'contact_mirror' && entry.ok),
      'mirrored'
    );
    expect(h.api.sent.at(-1)?.text).toContain('巡检正常');
  });

  it('/sync off 立刻恢复成只发里程碑', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('/sync on'));
    await waitFor(() => h.service.state().telegram.syncMirror, 'on');
    h.api.push(privateMessage('/sync off'));
    await waitFor(() => !h.service.state().telegram.syncMirror, 'off');
    expect(h.audits.filter((entry) => entry.op === 'contact_sync').map((e) => e.detail)).toEqual([
      'on',
      'off',
    ]);
    h.api.sent.length = 0;
    h.service.onTurnReply('sec-1', '巡检正常');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent).toEqual([]);
  });

  it('静默回合只发一行摘要，正文不发', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('/sync on'));
    await waitFor(() => h.service.state().telegram.syncMirror, 'on');
    h.api.sent.length = 0;
    h.service.onTurnSilent('sec-1', 3);
    await waitFor(
      () => h.audits.some((entry) => entry.op === 'contact_mirror' && entry.detail === 'silent'),
      'silent summary'
    );
    expect(h.api.sent.at(-1)?.text).toBe('（静默处理了 3 条更新）');
  });

  it('同步关着时静默回合一条都不发', async () => {
    const h = harness();
    await bound(h);
    h.service.onTurnSilent('sec-1', 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent).toEqual([]);
  });

  it('手机发起的回合只回一次，不重复镜像', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('/sync on'));
    await waitFor(() => h.service.state().telegram.syncMirror, 'on');
    h.api.push(privateMessage('在吗'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    h.api.sent.length = 0;
    h.service.onTurnReply('sec-1', '在，刚把登录修完');
    await waitFor(() => h.api.sent.length > 0, 'reply');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent).toHaveLength(1);
    expect(h.audits.some((entry) => entry.op === 'contact_reply' && entry.ok)).toBe(true);
    expect(h.audits.some((entry) => entry.op === 'contact_mirror')).toBe(false);
  });

  it('重启后状态还在', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('/sync on'));
    await waitFor(() => h.service.state().telegram.syncMirror, 'on');
    const restarted = h.restart();
    expect(restarted.state().telegram.syncMirror).toBe(true);
  });

  it('解绑与更换 bot 都自动关掉同步', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('/sync on'));
    await waitFor(() => h.service.state().telegram.syncMirror, 'on');
    await h.service.unbind();
    expect(h.service.state().telegram.syncMirror).toBe(false);
    expect(h.store.file().syncMirror).toBe(false);

    await bound(h);
    h.api.push(privateMessage('/sync on'));
    await waitFor(() => h.service.state().telegram.syncMirror, 'on');
    await h.service.forgetBot();
    expect(h.service.state().telegram.syncMirror).toBe(false);
    expect(h.store.file().syncMirror).toBe(false);
  });

  it('别的 chat 发 /sync 不改状态，只记审计', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('/sync on', 999));
    await waitFor(
      () => h.audits.some((entry) => entry.op === 'contact_inbound_rejected'),
      'rejected'
    );
    expect(h.service.state().telegram.syncMirror).toBe(false);
    expect(h.api.sent).toEqual([]);
  });
});

describe('「正在输入…」', () => {
  /** 直接落盘成已绑定：不走 /start 向导，按需起轮询 */
  async function boundStore(
    h: ReturnType<typeof harness>,
    options: { syncMirror?: boolean; poll?: boolean } = {}
  ): Promise<void> {
    await h.store.saveToken(TOKEN);
    h.store.save({ ...h.store.file(), chat: { id: 777 }, syncMirror: options.syncMirror === true });
    if (options.poll) await h.service.start();
    h.api.sent.length = 0;
  }

  it('手机发起的回合会发 typing', async () => {
    const h = harness();
    await boundStore(h, { poll: true });
    h.api.push(privateMessage('在吗'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    h.service.onTurnStart('sec-1');
    await waitFor(() => h.api.chatActions.length === 1, 'typing');
    expect(h.api.chatActions).toEqual([{ chatId: 777, action: 'typing' }]);
    h.service.onTurnEnd('sec-1');
    await h.service.stop();
  });

  it('/sync 打开时应用内回合会发 typing', async () => {
    const h = harness();
    await boundStore(h, { syncMirror: true });
    h.service.onTurnStart('sec-1');
    await waitFor(() => h.api.chatActions.length === 1, 'typing');
    expect(h.api.chatActions).toEqual([{ chatId: 777, action: 'typing' }]);
    h.service.onTurnEnd('sec-1');
  });

  it('/sync 关闭且不是手机发起时不发', async () => {
    const h = harness();
    await boundStore(h);
    h.service.onTurnStart('sec-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.chatActions).toEqual([]);
  });

  it('没绑定 chat 时不发', async () => {
    const h = harness();
    h.service.onTurnStart('sec-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.chatActions).toEqual([]);
  });

  it('超过 5 秒每 4 秒续发一次', async () => {
    const h = harness();
    await boundStore(h, { syncMirror: true });
    vi.useFakeTimers();
    h.service.onTurnStart('sec-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.chatActions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.api.chatActions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.api.chatActions).toHaveLength(3);
  });

  it('回合结束就停：定时器清掉，不再续发', async () => {
    const h = harness();
    await boundStore(h, { syncMirror: true });
    vi.useFakeTimers();
    h.service.onTurnStart('sec-1');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.api.chatActions).toHaveLength(2);
    h.service.onTurnEnd('sec-1');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.api.chatActions).toHaveLength(2);
  });

  it('回复发出后不再续发', async () => {
    const h = harness();
    await boundStore(h, { syncMirror: true });
    vi.useFakeTimers();
    h.service.onTurnStart('sec-1');
    await vi.advanceTimersByTimeAsync(0);
    h.service.onTurnReply('sec-1', '巡检正常');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.api.chatActions).toHaveLength(1);
    expect(h.api.sent.at(-1)?.text).toContain('巡检正常');
  });

  it('静默回合收尾就停，不再续发', async () => {
    const h = harness();
    await boundStore(h, { syncMirror: true });
    vi.useFakeTimers();
    h.service.onTurnStart('sec-1');
    await vi.advanceTimersByTimeAsync(0);
    h.service.onTurnSilent('sec-1', 3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.api.chatActions).toHaveLength(1);
    expect(h.api.sent.at(-1)?.text).toBe('（静默处理了 3 条更新）');
  });

  it('会话停止时定时器清掉', async () => {
    const h = harness();
    await boundStore(h, { syncMirror: true });
    vi.useFakeTimers();
    h.service.onTurnStart('sec-1');
    await vi.advanceTimersByTimeAsync(0);
    await h.service.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.api.chatActions).toHaveLength(1);
  });

  it('解绑后立刻停，不再续发', async () => {
    const h = harness();
    await boundStore(h, { syncMirror: true });
    vi.useFakeTimers();
    h.service.onTurnStart('sec-1');
    await vi.advanceTimersByTimeAsync(0);
    await h.service.unbind();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.api.chatActions).toHaveLength(1);
  });

  it('同一时间只有一个循环，重复开始不叠加定时器', async () => {
    const h = harness();
    await boundStore(h, { syncMirror: true });
    vi.useFakeTimers();
    h.service.onTurnStart('sec-1');
    h.service.onTurnStart('sec-1');
    h.service.onTurnStart('other');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.chatActions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.api.chatActions).toHaveLength(2);
  });

  it('sendChatAction 失败只记审计，回复照发，也不重试', async () => {
    const h = harness();
    await boundStore(h, { syncMirror: true });
    vi.useFakeTimers();
    h.api.typingError = new TelegramApiError('api', 'Bad Request: chat not found');
    h.service.onTurnStart('sec-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.audits.find((entry) => entry.op === 'contact_typing')).toMatchObject({
      ok: false,
      detail: 'api',
    });
    // 失败后不再重试：续发循环停了
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.api.chatActions).toEqual([]);
    expect(h.audits.filter((entry) => entry.op === 'contact_typing')).toHaveLength(1);
    h.service.onTurnReply('sec-1', '在，刚把登录修完');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.sent.at(-1)?.text).toContain('在，刚把登录修完');
  });
});

describe('手机关注的任务', () => {
  /** 已绑定、轮询在跑：命令与按钮回调都从这里进来 */
  async function bound(h: ReturnType<typeof harness>): Promise<void> {
    await h.store.saveToken(TOKEN);
    h.store.save({ ...h.store.file(), chat: { id: 777 } });
    await h.service.start();
    h.api.sent.length = 0;
  }

  function follow(
    h: ReturnType<typeof harness>,
    kind: 'session' | 'schedule',
    targetId: string,
    summary: string,
    secretaryConversationId?: string
  ): void {
    h.following.add({
      kind,
      targetId,
      origin: { channelId: 'telegram', peerId: '777' },
      at: h.clock.now,
      summary,
      ...(secretaryConversationId ? { secretaryConversationId } : {}),
    });
  }

  it('关注的会话完成时推手机，带上原始需求摘要，推过一次就结束关注', async () => {
    const h = harness();
    await bound(h);
    follow(h, 'session', 'c1', 'apple-table 加 Score 字段');
    h.service.onMilestone({ kind: 'goal-complete', title: 'alpha · 加字段', conversationId: 'c1' });
    await waitFor(() => h.api.sent.length > 0, 'milestone');
    const text = h.api.sent.at(-1)?.text ?? '';
    expect(text).toContain('✅ 完成 · alpha · 加字段');
    expect(text).toContain('你让我做的「apple-table 加 Score 字段」');
    await waitFor(() => h.following.list().length === 0, 'follow ended');
    expect(h.audits.find((entry) => entry.op === 'contact_follow_push')).toMatchObject({
      ok: true,
      detail: 'goal-complete',
    });
    expect(h.audits.some((entry) => entry.op === 'contact_follow_done')).toBe(true);
  });

  it('推过一次后不会重复推：第二次完成不再带摘要', async () => {
    const h = harness();
    await bound(h);
    follow(h, 'session', 'c1', '加字段');
    h.service.onMilestone({ kind: 'goal-complete', title: 'A · B', conversationId: 'c1' });
    await waitFor(() => h.following.list().length === 0, 'follow ended');
    expect(h.api.sent.at(-1)?.text).toContain('你让我做的「加字段」');
    h.service.onMilestone({ kind: 'goal-complete', title: 'A · B', conversationId: 'c1' });
    await waitFor(() => h.api.sent.length > 1, 'second');
    expect(h.api.sent.at(-1)?.text).not.toContain('你让我做的');
  });

  it('需要你处理这类不结束关注，继续跟到完成', async () => {
    const h = harness();
    await bound(h);
    follow(h, 'session', 'c1', '加字段');
    h.service.onMilestone({ kind: 'needs-user', title: 'A · B', conversationId: 'c1' });
    await waitFor(() => h.api.sent.length > 0, 'needs-user');
    expect(h.following.list()).toHaveLength(1);
    h.service.onMilestone({ kind: 'failed', title: 'A · B', conversationId: 'c1' });
    await waitFor(() => h.following.list().length === 0, 'failed ends follow');
  });

  it('notify=off 也不挡手机关注任务的结果：完成照样推，推完结束关注', async () => {
    const h = harness();
    await bound(h);
    h.world.mode = 'off';
    follow(h, 'session', 'c1', '加字段');
    h.service.onMilestone({ kind: 'goal-complete', title: 'A · B', conversationId: 'c1' });
    await waitFor(() => h.api.sent.length > 0, 'milestone');
    expect(h.api.sent.at(-1)?.text).toContain('✅ 完成');
    await waitFor(() => h.following.list().length === 0, 'follow ended');
  });

  it('/sync 打开时不重复推：一条里程碑只发一次', async () => {
    const h = harness();
    await bound(h);
    h.store.save({ ...h.store.file(), syncMirror: true });
    follow(h, 'session', 'c1', '加字段');
    h.service.onMilestone({ kind: 'goal-complete', title: 'A · B', conversationId: 'c1' });
    await waitFor(() => h.api.sent.length > 0, 'milestone');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent).toHaveLength(1);
    expect(h.api.sent[0]?.text).toContain('你让我做的「加字段」');
    expect(h.following.list()).toEqual([]);
  });

  it('关注的定时到点推一次手机，推完结束关注；没关注的不推', async () => {
    const h = harness();
    await bound(h);
    follow(h, 'schedule', 'sch1', '每天早上看 CI');
    h.service.onScheduleFired({ scheduleId: 'sch1', text: '每天早上看 CI：看 CI 结果' });
    await waitFor(() => h.api.sent.length > 0, 'schedule push');
    expect(h.api.sent.at(-1)?.text).toContain('⏰ 你让我设的「每天早上看 CI」到点了');
    await waitFor(() => h.following.list().length === 0, 'schedule follow ended');
    h.service.onScheduleFired({ scheduleId: 'sch2', text: '别的定时' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent).toHaveLength(1);
  });

  it('/following 列出、逐个取消、clear', async () => {
    const h = harness();
    await bound(h);
    follow(h, 'session', 'c1', '加字段');
    follow(h, 'schedule', 'sch1', '看 CI');
    h.api.push(privateMessage('/following'));
    await waitFor(() => h.api.sent.length > 0, 'listed');
    const listed = h.api.sent.at(-1);
    expect(listed?.text).toContain('手机关注 2');
    expect(listed?.text).toContain('加字段');
    expect(listed?.text).toContain('看 CI');
    expect(listed?.replyMarkup?.inline_keyboard.flat().map((row) => row.callback_data)).toEqual([
      'fo:c:1',
      'fo:c:2',
      'fo:x',
    ]);
    // 取消第 1 项：列表原地重画
    h.api.push({
      update_id: 2,
      callback_query: { id: 'cb-1', data: 'fo:c:1', message: { message_id: 9, chat: { id: 777 } } },
    });
    await waitFor(() => h.following.list().length === 1, 'cancelled');
    expect(h.following.list()).toMatchObject([{ targetId: 'sch1' }]);
    expect(h.api.edited.at(-1)?.text).toContain('手机关注 1');
    expect(h.api.callbacks.at(-1)?.text).toBe('已取消关注');
    // /following clear 全清
    h.api.push(privateMessage('/following clear'));
    await waitFor(() => h.following.list().length === 0, 'cleared');
    expect(h.api.sent.at(-1)?.text).toContain('已清空 1');
  });

  it('解绑时关注列表一起清空', async () => {
    const h = harness();
    await bound(h);
    follow(h, 'session', 'c1', '加字段');
    follow(h, 'schedule', 'sch1', '看 CI');
    await h.service.unbind();
    expect(h.following.list()).toEqual([]);
    expect(h.audits.some((entry) => entry.op === 'contact_follow_clear')).toBe(true);
  });

  it('关注列表跟着联系方式状态一起给界面', async () => {
    const h = harness();
    await bound(h);
    expect(h.service.state().telegram.following).toEqual([]);
    follow(h, 'session', 'c1', '加字段');
    expect(h.service.state().telegram.following).toMatchObject([
      { id: 'session:c1', kind: 'session', summary: '加字段' },
    ]);
  });

  it('重启后关注列表还在', async () => {
    const h = harness();
    await bound(h);
    follow(h, 'session', 'c1', '加字段');
    const restarted = h.restart();
    expect(restarted.state().telegram.following).toMatchObject([{ id: 'session:c1' }]);
  });

  it('只有手机发起的回合才算手机发起：回复发出后就不再算', async () => {
    const h = harness();
    await bound(h);
    expect(h.service.phoneTurnChat('sec-1')).toBeNull();
    h.api.push(privateMessage('给 apple-table 加个字段'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    expect(h.service.phoneTurnChat('sec-1')).toEqual({ channelId: 'telegram', peerId: '777' });
    expect(h.service.phoneTurnChat('other')).toBeNull();
    h.service.onTurnReply('sec-1', '要你点确认卡');
    expect(h.service.phoneTurnChat('sec-1')).toBeNull();
  });

  it('手机发起后派了会话：结果回传注入的那一轮也回推同一个 chat', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('透明背景下 onboarding 遮罩叠了空会话页'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    // 秘书派了编码会话：关注项挂在秘书会话上，链就一直活着
    follow(h, 'session', 'c1', '修 onboarding 遮罩', 'sec-1');
    h.service.onTurnReply('sec-1', '已派 c1 去修，修完回你', { turnId: 't1' });
    await waitFor(() => h.api.sent.length === 1, 'first reply');
    expect(h.api.sent[0]?.chatId).toBe(777);
    // 编码会话收口：关注结束，结果回传注入秘书会话
    h.following.remove('session:c1');
    h.service.onTurnReply('sec-1', '修好了，提交 1a2b3c4', { delivery: true, turnId: 't2' });
    await waitFor(() => h.api.sent.length === 2, 'result reply');
    expect(h.api.sent[1]?.chatId).toBe(777);
    expect(h.api.sent[1]?.text).toContain('修好了');
    // 链断了：之后应用里自己聊的不再推
    h.service.onTurnReply('sec-1', '巡检正常', { turnId: 't3' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent).toHaveLength(2);
  });

  it('同一轮只回推一次：事件重放与镜像撞车都只发一条', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('在吗'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    h.service.onTurnReply('sec-1', '在', { turnId: 't1' });
    await waitFor(() => h.api.sent.length === 1, 'reply');
    // 同一轮重放：awaitingReply 已经用掉，落到镜像分支也不该再发
    h.store.save({ ...h.store.file(), syncMirror: true });
    h.service.onTurnReply('sec-1', '在', { turnId: 't1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent).toHaveLength(1);
  });

  it('silence_turn 的轮次不投递：手机发起的与链上的都不发', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('在吗'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    follow(h, 'session', 'c1', '修 onboarding 遮罩', 'sec-1');
    h.service.onTurnSilent('sec-1', 2);
    h.following.remove('session:c1');
    h.service.onTurnSilent('sec-1', 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent).toEqual([]);
  });

  it('链上的超长回复一样分条发，不因 4096 上限整条丢掉', async () => {
    const h = harness();
    await bound(h);
    h.api.push(privateMessage('写个长报告'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    follow(h, 'session', 'c1', '写长报告', 'sec-1');
    h.service.onTurnReply('sec-1', '已派发', { turnId: 't1' });
    await waitFor(() => h.api.sent.length === 1, 'first');
    h.following.remove('session:c1');
    h.service.onTurnReply('sec-1', 'x'.repeat(5000), { delivery: true, turnId: 't2' });
    await waitFor(() => h.api.sent.length > 2, 'split');
    const chunks = h.api.sent.slice(1);
    expect(chunks.length).toBe(2);
    expect(chunks.every((entry) => entry.text.length <= 3900)).toBe(true);
    expect(chunks.map((entry) => entry.text).join('')).toHaveLength(5000);
  });

  it('不是手机发起的回合不回推：应用里自己聊的、系统回传的都不发', async () => {
    const h = harness();
    await bound(h);
    h.service.onTurnReply('sec-1', '巡检正常', { turnId: 't1' });
    h.service.onTurnReply('sec-1', '结果回传', { delivery: true, turnId: 't2' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent).toEqual([]);
  });

  it('回复里带确认卡或审批时点明「需要在应用里确认」', async () => {
    const h = harness();
    await bound(h);
    h.service.onCardWaiting({ count: 1, approval: true, conversationId: 'sec-1' });
    await waitFor(() => h.api.sent.length === 1, 'approval notice');
    h.api.push(privateMessage('把登录修一下'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    h.service.onTurnReply('sec-1', '已经确认了，正在跑', { turnId: 't1' });
    await waitFor(() => h.api.sent.length === 2, 'reply');
    expect(h.api.sent[1]?.text).toContain('需要在应用里确认');
  });

  it('手机上确认卡片期间派生的会话也算手机发起', async () => {
    const h = harness();
    await bound(h);
    h.store.save({ ...h.store.file(), allowCardConfirm: true });
    h.service.syncPendingCards([
      { id: 'p1', kind: 'dispatch', title: '加字段', conversationId: 'sec-1' },
    ]);
    await waitFor(() => h.api.sent.length > 0, 'card');
    const button = h.api.sent.at(-1)?.replyMarkup?.inline_keyboard.flat()[0];
    expect(button?.callback_data).toBe('card:c:p1');
    const seen: unknown[] = [];
    h.ports.resolveProposal = async () => {
      seen.push(h.service.phoneTurnChat('sec-1'));
      return { ok: true };
    };
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: 'card:c:p1' } });
    await waitFor(() => seen.length > 0, 'confirmed');
    expect(seen).toEqual([{ channelId: 'telegram', peerId: '777' }]);
    // 确认完就收回：之后桌面上的派发不算手机发起
    expect(h.service.phoneTurnChat('sec-1')).toBeNull();
  });
});

describe('秘书会话被回收后的入站', () => {
  /** 真实投递口：先看 worker 在不在，不在就拉起再投 */
  function wakeable(h: ReturnType<typeof harness>, alive: boolean, resumeOk = true) {
    const calls: string[] = [];
    h.ports.deliver = (id, text) =>
      deliverToSecretary(
        {
          alive: () => alive,
          resume: async (target) => {
            calls.push(`resume:${target}`);
            if (resumeOk) alive = true;
            return resumeOk ? { ok: true } : { ok: false, error: 'no remembered model' };
          },
          prompt: (target, body) => {
            calls.push(`prompt:${target}`);
            h.world.delivered.push(body);
            return { ok: true };
          },
        },
        id,
        text
      );
    return calls;
  }

  async function bound(h: ReturnType<typeof harness>): Promise<void> {
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.api.sent.length = 0;
  }

  it('秘书没在跑：入站文本先拉起会话，再送入这句话', async () => {
    const h = harness();
    const calls = wakeable(h, false);
    await bound(h);
    h.api.push(privateMessage('在吗'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    expect(calls).toEqual(['resume:sec-1', 'prompt:sec-1']);
    expect(h.world.delivered[0]).toContain('在吗');
    expect(h.audits.find((entry) => entry.op === 'contact_inbound')?.ok).toBe(true);
  });

  it('会话已在跑：直接投，不重复拉起', async () => {
    const h = harness();
    const calls = wakeable(h, true);
    await bound(h);
    h.api.push(privateMessage('在吗'));
    h.api.push(privateMessage('还在吗'));
    await waitFor(() => h.world.delivered.length > 1, 'delivered');
    expect(calls).toEqual(['prompt:sec-1', 'prompt:sec-1']);
  });

  it('拉起失败：给这个 chat 回一句失败说明，不静默', async () => {
    const h = harness();
    const calls = wakeable(h, false, false);
    await bound(h);
    h.api.push(privateMessage('在吗'));
    await waitFor(() => h.api.sent.length > 0, 'failure notice');
    expect(calls).toEqual(['resume:sec-1']);
    expect(h.world.delivered).toEqual([]);
    expect(h.api.sent.at(-1)?.chatId).toBe(777);
    expect(h.api.sent.at(-1)?.text).toContain('没送到');
    expect(h.audits.find((entry) => entry.op === 'contact_inbound')).toMatchObject({
      ok: false,
      detail: 'no remembered model',
    });
  });

  it('没有可用的秘书会话：也回一句说明', async () => {
    const h = harness();
    h.world.conversationId = null;
    await bound(h);
    h.api.push(privateMessage('在吗'));
    await waitFor(() => h.api.sent.length > 0, 'failure notice');
    expect(h.world.delivered).toEqual([]);
    expect(h.api.sent.at(-1)?.text).toContain('没送到');
  });

  it.each(['/status', '/board', '/feed', '/todo', '/schedules', '/memory', '/help'])(
    '只读命令 %s 由 Main 直接回，不拉起秘书',
    async (command) => {
      const h = harness();
      const calls = wakeable(h, false);
      await bound(h);
      h.api.push(privateMessage(command));
      await waitFor(() => h.api.sent.length > 0, 'command reply');
      expect(calls).toEqual([]);
      expect(h.world.delivered).toEqual([]);
    }
  );
});

/** 假的插件渠道：没按钮、不能改消息，出站全部记下来 */
class FakePlainChannel implements ContactChannel {
  readonly id = 'enso.clawbot:wechat';
  sent: { peerId: string; kind: string; text: string }[] = [];
  typings: string[] = [];
  settles = 0;
  private seq = 0;
  constructor(private readonly extra: Partial<ChannelCaps> = {}) {}
  caps(): ChannelCaps {
    return {
      buttons: false,
      urlButtons: false,
      edit: false,
      typing: true,
      format: 'plain',
      maxChars: 2000,
      commandMenu: false,
      ...this.extra,
    };
  }
  private record(kind: string, peerId: string, message: ChannelMessage) {
    expect(message.buttons ?? []).toEqual([]);
    this.sent.push({ peerId, kind, text: message.text });
    this.seq += 1;
    return Promise.resolve({ ok: true as const, messageId: `m${this.seq}` });
  }
  sendText(peerId: string, message: ChannelMessage) {
    return this.record('text', peerId, message);
  }
  ask(peerId: string, message: ChannelMessage) {
    return this.record('ask', peerId, message);
  }
  confirmCards(peerId: string, message: ChannelMessage) {
    return this.record('cards', peerId, message);
  }
  approvalNotice(peerId: string, message: ChannelMessage) {
    return this.record('approval', peerId, message);
  }
  settle() {
    this.settles += 1;
    return Promise.resolve({ ok: true as const });
  }
  typing(peerId: string) {
    this.typings.push(peerId);
    return Promise.resolve({ ok: true as const });
  }
}

describe('多渠道联系方式', () => {
  const WECHAT = 'enso.clawbot:wechat';
  const wxPeer = { channelId: WECHAT, peerId: 'wx-me' };

  async function boundTelegram() {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    return h;
  }

  function addWechat(
    h: ReturnType<typeof harness>,
    options: { push?: boolean; cardConfirm?: boolean; caps?: Partial<ChannelCaps> } = {}
  ) {
    const channel = new FakePlainChannel(options.caps);
    h.service.declareChannel({
      id: WECHAT,
      title: '微信',
      builtin: false,
      pluginId: 'enso.clawbot',
    });
    h.service.attachChannel(WECHAT, channel);
    h.service.setChannelStatus(WECHAT, { status: 'connected', peers: ['wx-me'] });
    h.service.setChannelPrefs(WECHAT, {
      enabled: true,
      push: options.push ?? true,
      cardConfirm: options.cardConfirm ?? false,
    });
    return channel;
  }

  it('Telegram 固定第一位并标成内置；插件渠道默认关着', () => {
    const h = harness();
    h.service.declareChannel({
      id: WECHAT,
      title: '微信',
      builtin: false,
      pluginId: 'enso.clawbot',
    });
    const channels = h.service.state().channels;
    expect(channels.map((item) => [item.id, item.builtin, item.status])).toEqual([
      ['telegram', true, 'unconfigured'],
      [WECHAT, false, 'unconfigured'],
    ]);
    expect(channels[1]?.prefs.enabled).toBe(false);
    expect(h.service.state().enabled).toBe(true);
  });

  it('里程碑发给所有启用、已连接、打开推送的渠道；关掉推送的不发', async () => {
    const h = await boundTelegram();
    const wechat = addWechat(h);
    const before = h.api.sent.length;
    h.service.onMilestone({ kind: 'goal-complete', title: 'p · 修登录', conversationId: 'c1' });
    await waitFor(() => wechat.sent.length === 1 && h.api.sent.length === before + 1, 'both');
    // 没有 url 按钮的渠道：深链写进正文
    expect(wechat.sent[0]?.text).toContain('enso://');
    h.service.setChannelPrefs(WECHAT, { push: false });
    h.service.onMilestone({ kind: 'failed', title: 'p · 修构建', conversationId: 'c2' });
    await waitFor(() => h.api.sent.length === before + 2, 'telegram only');
    expect(wechat.sent).toHaveLength(1);
  });

  it('插件渠道发来的话带渠道名进秘书会话，回复只回原来的联系人', async () => {
    const h = await boundTelegram();
    const wechat = addWechat(h);
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '把登录修一下', name: '小明' });
    expect(h.world.delivered.at(-1)).toMatch(
      /^\[来自 微信 @小明\]\n<untrusted-content source="enso\.clawbot:wechat:@小明">把登录修一下<\/untrusted-content>$/u
    );
    expect(h.service.phoneTurnChat('sec-1')).toEqual(wxPeer);
    h.service.onTurnStart('sec-1');
    await waitFor(() => wechat.typings.length > 0, 'typing');
    expect(h.api.chatActions).toHaveLength(0);
    const before = h.api.sent.length;
    h.service.onTurnReply('sec-1', '好的，已经派出去了');
    await waitFor(() => wechat.sent.length > 0, 'reply');
    expect(wechat.sent.at(-1)?.text).toBe('好的，已经派出去了');
    expect(h.api.sent.length).toBe(before);
  });

  it('同一轮两个渠道都说话，就两边都回', async () => {
    const h = await boundTelegram();
    const wechat = addWechat(h);
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '在吗' });
    h.api.push(privateMessage('还有这个'));
    await waitFor(() => h.world.delivered.length === 2, 'both delivered');
    const before = h.api.sent.length;
    h.service.onTurnReply('sec-1', '都收到了');
    await waitFor(() => wechat.sent.length > 0 && h.api.sent.length > before, 'both replied');
    expect(h.api.sent.at(-1)?.text).toContain('都收到了');
  });

  it('提问在没按钮的渠道变成编号文本；回序号就是选这一项，Telegram 那条跟着收尾', async () => {
    const h = await boundTelegram();
    const wechat = addWechat(h);
    h.service.onAskRequest('sec-1', {
      requestId: 'r1',
      question: '用哪个分支？',
      options: ['main', 'dev'],
    } as never);
    await waitFor(() => wechat.sent.length > 0 && h.api.sent.length > 1, 'ask sent');
    expect(wechat.sent[0]?.text).toContain('1. main');
    expect(wechat.sent[0]?.text).toContain('回复序号');
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '2' });
    expect(h.world.answers).toEqual([{ requestId: 'r1', answer: 'dev' }]);
    await waitFor(() => h.api.edited.length > 0, 'telegram settled');
    expect(h.api.edited.at(-1)?.text).toContain('dev');
    // 没编辑能力的渠道不改旧消息
    expect(wechat.settles).toBe(0);
  });

  it('确认卡：没按钮的渠道回「确认 1」，开关关着时绝不执行', async () => {
    const h = await boundTelegram();
    const wechat = addWechat(h, { cardConfirm: false });
    h.service.syncPendingCards([
      { id: 'p1', kind: 'dispatch', title: '修登录', conversationId: 'sec-1' },
    ]);
    await waitFor(() => wechat.sent.length > 0, 'card');
    expect(wechat.sent[0]?.text).toContain('关着手机确认');
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '确认 1' });
    expect(h.world.resolved).toEqual([]);

    h.service.setChannelPrefs(WECHAT, { cardConfirm: true });
    h.service.syncPendingCards([]);
    h.service.syncPendingCards([
      { id: 'p2', kind: 'dispatch', title: '加字段', conversationId: 'sec-1' },
    ]);
    await waitFor(() => wechat.sent.some((item) => item.text.includes('确认 1')), 'card 2');
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '确认 1' });
    expect(h.world.resolved).toEqual([{ proposalId: 'p2', action: 'confirm' }]);
    // 谁先答算谁的：Telegram 上同一张卡随后收尾
    await waitFor(
      () => h.api.edited.some((item) => item.text.includes('加字段')),
      'telegram card settled'
    );
  });

  it('审批在任何渠道都不能确认', async () => {
    const h = await boundTelegram();
    const wechat = addWechat(h, { cardConfirm: true });
    h.service.onCardWaiting({ count: 1, approval: true, conversationId: 'sec-1' });
    await waitFor(() => wechat.sent.length > 0, 'approval');
    expect(wechat.sent[0]?.text).toContain('审批只能在应用里处理');
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '确认 1' });
    expect(h.world.resolved).toEqual([]);
    h.api.push({ update_id: 9, callback_query: { id: 'cb', data: 'card:c:approval:1' } });
    await waitFor(() => h.api.callbacks.length > 0, 'callback');
    expect(h.world.resolved).toEqual([]);
  });

  it('总开关关掉：不收不发，只读命令也不回', async () => {
    const h = await boundTelegram();
    const wechat = addWechat(h);
    await h.service.setEnabled(false);
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '/status' });
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '在吗' });
    h.service.onMilestone({ kind: 'goal-complete', title: 'x', conversationId: 'c1' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wechat.sent).toEqual([]);
    expect(h.world.delivered).toEqual([]);
    expect(h.world.commandCalls).toEqual([]);
    expect(h.store.file().enabled).toBe(false);
    expect(h.service.state().enabled).toBe(false);
  });

  it('只读命令在插件渠道也不进秘书会话', async () => {
    const h = harness();
    const wechat = addWechat(h);
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '/status' });
    expect(h.world.delivered).toEqual([]);
    expect(wechat.sent.at(-1)?.text).toContain('修登录');
  });

  it('关注项记的是发起它的联系人；任务结果只回那里', async () => {
    const h = await boundTelegram();
    const wechat = addWechat(h);
    h.following.add({ kind: 'session', targetId: 'c9', origin: wxPeer, at: 1, summary: '修登录' });
    const before = h.api.sent.length;
    h.service.onMilestone({ kind: 'goal-complete', title: 'p · 修登录', conversationId: 'c9' });
    await waitFor(() => wechat.sent.length > 0, 'pushed');
    expect(h.api.sent.length).toBe(before);
    await waitFor(() => h.following.list().length === 0, 'follow done');
  });

  it('微信发起：用户消息进桌面秘书会话，回复与完成结果只回微信，Telegram 未发起收不到', async () => {
    const h = await boundTelegram();
    const wechat = addWechat(h);
    const conversations: string[] = [];
    const deliver = h.ports.deliver;
    h.ports.deliver = (conversationId, text) => {
      conversations.push(conversationId);
      return deliver(conversationId, text);
    };
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '把登录修一下' });
    expect(conversations).toEqual(['sec-1']);
    expect(parseInboundMessage(h.world.delivered.at(-1) ?? '')).toMatchObject({
      channel: WECHAT,
      body: '把登录修一下',
    });
    const before = h.api.sent.length;
    h.service.onTurnReply('sec-1', '已派出去修了', { turnId: 't1' });
    await waitFor(() => wechat.sent.length === 1, 'reply');
    h.following.add({ kind: 'session', targetId: 'c1', origin: wxPeer, at: 1, summary: '修登录' });
    h.service.onMilestone({ kind: 'goal-complete', title: 'p · 修登录', conversationId: 'c1' });
    await waitFor(() => wechat.sent.length === 2, 'result');
    expect(wechat.sent[1]?.text).toContain('✅ 完成 · p · 修登录');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.api.sent.length).toBe(before);
  });

  it('插件停用：卡片消失，关注项与待收尾记录清掉，入站不再路由', async () => {
    const h = await boundTelegram();
    addWechat(h);
    h.following.add({ kind: 'session', targetId: 'c9', origin: wxPeer, at: 1, summary: '修登录' });
    h.following.add({
      kind: 'session',
      targetId: 'c8',
      origin: { channelId: 'telegram', peerId: '777' },
      at: 2,
      summary: 'tg',
    });
    h.service.removeChannel(WECHAT);
    expect(h.service.state().channels.map((item) => item.id)).toEqual(['telegram']);
    expect(h.following.list().map((item) => item.targetId)).toEqual(['c8']);
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '在吗' });
    expect(h.world.delivered).toEqual([]);
  });

  it('重新扫码换了人：旧联系人的等待回复作废', async () => {
    const h = harness();
    const wechat = addWechat(h);
    await h.service.inbound({ kind: 'text', peer: wxPeer, text: '在吗' });
    h.service.setChannelStatus(WECHAT, { status: 'connected', peers: ['wx-other'] });
    h.service.onTurnReply('sec-1', '回你');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wechat.sent).toEqual([]);
  });
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedCursor } from '@shared/secretary/feed';
import type { SecretaryAuditEntry, SecretaryProfile } from '@shared/types/secretary';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TelegramApi,
  TelegramCommandOptions,
  TelegramInlineKeyboard,
  TelegramMenuButton,
  TelegramUpdate,
  TelegramUser,
} from './client';
import { TelegramApiError } from './client';
import { type ContactServicePorts, TelegramContactService } from './service';
import { ContactStore } from './store';

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
    this.edited.push(params);
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
  const service = new TelegramContactService(store, ports);
  return {
    dir,
    store,
    api,
    audits,
    clock,
    world,
    service,
    /** 模拟重启：新的 store 从磁盘读，新的服务没有内存态 */
    restart: () => new TelegramContactService(new ContactStore(dir), ports),
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
  it('开关关闭时只给「在应用里打开」，没有任何确认按钮', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.syncPendingCards([
      { id: 'p1', kind: 'dispatch', title: '修登录', conversationId: 'sec-1' },
    ]);
    await waitFor(() => h.api.sent.length > 1, 'card notice sent');
    const message = h.api.sent.at(-1);
    expect(message?.text).toContain('有一张卡在等你 · 修登录');
    expect(message?.text).toContain('请回应用确认');
    // 出站统一走 markdown→HTML，& 会转义成 &amp;，深链本身不变
    expect(message?.text).toContain('conversation=sec-1');
    expect(message?.text).toContain('proposal=p1');
    const buttons = message?.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(buttons.map((button) => button.text)).toEqual(['在应用里打开']);
    expect(h.world.resolved).toHaveLength(0);
  });

  it('开关打开后每张卡一个「确认<类型>：<标题>」按钮，点一下直接确认', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.setAllowCardConfirm(true);
    h.service.syncPendingCards([
      { id: 'p1', kind: 'dispatch', title: '秘书看板改用 kanban', conversationId: 'sec-1' },
    ]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    const message = h.api.sent.at(-1);
    const rows = message?.replyMarkup?.inline_keyboard ?? [];
    expect(rows[0].map((button) => button.text)).toEqual(['确认派发：秘书看板改用 kanban']);
    expect(rows[1].map((button) => button.text)).toEqual(['在应用里打开']);
    h.api.push({
      update_id: 2,
      callback_query: { id: 'cb-1', data: rows[0][0].callback_data },
    });
    await waitFor(() => h.world.resolved.length > 0, 'proposal resolved');
    expect(h.world.resolved[0]).toEqual({ proposalId: 'p1', action: 'confirm' });
    expect(h.api.callbacks.at(-1)?.text).toBe('已确认：派发 秘书看板改用 kanban');
    expect(
      h.audits.some(
        (entry) => entry.op === 'contact_card_confirm' && entry.ok && entry.detail === '派发'
      )
    ).toBe(true);
  });

  it('开关打开后设置、技能、工具、接管卡片都能确认，按钮文案带类型', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.setAllowCardConfirm(true);
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
    for (const [index, proposalId] of ['p-profile', 'p-skill', 'p-tool', 'p-takeover'].entries()) {
      h.api.push({
        update_id: 10 + index,
        callback_query: { id: `cb-${index}`, data: rows[index][0].callback_data },
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
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.setAllowCardConfirm(true);
    h.service.onCardWaiting({ count: 1, approval: true, conversationId: 'sec-1' });
    await waitFor(() => h.api.sent.length > 1, 'approval notice');
    const message = h.api.sent.at(-1);
    expect(message?.text).toContain('审批只能在应用里处理');
    const buttons = message?.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(buttons.map((button) => button.text)).toEqual(['在应用里打开']);
    expect(h.world.resolved).toHaveLength(0);
  });

  it('「在应用里打开」只把卡片交给 Main，不确认', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.syncPendingCards([
      { id: 'p1', kind: 'dispatch', title: '修登录', conversationId: 'sec-1' },
    ]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    const open = h.api.sent.at(-1)?.replyMarkup?.inline_keyboard[0][0];
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: open?.callback_data ?? '' } });
    await waitFor(() => h.world.opened.length > 0, 'opened in app');
    expect(h.world.opened[0]).toEqual({ conversationId: 'sec-1', proposalId: 'p1' });
    expect(h.world.resolved).toHaveLength(0);
    expect(h.api.callbacks.at(-1)?.text).toBe('已在应用里打开');
  });

  it('确认之后按钮清掉并补一行已处理', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.setAllowCardConfirm(true);
    h.service.syncPendingCards([
      { id: 'p1', kind: 'dispatch', title: '修登录', conversationId: 'sec-1' },
    ]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    const messageId = h.api.sent.length;
    const data = h.api.sent.at(-1)?.replyMarkup?.inline_keyboard[0][0].callback_data ?? '';
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data } });
    await waitFor(() => h.api.edited.length > 0, 'message edited');
    const edited = h.api.edited.at(-1);
    expect(edited?.messageId).toBe(messageId);
    expect(edited?.text).toContain('已处理');
    expect(edited?.replyMarkup).toEqual({ inline_keyboard: [] });
  });

  it('卡片在应用里处理掉之后按钮也失效', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.setAllowCardConfirm(true);
    h.service.syncPendingCards([
      { id: 'p1', kind: 'dispatch', title: '修登录', conversationId: 'sec-1' },
    ]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    // 界面里确认了：下一次状态同步里这张卡不再 pending
    h.service.syncPendingCards([]);
    await waitFor(() => h.api.edited.length > 0, 'message settled');
    expect(h.api.edited.at(-1)?.replyMarkup).toEqual({ inline_keyboard: [] });
    const data = h.api.sent.at(-1)?.replyMarkup?.inline_keyboard[0][0].callback_data ?? '';
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data } });
    await waitFor(() => h.api.callbacks.length > 0, 'callback');
    expect(h.api.callbacks.at(-1)?.text).toBe('这张卡已经处理过了');
    expect(h.world.resolved).toHaveLength(0);
  });

  it('同一张卡只推一次', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    const card = { id: 'p1', kind: 'dispatch' as const, conversationId: 'sec-1' };
    h.service.syncPendingCards([card]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    const sent = h.api.sent.length;
    h.service.syncPendingCards([card]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.api.sent.length).toBe(sent);
  });

  it('卡片已经处理过再点按钮只提示', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.setAllowCardConfirm(true);
    h.service.syncPendingCards([
      { id: 'p1', kind: 'dispatch', title: '修登录', conversationId: 'sec-1' },
    ]);
    await waitFor(() => h.api.sent.length > 1, 'card notice');
    const data = h.api.sent.at(-1)?.replyMarkup?.inline_keyboard[0][0].callback_data ?? '';
    h.world.proposalOk = false;
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data } });
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

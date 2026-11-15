import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedCursor } from '@shared/secretary/feed';
import type { SecretaryAuditEntry, SecretaryProfile } from '@shared/types/secretary';
import { afterEach, describe, expect, it } from 'vitest';
import type { TelegramApi, TelegramInlineKeyboard, TelegramUpdate, TelegramUser } from './client';
import { TelegramContactService } from './service';
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
  commands: { command: string; description: string }[][] = [];
  callbacks: { callbackQueryId: string; text?: string }[] = [];
  polls = 0;
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

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    this.commands.push(commands);
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
  };
  const service = new TelegramContactService(store, {
    audit: (entry) => audits.push(entry),
    publish: () => {},
    now: () => clock.now,
    random: () => 0.123456,
    lang: () => 'zh',
    notifyMode: () => world.mode,
    secretaryConversationId: () => world.conversationId,
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
  });
  return { dir, store, api, audits, clock, world, service };
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

  it('过长的回复截断后再发，不会因为超限整条丢掉', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.api.push(privateMessage('写个长报告'));
    await waitFor(() => h.world.delivered.length > 0, 'delivered');
    const before = h.api.sent.length;
    h.service.onTurnReply('sec-1', 'x'.repeat(5000));
    await waitFor(() => h.api.sent.length > before, 'reply sent');
    const sent = h.api.sent.at(-1)?.text ?? '';
    expect(sent.length).toBeLessThanOrEqual(3901);
    expect(sent.endsWith('…')).toBe(true);
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

describe('确认卡与审批不从手机处理', () => {
  it('开关关闭时只提示回应用确认，没有任何按钮', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.onCardWaiting({
      count: 2,
      title: '派发：修登录',
      cards: [{ id: 'p1', kind: 'dispatch' }],
    });
    await waitFor(() => h.api.sent.length > 1, 'card notice sent');
    const text = h.api.sent.at(-1)?.text ?? '';
    expect(text).toContain('有一张卡在等你');
    expect(text).toContain('请回应用确认');
    expect(h.api.sent.at(-1)?.replyMarkup).toBeUndefined();
    expect(h.world.resolved).toHaveLength(0);
  });

  it('打开开关后只有派发卡片能确认，设置与接管卡片仍然只提示', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.setAllowDispatchConfirm(true);
    h.service.onCardWaiting({
      count: 2,
      cards: [
        { id: 'p-dispatch', kind: 'dispatch' },
        { id: 'p-profile', kind: 'profile' },
      ],
    });
    await waitFor(() => h.api.sent.length > 1, 'card notice sent');
    const buttons = h.api.sent.at(-1)?.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(buttons.map((button) => button.text)).toEqual(['确认派发', '拒绝']);
    h.api.push({ update_id: 2, callback_query: { id: 'cb-1', data: buttons[0].callback_data } });
    await waitFor(() => h.world.resolved.length > 0, 'proposal resolved');
    expect(h.world.resolved[0]).toEqual({ proposalId: 'p-dispatch', action: 'confirm' });
    expect(h.api.callbacks.at(-1)?.text).toBe('已确认派发');

    // 设置卡片即使开关打开也只提示
    h.service.onCardWaiting({ count: 1, cards: [{ id: 'p-profile', kind: 'profile' }] });
    await waitFor(() => h.api.sent.length > 2, 'profile card notice');
    expect(h.api.sent.at(-1)?.replyMarkup).toBeUndefined();
    expect(h.api.sent.at(-1)?.text).toContain('请回应用确认');
  });

  it('审批只有提示，没有确认入口', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.setAllowDispatchConfirm(true);
    h.service.onCardWaiting({ count: 1 });
    await waitFor(() => h.api.sent.length > 1, 'approval notice');
    expect(h.api.sent.at(-1)?.replyMarkup).toBeUndefined();
    expect(h.world.resolved).toHaveLength(0);
  });

  it('卡片已经处理过再点按钮只提示', async () => {
    const h = harness();
    await h.service.bind(TOKEN);
    h.api.push(privateMessage('/start 123456'));
    await waitFor(() => h.service.state().telegram.status === 'bound', 'bound');
    h.service.setAllowDispatchConfirm(true);
    h.service.onCardWaiting({ count: 1, cards: [{ id: 'p1', kind: 'dispatch' }] });
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
    const menu = h.api.commands.at(-1)?.map((entry) => entry.command) ?? [];
    expect(menu).toContain('status');
    expect(menu).not.toContain('memory');

    h.service.setAllowMemory(true);
    const after = h.api.commands.at(-1)?.map((entry) => entry.command) ?? [];
    expect(after).toContain('memory');
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
});

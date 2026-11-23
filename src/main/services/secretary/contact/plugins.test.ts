import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContactChannelContrib } from '@shared/extensionPlugins/manifest';
import { afterEach, describe, expect, it } from 'vitest';
import { FollowingStore } from '../following';
import { connectPluginChannels, type PluginContactSource } from './plugins';
import { ContactService } from './service';
import { ContactStore } from './store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CAPS = {
  buttons: true,
  urlButtons: true,
  edit: true,
  typing: true,
  format: 'html' as const,
  maxChars: 2000,
  commandMenu: true,
  images: false,
  files: false,
};

function setup(options?: {
  plugins?: { pluginId: string; channels: PluginContactChannelContrib[] }[];
  callContact?: (pluginId: string, channelId: string, request: unknown) => Promise<unknown>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'contact-plugins-'));
  dirs.push(dir);
  const following = new FollowingStore(dir);
  const delivered: string[] = [];
  const calls: unknown[] = [];
  const errors: Array<{ code: string; detail?: string; channelId?: string }> = [];
  const listeners = new Set<() => void>();
  let now = 1_000;
  let publishCount = 0;
  let plugins: { pluginId: string; channels: PluginContactChannelContrib[] }[] =
    options?.plugins ?? [
      {
        pluginId: 'enso.clawbot',
        channels: [{ id: 'wechat', title: '微信', settingsView: 'view.html', icon: 'icon.svg' }],
      },
    ];
  let callImpl:
    | ((pluginId: string, channelId: string, request: unknown) => Promise<unknown>)
    | undefined = options?.callContact;
  const source: PluginContactSource = {
    contactChannels: () => plugins,
    callContact: async (pluginId, channelId, request) => {
      calls.push({ pluginId, channelId, ...request });
      if (callImpl) return callImpl(pluginId, channelId, request);
      return { messageId: 'm1' };
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const service = new ContactService(new ContactStore(dir), {
    audit: () => {},
    publish: () => {
      publishCount += 1;
    },
    now: () => now,
    random: () => 0.5,
    lang: () => 'zh',
    notifyMode: () => 'with-done',
    secretaryName: () => '爱酱',
    secretaryConversationId: () => 'sec-1',
    startConversation: async () => ({ ok: true, conversationId: 'sec-1' }),
    deliver: async (_id, text) => {
      delivered.push(text);
      return { ok: true };
    },
    answerAsk: () => ({ ok: true }),
    resolveProposal: async () => ({ ok: true }),
    openInApp: () => {},
    onError: (code, detail, channelId) => {
      errors.push({ code, ...(detail ? { detail } : {}), ...(channelId ? { channelId } : {}) });
    },
    following,
  });
  const wired = connectPluginChannels(() => [service], source);
  return {
    service,
    following,
    delivered,
    calls,
    errors,
    handlers: wired.handlers,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    publishCount: () => publishCount,
    setCall(
      fn: ((pluginId: string, channelId: string, request: unknown) => Promise<unknown>) | undefined
    ) {
      callImpl = fn;
    },
    disable() {
      plugins = [];
      for (const listener of listeners) listener();
    },
  };
}

describe('插件渠道接入', () => {
  it('清单声明的渠道先出卡片（未配置），register 后可收发；协议只带纯文本，能力降级', async () => {
    const h = setup();
    const card = () => h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat');
    expect(card()).toMatchObject({
      title: '微信',
      pluginId: 'enso.clawbot',
      settingsView: 'view.html',
      icon: 'icon.svg',
      status: 'unconfigured',
      builtin: false,
    });
    h.handlers.register('enso.clawbot', 'enso.clawbot:wechat', CAPS);
    h.handlers.setStatus('enso.clawbot', 'enso.clawbot:wechat', {
      status: 'connected',
      peers: ['wx-me'],
    });
    h.service.setChannelPrefs('enso.clawbot:wechat', { enabled: true });
    expect(card()?.status).toBe('connected');
    expect(card()?.caps).toMatchObject({
      buttons: false,
      edit: false,
      typing: true,
      format: 'plain',
    });

    h.handlers.inbound('enso.clawbot', 'enso.clawbot:wechat', {
      peerId: 'wx-me',
      senderId: 'wx-me',
      chatType: 'private',
      text: '在吗',
      name: '我',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.delivered.at(-1)).toContain('[来自 微信 私聊 chatId=wx-me senderId=wx-me @我]');
    expect(h.delivered.at(-1)).toContain(
      'source="enso.clawbot:wechat chatId=wx-me senderId=wx-me"'
    );
    h.service.onTurnReply('sec-1', '在的');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls).toContainEqual({
      pluginId: 'enso.clawbot',
      channelId: 'wechat',
      op: 'sendText',
      peerId: 'wx-me',
      text: '在的',
    });
  });

  it('别的插件冒用渠道 id、或清单没声明的渠道一律不认', () => {
    const h = setup();
    h.handlers.register('evil.plugin', 'enso.clawbot:wechat', CAPS);
    h.handlers.register('enso.clawbot', 'enso.clawbot:other', CAPS);
    expect(h.service.registry.get('enso.clawbot:wechat')?.channel).toBeNull();
    expect(h.service.registry.get('enso.clawbot:other')).toBeUndefined();
  });

  it('插件停用：卡片消失、关注项清掉、入站不再路由', async () => {
    const h = setup();
    h.handlers.register('enso.clawbot', 'enso.clawbot:wechat', CAPS);
    h.service.setChannelPrefs('enso.clawbot:wechat', { enabled: true });
    h.following.add({
      kind: 'session',
      targetId: 'c1',
      origin: { channelId: 'enso.clawbot:wechat', peerId: 'wx-me' },
      at: 1,
      summary: '修登录',
    });
    h.disable();
    expect(h.service.state().channels.map((item) => item.id)).toEqual(['telegram']);
    expect(h.following.list()).toEqual([]);
    h.handlers.inbound('enso.clawbot', 'enso.clawbot:wechat', { peerId: 'wx-me', text: '在吗' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.delivered).toEqual([]);
  });

  it('插件声明 images/files：图片与文件按 base64 交给插件；没声明就降级成文字', async () => {
    const h = setup();
    h.handlers.register('enso.clawbot', 'enso.clawbot:wechat', { ...CAPS, images: true });
    h.handlers.setStatus('enso.clawbot', 'enso.clawbot:wechat', {
      status: 'connected',
      peers: ['wx-me'],
    });
    h.service.setChannelPrefs('enso.clawbot:wechat', { enabled: true, push: true });
    const card = h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat');
    expect(card?.caps).toMatchObject({ images: true, files: false });
    const bytes = Buffer.from([1, 2, 3, 4]);
    const sent = await h.service.sendMedia(null, {
      kind: 'image',
      path: '/tmp/a.png',
      buffer: bytes,
      fileName: 'a.png',
      mimeType: 'image/png',
      caption: '截图',
    });
    expect(sent).toEqual({
      ok: true,
      outcomes: [{ channelId: 'enso.clawbot:wechat', status: 'sent' }],
    });
    expect(h.calls).toContainEqual({
      pluginId: 'enso.clawbot',
      channelId: 'wechat',
      op: 'sendImage',
      peerId: 'wx-me',
      data: bytes.toString('base64'),
      fileName: 'a.png',
      mimeType: 'image/png',
      caption: '截图',
    });
    const fallback = await h.service.sendMedia(null, {
      kind: 'file',
      path: '/tmp/b.zip',
      buffer: bytes,
      fileName: 'b.zip',
    });
    expect(fallback.ok && fallback.outcomes[0]?.status).toBe('fallback');
    const last = h.calls.at(-1) as { op: string; text: string };
    expect(last.op).toBe('sendText');
    expect(last.text).toContain('这个渠道发不了文件');
    expect(last.text).toContain('/tmp/b.zip');
  });

  it('发送失败时保留脱敏截断后的 detail 和 channelId，并兼容结构化 userMessage 与普通 Error', async () => {
    const h = setup();
    h.handlers.register('enso.clawbot', 'enso.clawbot:wechat', CAPS);
    h.handlers.setStatus('enso.clawbot', 'enso.clawbot:wechat', {
      status: 'connected',
      peers: ['wx-me'],
    });
    h.service.setChannelPrefs('enso.clawbot:wechat', { enabled: true, push: true });

    // 旧插件只抛普通 Error，且混入 token 与超长文本
    h.setCall(async () => {
      throw new Error(
        `sendmessage ret=-2 prepare failed token=secret_abc123456 ${'x'.repeat(300)}`
      );
    });
    h.service.onMilestone({ kind: 'goal-complete', title: '任务1', conversationId: 'c1' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.errors.at(-1)?.channelId).toBe('enso.clawbot:wechat');
    expect(h.errors.at(-1)?.code).toBe('api');
    expect(h.errors.at(-1)?.detail).toContain('sendmessage ret=-2 prepare failed');
    expect(h.errors.at(-1)?.detail).not.toContain('secret_abc123456');
    expect((h.errors.at(-1)?.detail ?? '').length).toBeLessThanOrEqual(240);

    const card1 = h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat');
    expect(card1?.outbound).toMatchObject({
      state: 'degraded',
      consecutiveFailures: 1,
      lastErrorAt: 1_000,
      lastErrorCode: 'api',
    });
    expect(card1?.outbound?.detail).toContain('sendmessage ret=-2 prepare failed');
    expect(card1?.outbound?.detail).not.toContain('secret_abc123456');

    // 新插件返回结构化 code + userMessage
    h.advance(5_000);
    h.setCall(async () => {
      throw Object.assign(new Error('sendmessage ret=-2 prepare failed'), {
        code: 'SESSION_EXPIRED',
        userMessage: '微信会话已过期，请在微信里给机器人发任意一条消息',
      });
    });
    h.service.onMilestone({ kind: 'goal-complete', title: '任务2', conversationId: 'c2' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.errors.at(-1)).toMatchObject({
      channelId: 'enso.clawbot:wechat',
      code: 'api',
      detail: '[SESSION_EXPIRED] sendmessage ret=-2 prepare failed',
    });
    const card2 = h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat');
    expect(card2?.outbound).toMatchObject({
      state: 'degraded',
      consecutiveFailures: 2,
      lastErrorAt: 6_000,
      pluginCode: 'SESSION_EXPIRED',
      userMessage: '微信会话已过期，请在微信里给机器人发任意一条消息',
    });
  });

  it('同一渠道连续失败 3 次后指数退避并暂停推送，熔断期间去重记 warn，冷却到期探活恢复', async () => {
    const h = setup();
    h.handlers.register('enso.clawbot', 'enso.clawbot:wechat', CAPS);
    h.handlers.setStatus('enso.clawbot', 'enso.clawbot:wechat', {
      status: 'connected',
      peers: ['wx-me'],
    });
    h.service.setChannelPrefs('enso.clawbot:wechat', { enabled: true, push: true });
    h.setCall(async () => {
      throw new Error('sendmessage ret=-2 prepare failed');
    });

    const push = async (n: number) => {
      h.service.onMilestone({ kind: 'goal-complete', title: `任务${n}`, conversationId: `c${n}` });
      await new Promise((resolve) => setTimeout(resolve, 10));
    };

    // 第 1、2、3 次失败正常调用，第 3 次触发 1 分钟退避
    await push(1);
    await push(2);
    await push(3);
    expect(h.calls).toHaveLength(3);

    const pausedCard = h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat');
    expect(pausedCard?.outbound).toMatchObject({
      state: 'paused',
      consecutiveFailures: 3,
      pausedUntil: 1_000 + 60_000,
    });

    // 冷却窗口内连续来 5 次推送：全部拦截，只记 1 条去重 warn
    const errorsBefore = h.errors.length;
    await push(4);
    await push(5);
    await push(6);
    await push(7);
    await push(8);
    expect(h.calls).toHaveLength(3);
    const pauseWarns = h.errors.slice(errorsBefore);
    expect(pauseWarns).toHaveLength(1);
    expect(pauseWarns[0]).toMatchObject({
      channelId: 'enso.clawbot:wechat',
      code: 'channel-paused',
    });
    expect(
      h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat')?.outbound
        ?.suppressedCount
    ).toBe(5);

    // 1 分钟冷却到期，放行 1 次探活，依然失败 → 退避升级为 5 分钟
    h.advance(60_000);
    await push(9);
    expect(h.calls).toHaveLength(4);
    expect(
      h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat')?.outbound
    ).toMatchObject({
      state: 'paused',
      consecutiveFailures: 4,
      pausedUntil: 1_000 + 60_000 + 300_000,
    });

    // 5 分钟冷却到期，底层恢复正常 → 探活成功并清空 outbound 错误状态
    h.advance(300_000);
    h.setCall(async () => ({ messageId: 'ok-1' }));
    await push(10);
    expect(h.calls).toHaveLength(5);
    expect(
      h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat')?.outbound
    ).toBeUndefined();
  });

  it('熔断期间收到该渠道入站消息或用户手动重试后立即恢复', async () => {
    const h = setup();
    h.handlers.register('enso.clawbot', 'enso.clawbot:wechat', CAPS);
    h.handlers.setStatus('enso.clawbot', 'enso.clawbot:wechat', {
      status: 'connected',
      peers: ['wx-me'],
    });
    h.service.setChannelPrefs('enso.clawbot:wechat', { enabled: true, push: true });
    h.setCall(async () => {
      throw new Error('sendmessage ret=-2 prepare failed');
    });

    for (let i = 1; i <= 3; i += 1) {
      h.service.onMilestone({ kind: 'goal-complete', title: `A${i}`, conversationId: `a${i}` });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat')?.outbound?.state
    ).toBe('paused');

    // 路径 1：入站消息立即解除熔断，无需等待冷却
    h.setCall(async () => ({ messageId: 'ok-inbound' }));
    h.handlers.inbound('enso.clawbot', 'enso.clawbot:wechat', {
      peerId: 'wx-me',
      senderId: 'wx-me',
      text: '续一下会话',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat')?.outbound
    ).toBeUndefined();
    h.service.onTurnReply('sec-1', '收到，已恢复');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls.at(-1)).toMatchObject({ op: 'sendText', text: '收到，已恢复' });

    // 再次连续失败进入熔断
    h.setCall(async () => {
      throw new Error('sendmessage ret=-2 prepare failed');
    });
    for (let i = 1; i <= 3; i += 1) {
      h.service.onMilestone({ kind: 'goal-complete', title: `B${i}`, conversationId: `b${i}` });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat')?.outbound?.state
    ).toBe('paused');

    // 路径 2：用户手动重试立即解除熔断并发探测
    h.setCall(async () => ({ messageId: 'ok-retry' }));
    const retried = await h.service.retryChannel('enso.clawbot:wechat');
    expect(retried).toEqual({ ok: true });
    expect(
      h.service.state().channels.find((item) => item.id === 'enso.clawbot:wechat')?.outbound
    ).toBeUndefined();

    const callsBefore = h.calls.length;
    h.service.onMilestone({ kind: 'goal-complete', title: 'B4', conversationId: 'b4' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls.length).toBe(callsBefore + 1);
  });

  it('单个插件渠道熔断不影响其他渠道推送', async () => {
    const h = setup({
      plugins: [
        {
          pluginId: 'enso.clawbot',
          channels: [{ id: 'wechat', title: '微信' }],
        },
        {
          pluginId: 'enso.feishu',
          channels: [{ id: 'bot', title: '飞书' }],
        },
      ],
      callContact: async (pluginId) => {
        if (pluginId === 'enso.clawbot') throw new Error('sendmessage ret=-2 prepare failed');
        return { messageId: 'fs-ok' };
      },
    });
    h.handlers.register('enso.clawbot', 'enso.clawbot:wechat', CAPS);
    h.handlers.setStatus('enso.clawbot', 'enso.clawbot:wechat', {
      status: 'connected',
      peers: ['wx-me'],
    });
    h.handlers.register('enso.feishu', 'enso.feishu:bot', CAPS);
    h.handlers.setStatus('enso.feishu', 'enso.feishu:bot', {
      status: 'connected',
      peers: ['fs-me'],
    });
    h.service.setChannelPrefs('enso.clawbot:wechat', { enabled: true, push: true });
    h.service.setChannelPrefs('enso.feishu:bot', { enabled: true, push: true });

    for (let i = 1; i <= 5; i += 1) {
      h.service.onMilestone({ kind: 'goal-complete', title: `任务${i}`, conversationId: `m${i}` });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const wxCalls = h.calls.filter((c) => (c as { pluginId: string }).pluginId === 'enso.clawbot');
    const fsCalls = h.calls.filter((c) => (c as { pluginId: string }).pluginId === 'enso.feishu');
    expect(wxCalls).toHaveLength(3);
    expect(fsCalls).toHaveLength(5);
    expect(
      h.service.state().channels.find((item) => item.id === 'enso.feishu:bot')?.outbound
    ).toBeUndefined();
  });
});

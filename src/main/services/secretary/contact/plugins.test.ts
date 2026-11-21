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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'contact-plugins-'));
  dirs.push(dir);
  const following = new FollowingStore(dir);
  const delivered: string[] = [];
  const calls: unknown[] = [];
  const listeners = new Set<() => void>();
  let plugins: { pluginId: string; channels: PluginContactChannelContrib[] }[] = [
    {
      pluginId: 'enso.clawbot',
      channels: [{ id: 'wechat', title: '微信', settingsView: 'view.html', icon: 'icon.svg' }],
    },
  ];
  const source: PluginContactSource = {
    contactChannels: () => plugins,
    callContact: async (pluginId, channelId, request) => {
      calls.push({ pluginId, channelId, ...request });
      return { messageId: 'm1' };
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const service = new ContactService(new ContactStore(dir), {
    audit: () => {},
    publish: () => {},
    now: () => 1_000,
    random: () => 0.5,
    lang: () => 'zh',
    notifyMode: () => 'with-done',
    secretaryName: () => '爱酱',
    secretaryConversationId: () => 'sec-1',
    deliver: async (_id, text) => {
      delivered.push(text);
      return { ok: true };
    },
    answerAsk: () => ({ ok: true }),
    resolveProposal: async () => ({ ok: true }),
    openInApp: () => {},
    following,
  });
  const wired = connectPluginChannels(() => [service], source);
  return {
    service,
    following,
    delivered,
    calls,
    handlers: wired.handlers,
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
});

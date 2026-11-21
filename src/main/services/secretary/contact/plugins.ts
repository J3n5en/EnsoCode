import type { PluginContactChannelContrib } from '@shared/extensionPlugins/manifest';
import type { PluginContactRequest } from '@shared/extensionPlugins/protocol';
import type { ChannelCaps, ChannelInboundImage, ChannelMeta } from './channel';
import { PluginContactChannel } from './pluginChannel';
import type { ChannelStatusInput, ContactService } from './service';

/** 插件服务里联系方式要用的那几样：已启用的渠道声明、往插件发、变化通知 */
export interface PluginContactSource {
  contactChannels(): { pluginId: string; channels: PluginContactChannelContrib[] }[];
  callContact(pluginId: string, channelId: string, request: PluginContactRequest): Promise<unknown>;
  onChange(listener: () => void): () => void;
}

/** 插件进程经 gate 打进来的三件事；channelId 已是 `<pluginId>:<id>` */
export interface PluginContactBridgeHandlers {
  register(pluginId: string, channelId: string, caps: ChannelCaps): void;
  inbound(
    pluginId: string,
    channelId: string,
    input: {
      /** 会话 id（私聊或群），也是回复目标 */
      peerId: string;
      text: string;
      senderId?: string;
      chatType?: 'private' | 'group';
      chatTitle?: string;
      name?: string;
      at?: number;
      /** 字节由宿主判格式落盘 */
      images?: readonly ChannelInboundImage[];
    }
  ): void;
  setStatus(pluginId: string, channelId: string, input: ChannelStatusInput): void;
}

function localId(pluginId: string, channelId: string): string {
  return channelId.slice(pluginId.length + 1);
}

/**
 * 把插件渠道接到联系方式核心：清单声明的渠道先出卡片，插件 register 后才收发；
 * 插件停用或卸载时卡片消失，路由、关注项与待收尾记录一起清掉。
 * 每个秘书都看得到渠道卡片，但一个渠道只归在自己那里打开了它的秘书：入站只交给它，
 * 没人打开时不响应、只记审计。
 */
export function connectPluginChannels(
  services: () => readonly ContactService[],
  source: PluginContactSource
): { handlers: PluginContactBridgeHandlers; dispose(): void; resync(): void } {
  const declared = (): Map<string, ChannelMeta> => {
    const map = new Map<string, ChannelMeta>();
    for (const { pluginId, channels } of source.contactChannels()) {
      for (const channel of channels) {
        const id = `${pluginId}:${channel.id}`;
        map.set(id, {
          id,
          title: channel.title,
          builtin: false,
          pluginId,
          ...(channel.icon ? { icon: channel.icon } : {}),
          ...(channel.settingsView ? { settingsView: channel.settingsView } : {}),
        });
      }
    }
    return map;
  };

  /** 插件 register 过的实现：新建的秘书也要接上 */
  const attached = new Map<string, PluginContactChannel>();

  const sync = (): Map<string, ChannelMeta> => {
    const metas = declared();
    for (const service of services()) {
      for (const entry of service.registry.list()) {
        if (!entry.meta.builtin && !metas.has(entry.meta.id)) service.removeChannel(entry.meta.id);
      }
      for (const meta of metas.values()) {
        service.declareChannel(meta);
        const channel = attached.get(meta.id);
        if (channel && !service.registry.get(meta.id)?.channel)
          service.attachChannel(meta.id, channel);
      }
    }
    for (const id of attached.keys()) if (!metas.has(id)) attached.delete(id);
    return metas;
  };

  const known = (pluginId: string, channelId: string): boolean =>
    channelId.startsWith(`${pluginId}:`) && sync().has(channelId);

  const handlers: PluginContactBridgeHandlers = {
    register(pluginId, channelId, caps) {
      if (!known(pluginId, channelId)) return;
      const local = localId(pluginId, channelId);
      const channel = new PluginContactChannel(channelId, caps, (request) =>
        source.callContact(pluginId, local, request)
      );
      attached.set(channelId, channel);
      for (const service of services()) service.attachChannel(channelId, channel);
    },
    inbound(pluginId, channelId, input) {
      if (!channelId.startsWith(`${pluginId}:`)) return;
      const all = services().filter((candidate) => candidate.registry.get(channelId)?.channel);
      const service = all.find((candidate) => candidate.ownsChannel(channelId));
      if (!service) {
        // 没有秘书打开这个渠道：不响应，各秘书审计里留一笔
        for (const candidate of all) candidate.rejectUnrouted(channelId);
        return;
      }
      void service.inbound({
        kind: 'text',
        peer: { channelId, peerId: input.peerId },
        text: input.text,
        ...(input.senderId ? { senderId: input.senderId } : {}),
        ...(input.chatType ? { chatType: input.chatType } : {}),
        ...(input.chatTitle ? { chatTitle: input.chatTitle } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.at ? { at: input.at } : {}),
        ...(input.images?.length ? { images: input.images } : {}),
      });
    },
    setStatus(pluginId, channelId, input) {
      if (!known(pluginId, channelId)) return;
      for (const service of services()) service.setChannelStatus(channelId, input);
    },
  };

  sync();
  const off = source.onChange(() => {
    sync();
  });
  return { handlers, dispose: off, resync: () => void sync() };
}

import type { PluginContactChannelContrib } from '@shared/extensionPlugins/manifest';
import type { PluginContactRequest } from '@shared/extensionPlugins/protocol';
import type { ChannelCaps, ChannelMeta } from './channel';
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
 */
export function connectPluginChannels(
  service: ContactService,
  source: PluginContactSource
): { handlers: PluginContactBridgeHandlers; dispose(): void } {
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

  const sync = (): Map<string, ChannelMeta> => {
    const metas = declared();
    for (const entry of service.registry.list()) {
      if (!entry.meta.builtin && !metas.has(entry.meta.id)) service.removeChannel(entry.meta.id);
    }
    for (const meta of metas.values()) service.declareChannel(meta);
    return metas;
  };

  const known = (pluginId: string, channelId: string): boolean =>
    channelId.startsWith(`${pluginId}:`) && sync().has(channelId);

  const handlers: PluginContactBridgeHandlers = {
    register(pluginId, channelId, caps) {
      if (!known(pluginId, channelId)) return;
      const local = localId(pluginId, channelId);
      service.attachChannel(
        channelId,
        new PluginContactChannel(channelId, caps, (request) =>
          source.callContact(pluginId, local, request)
        )
      );
    },
    inbound(pluginId, channelId, input) {
      if (!service.registry.get(channelId)?.channel || !channelId.startsWith(`${pluginId}:`)) {
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
      });
    },
    setStatus(pluginId, channelId, input) {
      if (!known(pluginId, channelId)) return;
      service.setChannelStatus(channelId, input);
    },
  };

  sync();
  const off = source.onChange(() => {
    sync();
  });
  return { handlers, dispose: off };
}

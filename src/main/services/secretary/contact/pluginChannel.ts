import type {
  ChannelCaps,
  ChannelMessage,
  ChannelResult,
  ChannelSend,
  ChannelSettle,
  ContactChannel,
} from './channel';

/** 插件渠道往插件进程发东西：只有纯文本与正在输入两种 */
export type PluginContactCall = (
  request: { op: 'sendText'; peerId: string; text: string } | { op: 'typing'; peerId: string }
) => Promise<unknown>;

/**
 * 插件渠道的 Main 侧代理。协议第一版只带纯文本：按钮、改消息、命令菜单一律当不支持，
 * 核心据此把提问与确认卡降成编号文本，旧消息不改。
 */
export class PluginContactChannel implements ContactChannel {
  private readonly capsValue: ChannelCaps;

  constructor(
    readonly id: string,
    caps: ChannelCaps,
    private readonly call: PluginContactCall
  ) {
    this.capsValue = {
      ...caps,
      buttons: false,
      urlButtons: false,
      edit: false,
      commandMenu: false,
      format: 'plain',
    };
  }

  caps(): ChannelCaps {
    return this.capsValue;
  }

  async sendText(peerId: string, message: ChannelMessage): Promise<ChannelSend> {
    try {
      const value = await this.call({ op: 'sendText', peerId, text: message.text });
      const messageId =
        value &&
        typeof value === 'object' &&
        typeof (value as { messageId?: unknown }).messageId === 'string'
          ? (value as { messageId: string }).messageId
          : undefined;
      return { ok: true, ...(messageId ? { messageId } : {}) };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return { ok: false, error: code === 'TIMEOUT' ? 'network' : 'api' };
    }
  }

  ask(peerId: string, message: ChannelMessage): Promise<ChannelSend> {
    return this.sendText(peerId, message);
  }

  confirmCards(peerId: string, message: ChannelMessage): Promise<ChannelSend> {
    return this.sendText(peerId, message);
  }

  approvalNotice(peerId: string, message: ChannelMessage): Promise<ChannelSend> {
    return this.sendText(peerId, message);
  }

  async settle(): Promise<ChannelSettle> {
    return { ok: false, error: 'api' };
  }

  async typing(peerId: string): Promise<ChannelResult> {
    if (!this.capsValue.typing) return { ok: true };
    try {
      await this.call({ op: 'typing', peerId });
      return { ok: true };
    } catch {
      return { ok: false, error: 'api' };
    }
  }
}

import type { PluginContactRequest } from '@shared/extensionPlugins/protocol';
import { redactSecrets } from '@shared/redactSecrets';
import type {
  ChannelCaps,
  ChannelFailure,
  ChannelFile,
  ChannelImage,
  ChannelMessage,
  ChannelResult,
  ChannelSend,
  ChannelSettle,
  ContactChannel,
} from './channel';

/** 插件渠道往插件进程发东西：纯文本、正在输入、图片、文件 */
export type PluginContactCall = (request: PluginContactRequest) => Promise<unknown>;

function messageIdOf(value: unknown): string | undefined {
  return value &&
    typeof value === 'object' &&
    typeof (value as { messageId?: unknown }).messageId === 'string'
    ? (value as { messageId: string }).messageId
    : undefined;
}

/** 日志与界面里插件原因的上限：够看懂，又不会把整段响应刷进日志 */
const DETAIL_MAX = 200;

function clip(text: string): string {
  const clean = redactSecrets(text.replace(/\s+/gu, ' ').trim());
  return clean.length > DETAIL_MAX ? `${clean.slice(0, DETAIL_MAX)}…` : clean;
}

/** 插件抛的错：保留原因、插件 code 与给用户看的提示；旧插件只抛 Error 也照样有原因 */
function callError(error: unknown): ChannelFailure {
  const record = (error && typeof error === 'object' ? error : {}) as {
    code?: unknown;
    userMessage?: unknown;
  };
  const code = typeof record.code === 'string' ? record.code : undefined;
  const message = clip(error instanceof Error ? error.message : String(error ?? ''));
  const pluginCode = code && code !== 'PLUGIN_ERROR' ? code : undefined;
  const detail = pluginCode ? `[${pluginCode}] ${message}` : message;
  const userMessage =
    typeof record.userMessage === 'string' && record.userMessage.trim()
      ? clip(record.userMessage)
      : undefined;
  return {
    ok: false,
    error: code === 'TIMEOUT' ? 'network' : 'api',
    ...(detail ? { detail } : {}),
    ...(pluginCode ? { pluginCode } : {}),
    ...(userMessage ? { userMessage } : {}),
  };
}

/**
 * 插件渠道的 Main 侧代理。按钮、改消息、命令菜单一律当不支持，
 * 核心据此把提问与确认卡降成编号文本，旧消息不改。图片与文件按插件声明的 caps 走。
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
      images: caps.images === true,
      files: caps.files === true,
    };
  }

  caps(): ChannelCaps {
    return this.capsValue;
  }

  async sendText(peerId: string, message: ChannelMessage): Promise<ChannelSend> {
    try {
      const messageId = messageIdOf(
        await this.call({ op: 'sendText', peerId, text: message.text })
      );
      return { ok: true, ...(messageId ? { messageId } : {}) };
    } catch (error) {
      return callError(error);
    }
  }

  sendImage(peerId: string, image: ChannelImage): Promise<ChannelSend> {
    return this.sendMedia('sendImage', peerId, image);
  }

  sendFile(peerId: string, file: ChannelFile): Promise<ChannelSend> {
    return this.sendMedia('sendFile', peerId, file);
  }

  private async sendMedia(
    op: 'sendImage' | 'sendFile',
    peerId: string,
    media: ChannelImage
  ): Promise<ChannelSend> {
    if (!(op === 'sendImage' ? this.capsValue.images : this.capsValue.files) || !media.buffer)
      return { ok: false, error: 'api' };
    try {
      const messageId = messageIdOf(
        await this.call({
          op,
          peerId,
          data: media.buffer.toString('base64'),
          fileName: media.fileName || 'file',
          ...(media.mimeType ? { mimeType: media.mimeType } : {}),
          ...(media.caption ? { caption: media.caption } : {}),
        })
      );
      return { ok: true, ...(messageId ? { messageId } : {}) };
    } catch (error) {
      return callError(error);
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

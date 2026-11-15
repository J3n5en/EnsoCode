import { join } from 'node:path';
import type { SecretaryContactBot, SecretaryContactChat } from '@shared/types/secretary';
import { readJson, writeJsonAtomic } from '../../bots/files';
import { SecureJsonFile } from '../../secureFile';

/**
 * userData/secretary/contact.json —— 不含任何密钥：bot 身份、绑定的 chat、
 * 轮询 offset、开关。token 单独放在 contact-token.bin，由 safeStorage 加密。
 */
export interface ContactFile {
  version: 1;
  bot?: SecretaryContactBot;
  chat?: SecretaryContactChat;
  boundAt?: number;
  /** 默认关闭：派发类确认卡不允许从手机确认 */
  allowDispatchConfirm: boolean;
  /** 默认关闭：记忆标题不往 Telegram 发（消息会留在 Telegram 服务器上） */
  allowMemory: boolean;
  /** getUpdates 的游标：先落盘再处理，重启不重放已经产生过副作用的更新 */
  pollOffset: number;
  /** 绑定向导中间态：码、过期时间与已经对不上的次数，绑完即清 */
  bind?: { code: string; expiresAt: number; failures: number };
}

export function emptyContactFile(): ContactFile {
  return { version: 1, allowDispatchConfirm: false, allowMemory: false, pollOffset: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value !== 0 ? value : undefined;
}

function parseBot(raw: unknown): SecretaryContactBot | undefined {
  if (!isRecord(raw)) return undefined;
  const id = positiveInt(raw.id);
  const username = typeof raw.username === 'string' ? raw.username.trim() : '';
  if (id === undefined || !username) return undefined;
  return { id, username, name: typeof raw.name === 'string' ? raw.name : username };
}

function parseChat(raw: unknown): SecretaryContactChat | undefined {
  if (!isRecord(raw)) return undefined;
  const id = positiveInt(raw.id);
  if (id === undefined) return undefined;
  return {
    id,
    ...(typeof raw.username === 'string' && raw.username ? { username: raw.username } : {}),
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
  };
}

/** 坏配置一律当空：绑定信息读不出来就当没绑，重新走一次向导即可 */
export function parseContactFile(raw: unknown): ContactFile {
  if (!isRecord(raw)) return emptyContactFile();
  const bot = parseBot(raw.bot);
  const chat = parseChat(raw.chat);
  const bind = isRecord(raw.bind)
    ? typeof raw.bind.code === 'string' && typeof raw.bind.expiresAt === 'number'
      ? {
          code: raw.bind.code,
          expiresAt: raw.bind.expiresAt,
          failures: typeof raw.bind.failures === 'number' ? raw.bind.failures : 0,
        }
      : undefined
    : undefined;
  return {
    version: 1,
    ...(bot ? { bot } : {}),
    ...(chat ? { chat } : {}),
    ...(typeof raw.boundAt === 'number' ? { boundAt: raw.boundAt } : {}),
    allowDispatchConfirm: raw.allowDispatchConfirm === true,
    allowMemory: raw.allowMemory === true,
    pollOffset: typeof raw.pollOffset === 'number' && raw.pollOffset > 0 ? raw.pollOffset : 0,
    ...(bind ? { bind } : {}),
  };
}

export class ContactStore {
  private readonly tokenFile: SecureJsonFile<{ token: string }>;

  constructor(private readonly dir: string) {
    this.tokenFile = new SecureJsonFile<{ token: string }>(
      () => join(this.dir, 'contact-token.bin'),
      () => ({ token: '' }),
      (raw) => ({ token: isRecord(raw) && typeof raw.token === 'string' ? raw.token : '' })
    );
  }

  ready(): Promise<void> {
    return this.tokenFile.ready();
  }

  /** safeStorage 是否可用：不可用时 token 明文落盘，界面要提示 */
  isSecure(): boolean {
    return this.tokenFile.isSecure();
  }

  token(): string {
    return this.tokenFile.get().token;
  }

  async saveToken(token: string | null): Promise<void> {
    await this.tokenFile.set({ token: token ?? '' });
  }

  file(): ContactFile {
    return parseContactFile(readJson(join(this.dir, 'contact.json')));
  }

  save(file: ContactFile): ContactFile {
    const parsed = parseContactFile(file);
    writeJsonAtomic(join(this.dir, 'contact.json'), parsed);
    return parsed;
  }

  /** 解绑：只清 chat 与绑定中间态，bot 与 token 留着，重新绑定不必再贴一次 */
  saveUnbound(): ContactFile {
    const current = this.file();
    return this.save({
      version: 1,
      ...(current.bot ? { bot: current.bot } : {}),
      allowDispatchConfirm: current.allowDispatchConfirm,
      allowMemory: current.allowMemory,
      pollOffset: 0,
    });
  }

  /** 更换或删除 bot：token、bot 身份、chat 一起清 */
  async saveForgotten(): Promise<ContactFile> {
    await this.saveToken(null);
    const current = this.file();
    return this.save({
      version: 1,
      allowDispatchConfirm: current.allowDispatchConfirm,
      allowMemory: current.allowMemory,
      pollOffset: 0,
    });
  }
}

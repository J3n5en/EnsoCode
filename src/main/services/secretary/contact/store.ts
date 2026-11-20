import { join } from 'node:path';
import type {
  SecretaryContactBot,
  SecretaryContactChannelPrefs,
  SecretaryContactChat,
} from '@shared/types/secretary';
import { readJson, writeJsonAtomic } from '../../bots/files';
import { SecureJsonFile } from '../../secureFile';

/**
 * userData/secretary/contact.json —— 不含任何密钥：bot 身份、绑定的 chat、
 * 轮询 offset、开关。token 单独放在 contact-token.bin，由 safeStorage 加密。
 */
export interface ContactFile {
  version: 1;
  /** 总开关：默认打开，老配置升级后照常工作 */
  enabled: boolean;
  /**
   * 渠道开关：Telegram 只存 enabled/push（其余三项沿用下面的老字段），
   * 插件渠道按 `<pluginId>:<id>` 存整份。
   */
  channels: Record<string, Partial<SecretaryContactChannelPrefs>>;
  bot?: SecretaryContactBot;
  chat?: SecretaryContactChat;
  boundAt?: number;
  /**
   * 默认打开：手机上一按就能确认设置、技能、工具、接管与清理卡片（以及旧版本留下的派发卡）。
   * 显式关掉后按钮还在，但点了只提醒回应用处理；审批永远不在手机上确认。
   */
  allowCardConfirm: boolean;
  /** 默认关闭：记忆标题不往 Telegram 发（消息会留在 Telegram 服务器上） */
  allowMemory: boolean;
  /**
   * 默认关闭：只发里程碑。打开后秘书会话里每一轮回复都镜像到手机，
   * 静默回合只发一行摘要。解绑或换 bot 时自动关掉。
   */
  syncMirror: boolean;
  /** getUpdates 的游标：先落盘再处理，重启不重放已经产生过副作用的更新 */
  pollOffset: number;
  /** 绑定向导中间态：码、过期时间与已经对不上的次数，绑完即清 */
  bind?: { code: string; expiresAt: number; failures: number };
  /** Telegram 群白名单（群 chatId）：空名单不收任何群；名单里的群也只认绑定的那个人 */
  telegramGroups: string[];
  /** 见过的群名，只给界面认群用；只记绑定的人或名单里的群发来的 */
  telegramGroupTitles: Record<string, string>;
}

export function emptyContactFile(): ContactFile {
  return {
    version: 1,
    enabled: true,
    channels: {},
    allowCardConfirm: true,
    allowMemory: false,
    syncMirror: false,
    pollOffset: 0,
    telegramGroups: [],
    telegramGroupTitles: {},
  };
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

export const TELEGRAM_CHANNEL_ID = 'telegram';

const GROUP_ID = /^-?\d{1,20}$/u;
const GROUP_TITLE_MAX = 256;
const GROUP_TITLES_MAX = 50;

function groupId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return GROUP_ID.test(id) ? id : null;
}

function parseGroups(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map(groupId).filter((id): id is string => id !== null);
  return [...new Set(ids)];
}

function parseGroupTitles(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] =>
      groupId(entry[0]) === entry[0] && typeof entry[1] === 'string' && entry[1].length > 0
  );
  return Object.fromEntries(
    entries.slice(-GROUP_TITLES_MAX).map(([id, title]) => [id, title.slice(0, GROUP_TITLE_MAX)])
  );
}

export function telegramGroupAllowed(file: ContactFile, chatId: number): boolean {
  return file.telegramGroups.includes(String(chatId));
}

/** 输入做 trim；空的、不是数字 id 的不加，重复的原样返回 */
export function withTelegramGroupAdded(
  file: ContactFile,
  raw: unknown
): { ok: true; file: ContactFile } | { ok: false } {
  const id = groupId(raw);
  if (!id) return { ok: false };
  if (file.telegramGroups.includes(id)) return { ok: true, file };
  return { ok: true, file: { ...file, telegramGroups: [...file.telegramGroups, id] } };
}

export function withTelegramGroupRemoved(file: ContactFile, raw: unknown): ContactFile {
  const id = typeof raw === 'string' ? raw.trim() : '';
  return { ...file, telegramGroups: file.telegramGroups.filter((group) => group !== id) };
}

/** 记下群名；没变返回 null，省一次写盘。新的排最后，超出上限丢最旧的 */
export function withTelegramGroupTitle(
  file: ContactFile,
  chatId: string,
  title: string
): ContactFile | null {
  const clean = title.slice(0, GROUP_TITLE_MAX);
  if (!clean || groupId(chatId) !== chatId || file.telegramGroupTitles[chatId] === clean) {
    return null;
  }
  const rest = Object.entries(file.telegramGroupTitles).filter(([id]) => id !== chatId);
  return {
    ...file,
    telegramGroupTitles: Object.fromEntries([...rest, [chatId, clean]].slice(-GROUP_TITLES_MAX)),
  };
}

const CHANNEL_ID = /^[a-z0-9][a-z0-9._:-]{0,95}$/u;
const PREF_KEYS = ['enabled', 'push', 'cardConfirm', 'syncMirror', 'memory'] as const;

function parseChannels(raw: unknown): ContactFile['channels'] {
  if (!isRecord(raw)) return {};
  const out: ContactFile['channels'] = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!CHANNEL_ID.test(id) || !isRecord(value)) continue;
    const prefs: Partial<SecretaryContactChannelPrefs> = {};
    for (const key of PREF_KEYS) if (typeof value[key] === 'boolean') prefs[key] = value[key];
    out[id] = prefs;
  }
  return out;
}

/** 一个渠道的通用开关：Telegram 默认启用并推送，插件渠道默认关着等用户打开 */
export function channelPrefs(file: ContactFile, id: string): SecretaryContactChannelPrefs {
  const saved = file.channels[id] ?? {};
  if (id === TELEGRAM_CHANNEL_ID) {
    return {
      enabled: saved.enabled ?? true,
      push: saved.push ?? true,
      cardConfirm: file.allowCardConfirm,
      syncMirror: file.syncMirror,
      memory: file.allowMemory,
    };
  }
  return {
    enabled: saved.enabled ?? false,
    push: saved.push ?? true,
    cardConfirm: saved.cardConfirm ?? false,
    syncMirror: saved.syncMirror ?? false,
    memory: saved.memory ?? false,
  };
}

/** 改一个渠道的开关：Telegram 的三项写回老字段，别的存进 channels */
export function withChannelPrefs(
  file: ContactFile,
  id: string,
  patch: Partial<SecretaryContactChannelPrefs>
): ContactFile {
  if (id !== TELEGRAM_CHANNEL_ID) {
    return { ...file, channels: { ...file.channels, [id]: { ...file.channels[id], ...patch } } };
  }
  const { cardConfirm, syncMirror, memory, ...rest } = patch;
  return {
    ...file,
    ...(cardConfirm !== undefined ? { allowCardConfirm: cardConfirm } : {}),
    ...(syncMirror !== undefined ? { syncMirror } : {}),
    ...(memory !== undefined ? { allowMemory: memory } : {}),
    channels: { ...file.channels, [id]: { ...file.channels[id], ...rest } },
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
    enabled: raw.enabled !== false,
    channels: parseChannels(raw.channels),
    ...(bot ? { bot } : {}),
    ...(chat ? { chat } : {}),
    ...(typeof raw.boundAt === 'number' ? { boundAt: raw.boundAt } : {}),
    // 默认打开；老配置里这个开关叫 allowDispatchConfirm，升级后沿用，不把用户的选择丢掉
    allowCardConfirm:
      raw.allowCardConfirm === undefined && raw.allowDispatchConfirm === undefined
        ? true
        : raw.allowCardConfirm === true || raw.allowDispatchConfirm === true,
    allowMemory: raw.allowMemory === true,
    syncMirror: raw.syncMirror === true,
    pollOffset: typeof raw.pollOffset === 'number' && raw.pollOffset > 0 ? raw.pollOffset : 0,
    ...(bind ? { bind } : {}),
    telegramGroups: parseGroups(raw.telegramGroups),
    telegramGroupTitles: parseGroupTitles(raw.telegramGroupTitles),
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
      enabled: current.enabled,
      channels: current.channels,
      ...(current.bot ? { bot: current.bot } : {}),
      allowCardConfirm: current.allowCardConfirm,
      allowMemory: current.allowMemory,
      // 解绑就没人收镜像了：同步自动关闭，重新绑定后要再发一次 /sync
      syncMirror: false,
      pollOffset: 0,
      telegramGroups: current.telegramGroups,
      telegramGroupTitles: current.telegramGroupTitles,
    });
  }

  /** 更换或删除 bot：token、bot 身份、chat 一起清 */
  async saveForgotten(): Promise<ContactFile> {
    await this.saveToken(null);
    const current = this.file();
    return this.save({
      version: 1,
      enabled: current.enabled,
      channels: current.channels,
      allowCardConfirm: current.allowCardConfirm,
      allowMemory: current.allowMemory,
      syncMirror: false,
      pollOffset: 0,
      telegramGroups: current.telegramGroups,
      telegramGroupTitles: current.telegramGroupTitles,
    });
  }
}

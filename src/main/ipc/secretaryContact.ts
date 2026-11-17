import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, ipcMain } from '@platform';
import { normalizeLocale } from '@shared/i18n';
import type { ContactLang } from '@shared/secretary/contact';
import { projectReadableMessages } from '@shared/secretary/transcript';
import { IPC_CHANNELS } from '@shared/types';
import type {
  SecretaryContactChannelPrefs,
  SecretaryContactState,
  SecretaryProfile,
} from '@shared/types/secretary';
import { getExtensionPlugins, setPluginContactBridge } from '../services/extensionPlugins';
import { redactSecrets } from '../services/memory/distill';
import { listMemoriesForAdmin, openExistingMemoryDb } from '../services/memoryAdmin';
import { broadcastToRenderers, isMainRenderer, isSettingsRenderer } from '../services/renderers';
import { appendAudit } from '../services/secretary/audit';
import { createContactCommands } from '../services/secretary/contact/commands';
import { connectPluginChannels } from '../services/secretary/contact/plugins';
import { ContactService, type ContactServicePorts } from '../services/secretary/contact/service';
import { ContactStore } from '../services/secretary/contact/store';
import { deliverToSecretary } from '../services/secretary/contact/wake';
import { setContactMediaSender } from '../services/secretary/contactSend';
import { buildDaily, secretaryDailyPorts } from '../services/secretary/daily';
import { type DeliveryPorts, resolveTarget } from '../services/secretary/deliveries';
import {
  pageSecretaryFeed,
  secretaryBoard,
  secretaryDispatchPorts,
} from '../services/secretary/dispatch';
import { FollowingStore, setPhoneTurnChatProbe } from '../services/secretary/following';
import { secretaryProjectId } from '../services/secretary/identity';
import { listSchedules, secretarySchedulePorts } from '../services/secretary/schedules';
import {
  answerAskAsUserFromMain,
  isRootSessionAlive,
  promptRootFromMain,
  readSessionHistoryFile,
  resumeRootFromMain,
} from './agent';
import { readSettingsState } from './settings';

/**
 * 联系方式（Telegram）的 Main 侧装配：存储、投递、审计都复用秘书现有那套。
 * 单独成文件是为了让 secretary.ts 只多一行调用。
 */
export interface SecretaryContactDeps {
  /** 秘书目录：contact.json 与 contact-token.bin 都放这里 */
  dir(): string;
  /** 回传宿主的端口：目标会话解析与投递复用同一口径 */
  delivery: DeliveryPorts;
  profile(): SecretaryProfile | null;
  /** 秘书状态推送：联系方式状态变化时一起刷新界面 */
  publish(): void;
  /** 确认卡在手机上确认时用；审批没有这条路径 */
  resolveProposal(
    proposalId: string,
    action: 'confirm' | 'reject'
  ): Promise<{ ok: boolean; error?: string }>;
  /** 手机上点「在应用里打开」：聚焦窗口并定位到那张卡 */
  openInApp(target: { conversationId?: string; proposalId?: string }): void;
}

export interface SecretaryContact {
  service: ContactService;
  /** 读一次状态，供深链与启动时使用 */
  state(): SecretaryContactState;
  start(): Promise<void>;
  stop(): Promise<void>;
  register(): void;
}

function isEditor(webContentsId: number): boolean {
  return isMainRenderer(webContentsId) || isSettingsRenderer(webContentsId);
}

function replyLang(profile: SecretaryProfile | null): ContactLang {
  const choice = profile?.replyLanguage ?? 'ui';
  if (choice === 'zh' || choice === 'en') return choice;
  const language = readSettingsState().language;
  return normalizeLocale(typeof language === 'string' ? language : undefined) === 'en'
    ? 'en'
    : 'zh';
}

/** 只接受字符串 token；其余一律当「没给」，用已存的 token 重新生成码 */
function readToken(request: unknown): string | undefined {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined;
  const token = (request as { token?: unknown }).token;
  return typeof token === 'string' ? token : undefined;
}

function readFlag(
  request: unknown,
  key: 'allowCardConfirm' | 'allowMemory' | 'enabled'
): boolean | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const value = (request as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : null;
}

const PREF_KEYS = ['enabled', 'push', 'cardConfirm', 'syncMirror', 'memory'] as const;

/** 渠道卡片上的开关：{ channelId, prefs: { enabled?, push?, ... } } */
function readChannelPrefs(
  request: unknown
): { channelId: string; prefs: Partial<SecretaryContactChannelPrefs> } | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const record = request as Record<string, unknown>;
  const channelId = typeof record.channelId === 'string' ? record.channelId : '';
  const raw = record.prefs;
  if (!channelId || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const prefs: Partial<SecretaryContactChannelPrefs> = {};
  for (const key of PREF_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'boolean') prefs[key] = value;
  }
  return Object.keys(prefs).length > 0 ? { channelId, prefs } : null;
}

/** Telegram 群白名单：{ telegramGroup: { action: 'add' | 'remove', chatId } } */
function readTelegramGroup(request: unknown): { action: 'add' | 'remove'; chatId: string } | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const raw = (request as Record<string, unknown>).telegramGroup;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { action, chatId } = raw as Record<string, unknown>;
  if ((action !== 'add' && action !== 'remove') || typeof chatId !== 'string') return null;
  return { action, chatId };
}

/** 关注列表的操作：取消一项要带 id，全清不带 */
function readFollowingRequest(
  request: unknown
): { action: 'cancel'; id: string } | { action: 'clear' } | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const record = request as Record<string, unknown>;
  if (record.action === 'clear') return { action: 'clear' };
  if (record.action !== 'cancel') return null;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  return id ? { action: 'cancel', id } : null;
}

export function createSecretaryContact(deps: SecretaryContactDeps): SecretaryContact {
  const store = new ContactStore(deps.dir());
  let service: ContactService | null = null;

  const broadcast = (): void => {
    if (!service) return;
    broadcastToRenderers(IPC_CHANNELS.SECRETARY_CONTACT_CHANGED, service.state());
  };

  const ports: ContactServicePorts = {
    audit: (entry) => appendAudit(path.join(app.getPath('userData'), 'secretary'), entry),
    publish: broadcast,
    now: () => Date.now(),
    random: () => Math.random(),
    lang: () => replyLang(deps.profile()),
    notifyMode: () => deps.profile()?.notify ?? null,
    secretaryName: () => deps.profile()?.name ?? 'Secretary',
    secretaryConversationId: () => resolveTarget(deps.delivery),
    // /last：读秘书会话的 jsonl 尾窗，按轮切好交回去；只读，不进会话
    recentTurns: async (rounds) => {
      const conversationId = resolveTarget(deps.delivery);
      if (!conversationId) return [];
      const conversation = deps.delivery
        .conversations()
        .find((candidate) => candidate.conversationId === conversationId);
      const page = await readSessionHistoryFile(conversation?.sessionFile);
      if (!page.ok) return [];
      // 一轮两条消息，留出系统回传与工具轮被跳过的余量
      const readable = projectReadableMessages(page.messages, {
        limit: rounds * 4 + 8,
        baseIndex: page.baseIndex,
      });
      return readable.messages.map((message) => ({
        role: message.role,
        text: redactSecrets(message.text),
      }));
    },
    // 手机发来的话进秘书会话：worker 已被回收就先恢复，再投
    deliver: (conversationId, text) =>
      deliverToSecretary(
        {
          alive: isRootSessionAlive,
          resume: resumeRootFromMain,
          prompt: (id, body) => promptRootFromMain(id, body, randomUUID()),
        },
        conversationId,
        text
      ),
    // 与在应用里亲手答同一条路径：谁先答算谁的
    answerAsk: (conversationId, requestId, answer) =>
      answerAskAsUserFromMain(conversationId, requestId, answer),
    resolveProposal: (proposalId, action) => deps.resolveProposal(proposalId, action),
    openInApp: (target) => deps.openInApp(target),
    // 手机关注的任务：派发与定时写、这里读与取消，重启后还在
    following: new FollowingStore(deps.dir()),
    onError: (code, detail) => {
      console.warn(`[secretary-contact] ${code}${detail ? `: ${detail}` : ''}`);
    },
  };

  // 手机命令的数据源与侧栏面板完全同一份：看板、动态、待办都走秘书现有的投影
  const commands = createContactCommands({
    lang: () => replyLang(deps.profile()),
    now: () => Date.now(),
    // 发命令那个人的渠道开着记忆才给看
    allowMemory: () => service?.memoryAllowed() ?? store.file().allowMemory,
    board: () => secretaryBoard(secretaryDispatchPorts),
    daily: (day) => buildDaily(secretaryDailyPorts, day),
    feed: async (query) => {
      const page = await pageSecretaryFeed(secretaryDispatchPorts, query);
      return {
        events: page.events.map((event) => ({
          id: event.id,
          at: event.at,
          title: event.title,
          projectName: event.projectName,
          label: event.label,
          ...(event.detail ? { detail: event.detail } : {}),
          ...(event.conversationId ? { conversationId: event.conversationId } : {}),
        })),
        hasMore: page.hasMore,
      };
    },
    schedules: async () => listSchedules(secretarySchedulePorts),
    memories: async () => {
      const projectId = secretaryProjectId();
      const db = openExistingMemoryDb(path.join(app.getPath('userData'), 'memory', 'memory.db'));
      if (!db || !projectId) return { titles: [], total: 0 };
      try {
        const result = listMemoriesForAdmin(db, {
          spaceId: `proj:${projectId}`,
          limit: 20,
          offset: 0,
        });
        return { titles: result.items.map((item) => item.title), total: result.total };
      } finally {
        db.close();
      }
    },
  });

  ports.commands = commands;
  service = new ContactService(store, ports);
  // 派发与定时不认识联系方式：只通过这个探针问一句「这一轮是手机发起的吗」
  setPhoneTurnChatProbe((conversationId) => service?.phoneTurnChat(conversationId) ?? null);
  // 秘书的 contact_send_file 只认这个出口，不认识具体渠道
  setContactMediaSender((conversationId, media) => service.sendMedia(conversationId, media));

  let unplug: (() => void) | null = null;

  return {
    service,
    state: () => service.state(),
    start: async () => {
      // 插件渠道：清单声明的先出卡片，插件 register 后再收发；停用卸载时一起清掉
      if (!unplug) {
        const plugins = getExtensionPlugins();
        const wired = connectPluginChannels(service, {
          contactChannels: () => plugins.contactChannels(),
          callContact: (pluginId, channelId, request) =>
            plugins.callContact(pluginId, channelId, request),
          onChange: (listener) => plugins.onChange(listener),
        });
        setPluginContactBridge(wired.handlers);
        unplug = () => {
          setPluginContactBridge(null);
          wired.dispose();
        };
      }
      await service.start();
    },
    stop: async () => {
      unplug?.();
      unplug = null;
      await service.stop();
    },
    register() {
      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_STATE, async (event) => {
        if (!isEditor(event.sender.id)) {
          const state = service.state();
          return {
            enabled: false,
            channels: [],
            telegram: { ...state.telegram, status: 'unbound' },
          };
        }
        return service.state();
      });

      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_BIND, async (event, request: unknown) => {
        if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
        return service.bind(readToken(request));
      });

      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_CANCEL, async (event) => {
        if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
        await service.cancelBind();
        return { ok: true };
      });

      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_UNBIND, async (event) => {
        if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
        return service.unbind();
      });

      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_FORGET_BOT, async (event) => {
        if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
        return service.forgetBot();
      });

      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_TEST, async (event) => {
        if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
        return service.sendTest();
      });

      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_SETTINGS, async (event, request: unknown) => {
        if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
        const channel = readChannelPrefs(request);
        if (channel) return service.setChannelPrefs(channel.channelId, channel.prefs);
        const group = readTelegramGroup(request);
        if (group) return service.setTelegramGroup(group.action, group.chatId);
        const enabled = readFlag(request, 'enabled');
        const cards = readFlag(request, 'allowCardConfirm');
        const memory = readFlag(request, 'allowMemory');
        if (enabled === null && cards === null && memory === null)
          return { ok: false, error: 'invalid request' };
        if (enabled !== null) await service.setEnabled(enabled);
        if (cards !== null) service.setAllowCardConfirm(cards);
        if (memory !== null) service.setAllowMemory(memory);
        return { ok: true };
      });

      // 手机关注的任务：取消一项或全清；列表跟着联系方式状态一起推
      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_FOLLOWING, async (event, request: unknown) => {
        if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
        const parsed = readFollowingRequest(request);
        if (!parsed) return { ok: false, error: 'invalid request' };
        if (parsed.action === 'clear') return service.clearFollowed();
        return service.unfollow(parsed.id);
      });
    },
  };
}

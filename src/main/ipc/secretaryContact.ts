import { randomUUID } from 'node:crypto';
import { ipcMain } from '@platform';
import { normalizeLocale } from '@shared/i18n';
import {
  type ContactLang,
  type ContactRouteClaim,
  findRouteConflict,
} from '@shared/secretary/contact';
import { projectReadableMessages } from '@shared/secretary/transcript';
import type { DemandThreadSource } from '@shared/types/demandThreads';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type {
  SecretaryContactChannelPrefs,
  SecretaryContactState,
  SecretaryProfile,
} from '@shared/types/secretary';
import {
  getExtensionPlugins,
  setPluginContactBridge,
  setPluginOwnerBindingsProbe,
} from '../services/extensionPlugins';
import type { OwnerBindings } from '../services/extensionPlugins/injectTrust';
import { redactSecrets } from '../services/memory/distill';
import { broadcastToRenderers, isMainRenderer } from '../services/renderers';
import { appendAudit } from '../services/secretary/audit';
import { createContactCommands } from '../services/secretary/contact/commands';
import { suggestGithubLogin } from '../services/secretary/contact/githubSuggest';
import { TelegramHub } from '../services/secretary/contact/hub';
import {
  connectPluginChannels,
  type PluginContactBridgeHandlers,
} from '../services/secretary/contact/plugins';
import { ContactService, type ContactServicePorts } from '../services/secretary/contact/service';
import {
  ContactStore,
  channelPrefs,
  contactClaims,
  TELEGRAM_CHANNEL_ID,
} from '../services/secretary/contact/store';
import type { TelegramSibling } from '../services/secretary/contact/telegram';
import { deliverToSecretary } from '../services/secretary/contact/wake';
import { setContactMediaSender } from '../services/secretary/contactSend';
import { buildDaily, dailyPortsFor } from '../services/secretary/daily';
import { type DeliveryPorts, resolveTarget } from '../services/secretary/deliveries';
import {
  dispatchPortsFor,
  pageSecretaryFeed,
  secretaryBoard,
} from '../services/secretary/dispatch';
import { FollowingStore, setPhoneTurnChatProbe } from '../services/secretary/following';
import { getSecretaryImageStore } from '../services/secretary/inboundImages';
import { listSchedules, schedulePortsFor } from '../services/secretary/schedules';
import {
  resolveSecretaryRequest,
  type SecretaryContext,
  secretaryContexts,
  secretaryIdOfConversation,
} from '../services/secretary/secretaries';
import { SecretaryStore } from '../services/secretary/store';
import {
  answerAskAsUserFromMain,
  isRootSessionAlive,
  promptRootFromMain,
  readSessionHistoryFile,
  resumeRootFromMain,
} from './agent';
import { readSettingsState } from './settings';

let replyOrigin:
  | ((
      source: DemandThreadSource,
      text: string,
      secretaryId?: string
    ) => Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>)
  | null = null;

export function replyToDemandThreadSource(
  source: DemandThreadSource,
  text: string,
  secretaryId?: string
): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  if (!replyOrigin) return Promise.resolve({ ok: false, error: '秘书联系方式还没就绪' });
  return replyOrigin(source, text, secretaryId);
}

/**
 * 联系方式的 Main 侧装配：每个秘书一份联系方式服务（自己的 contact.json、token、路由、关注），
 * Telegram 连接由全局 hub 按 token 共享，同一个 token 只轮询一次。
 */
export interface SecretaryContactDeps {
  /** 这个秘书的回传端口：目标会话解析与投递复用同一口径，且不跨秘书 */
  delivery(
    ctx: SecretaryContext
  ): DeliveryPorts & Required<Pick<DeliveryPorts, 'startConversation'>>;
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

export interface SecretaryContacts {
  /** 某个秘书的联系方式服务；没启动时为 undefined */
  service(secretaryId: string): ContactService | undefined;
  /** 新建或启动时接上一个秘书 */
  add(ctx: SecretaryContext): Promise<void>;
  /** 删除秘书：停掉收发；release 时清掉 token 与全部路由 */
  remove(secretaryId: string, release: boolean): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  register(): void;
}

function isEditor(webContentsId: number): boolean {
  return isMainRenderer(webContentsId);
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
  key: 'allowCardConfirm' | 'allowMemory' | 'enabled' | 'externalConfirm'
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

/** 解绑一条群或话题路由：{ telegramRoute: { action: 'remove', chatId, topicId? } } */
function readTelegramRoute(request: unknown): { chatId: string; topicId?: string } | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const raw = (request as Record<string, unknown>).telegramRoute;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { action, chatId, topicId } = raw as Record<string, unknown>;
  if (action !== 'remove' || typeof chatId !== 'string' || !chatId) return null;
  if (topicId !== undefined && typeof topicId !== 'string') return null;
  return { chatId, ...(typeof topicId === 'string' && topicId ? { topicId } : {}) };
}

/** 群交给秘书的范围：{ telegramGroupScope: { chatId, scope: 'all' | string[] } }，细校验在 store */
function readTelegramGroupScope(request: unknown): { chatId: string; scope: unknown } | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const raw = (request as Record<string, unknown>).telegramGroupScope;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { chatId, scope } = raw as Record<string, unknown>;
  return typeof chatId === 'string' ? { chatId, scope } : null;
}

/** { githubLogins: string[] }。缺这键就不是这份设置；值本身交给 service 校验 */
function readGithubLogins(request: unknown): { value: unknown } | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  if (!Object.hasOwn(request, 'githubLogins')) return null;
  return { value: (request as Record<string, unknown>).githubLogins };
}

/** 没有服务时给界面的空视图：不含 token */
function emptyTelegramView(): SecretaryContactState['telegram'] {
  return {
    status: 'unbound',
    allowCardConfirm: true,
    allowMemory: false,
    syncMirror: false,
    groups: [],
    following: [],
    poll: { state: 'stopped' },
    secure: true,
  };
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

function profileOf(ctx: SecretaryContext): SecretaryProfile | null {
  return new SecretaryStore(ctx.dir).profile();
}

/** 联系方式里称呼一个秘书：与界面一致，没起名的叫 Secretary */
function nameOf(ctx: SecretaryContext): string {
  return profileOf(ctx)?.name?.trim() || 'Secretary';
}

/** 同一 bot + chat + 话题已经属于别的秘书时，返回它的名字 */
function routeConflictFor(claim: ContactRouteClaim): string | null {
  const claims = secretaryContexts()
    .filter((ctx) => ctx.id !== claim.secretaryId)
    .flatMap((ctx) => contactClaims(ctx.id, new ContactStore(ctx.dir).file()));
  const hit = findRouteConflict(claims, claim);
  if (!hit) return null;
  const owner = secretaryContexts().find((ctx) => ctx.id === hit.secretaryId);
  return owner ? nameOf(owner) : hit.secretaryId;
}

/** 插件渠道已经在别的秘书那里打开了：一个渠道只归一个秘书 */
function channelOwnedElsewhere(selfId: string, channelId: string): string | null {
  for (const ctx of secretaryContexts()) {
    if (ctx.id === selfId) continue;
    if (channelPrefs(new ContactStore(ctx.dir).file(), channelId).enabled) {
      return profileOf(ctx)?.name ?? ctx.id;
    }
  }
  return null;
}

/** 别的秘书的联系方式：共用 bot 时沿用主人、合并见过的话题、在设置页列出各自认领了什么 */
function contactSiblings(selfId: string): TelegramSibling[] {
  return secretaryContexts()
    .filter((ctx) => ctx.id !== selfId)
    .map((ctx) => {
      const file = new ContactStore(ctx.dir).file();
      return {
        secretaryId: ctx.id,
        name: nameOf(ctx),
        enabled: file.enabled && channelPrefs(file, TELEGRAM_CHANNEL_ID).enabled,
        file,
      };
    });
}

export function createSecretaryContacts(deps: SecretaryContactDeps): SecretaryContacts {
  const hub = new TelegramHub({
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        }
        signal.addEventListener('abort', done, { once: true });
      }),
    onError: (error) => {
      console.warn(`[secretary-contact] ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  const services = new Map<string, ContactService>();
  replyOrigin = async (source, text, secretaryId) => {
    const channelId =
      source.channel === 'tg' || source.channel === 'telegram'
        ? TELEGRAM_CHANNEL_ID
        : source.channel;
    const named = secretaryId ? services.get(secretaryId) : undefined;
    const service = named?.canReplyToOrigin(channelId, source.chatId)
      ? named
      : [...services.values()].find((item) => item.canReplyToOrigin(channelId, source.chatId));
    if (!service) return { ok: false, error: '没有可回复的渠道' };
    return service.replyToOrigin({
      channelId,
      peerId: source.chatId,
      ...(source.topicId ? { topicId: source.topicId } : {}),
      replyToMessageId: source.messageId,
      text,
    });
  };

  function publishOwnerBindings(): void {
    setPluginOwnerBindingsProbe(() => {
      const telegramOwnerIds = new Set<string>();
      const telegramPrivateChatIds = new Set<string>();
      const channelOwnerIds = new Map<string, Set<string>>();
      const githubLogins = new Set<string>();
      let externalConfirm = false;
      for (const service of services.values()) {
        const bindings = service.ownerBindings();
        if (bindings.telegramOwnerId) telegramOwnerIds.add(bindings.telegramOwnerId);
        if (bindings.telegramPrivateChatId)
          telegramPrivateChatIds.add(bindings.telegramPrivateChatId);
        for (const channel of bindings.channelPeers) {
          const key = channel.channelId.toLowerCase();
          const peers = channelOwnerIds.get(key) ?? new Set<string>();
          for (const peer of channel.peers) peers.add(peer);
          channelOwnerIds.set(key, peers);
        }
        for (const login of bindings.githubLogins) githubLogins.add(login);
        if (bindings.externalConfirm) externalConfirm = true;
      }
      const bindings: OwnerBindings = {
        telegramOwnerIds,
        telegramPrivateChatIds,
        channelOwnerIds,
        githubLogins,
        externalConfirm,
      };
      return bindings;
    });
  }

  publishOwnerBindings();
  let plugins: { handlers: PluginContactBridgeHandlers; dispose(): void; resync(): void } | null =
    null;

  const broadcast = (secretaryId: string): void => {
    const service = services.get(secretaryId);
    if (!service) return;
    broadcastToRenderers(IPC_CHANNELS.SECRETARY_CONTACT_CHANGED, {
      ...service.state(),
      secretaryId,
    });
  };

  function build(ctx: SecretaryContext): ContactService {
    const store = new ContactStore(ctx.dir);
    const delivery = deps.delivery(ctx);
    let service: ContactService | null = null;
    const ports: ContactServicePorts = {
      audit: (entry) => appendAudit(ctx.dir, entry),
      publish: () => {
        broadcast(ctx.id);
        deps.publish();
      },
      now: () => Date.now(),
      random: () => Math.random(),
      lang: () => replyLang(profileOf(ctx)),
      notifyMode: () => profileOf(ctx)?.notify ?? null,
      secretaryName: () => nameOf(ctx),
      secretaryConversationId: () => resolveTarget(delivery),
      startConversation: () => delivery.startConversation(),
      // /last：读秘书会话的 jsonl 尾窗，按轮切好交回去；只读，不进会话
      recentTurns: async (rounds) => {
        const conversationId = resolveTarget(delivery);
        if (!conversationId) return [];
        const conversation = delivery
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
      saveInboundImages: (conversationId, images) =>
        getSecretaryImageStore()?.saveAll(conversationId, images) ??
        images.map(() => ({ ok: false, reason: 'unavailable' as const })),
      // 与在应用里亲手答同一条路径：谁先答算谁的
      answerAsk: (conversationId, requestId, answer) =>
        answerAskAsUserFromMain(conversationId, requestId, answer),
      resolveProposal: (proposalId, action) => deps.resolveProposal(proposalId, action),
      openInApp: (target) => deps.openInApp(target),
      // 手机关注的任务：派发与定时写、这里读与取消，重启后还在
      following: new FollowingStore(ctx.dir),
      onError: (code, detail, channelId) => {
        console.warn(
          `[secretary-contact] ${channelId ? `${channelId} ` : ''}${code}${detail ? `: ${detail}` : ''}`
        );
      },
      hub,
      secretaryId: ctx.id,
      routeConflict: routeConflictFor,
      siblings: () => contactSiblings(ctx.id),
      channelOwnedElsewhere: (channelId) => channelOwnedElsewhere(ctx.id, channelId),
    };

    // 手机命令的数据源与侧栏面板完全同一份：看板、动态、待办都走这个秘书自己的投影
    ports.commands = createContactCommands({
      lang: () => replyLang(profileOf(ctx)),
      now: () => Date.now(),
      // 发命令那个人的渠道开着记忆才给看
      allowMemory: () => service?.memoryAllowed() ?? store.file().allowMemory,
      board: () => secretaryBoard(dispatchPortsFor(ctx)),
      daily: (day) => buildDaily(dailyPortsFor(ctx), day),
      feed: async (query) => {
        const page = await pageSecretaryFeed(dispatchPortsFor(ctx), query);
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
      schedules: async () => listSchedules(schedulePortsFor(ctx)),
      memories: async () => {
        const projectId = ctx.projectId;
        if (!projectId) return { titles: [], total: 0 };
        const { isMissingDb, memoryServiceOp } = await import('../services/memoryHost');
        const result = await memoryServiceOp<
          { items: { title: string }[]; total: number } | { missing: true }
        >('list', { spaceId: `proj:${projectId}`, limit: 20, offset: 0 });
        if (isMissingDb(result)) return { titles: [], total: 0 };
        return { titles: result.items.map((item) => item.title), total: result.total };
      },
    });
    service = new ContactService(store, ports);
    return service;
  }

  /** 秘书会话 → 它所属秘书的联系方式：探针与发文件都按会话认秘书，不猜 */
  const serviceOfConversation = (conversationId: string): ContactService | undefined => {
    const id = secretaryIdOfConversation(conversationId);
    return id ? services.get(id) : undefined;
  };
  // 派发与定时不认识联系方式：只通过这个探针问一句「这一轮是手机发起的吗」
  setPhoneTurnChatProbe(
    (conversationId) => serviceOfConversation(conversationId)?.phoneTurnChat(conversationId) ?? null
  );
  // 秘书的 contact_send_file 只认这个出口，不认识具体渠道
  setContactMediaSender(async (conversationId, media) => {
    const service = conversationId ? serviceOfConversation(conversationId) : undefined;
    if (!service) return { ok: false, error: 'not-bound' };
    return service.sendMedia(conversationId, media);
  });

  /** IPC 入参里的秘书：只有一个秘书时可省略 */
  const target = (raw: unknown): ContactService | null => {
    const ctx = resolveSecretaryRequest(raw);
    return ctx ? (services.get(ctx.id) ?? null) : null;
  };

  const contacts: SecretaryContacts = {
    service: (secretaryId) => services.get(secretaryId),

    async add(ctx) {
      if (services.has(ctx.id)) return;
      const service = build(ctx);
      services.set(ctx.id, service);
      plugins?.resync();
      await service.start();
    },

    async remove(secretaryId, release) {
      const service = services.get(secretaryId);
      if (!service) return;
      services.delete(secretaryId);
      if (release) await service.release();
      await service.stop();
    },

    async start() {
      publishOwnerBindings();
      // 插件渠道：清单声明的先出卡片，插件 register 后再收发；停用卸载时一起清掉
      if (!plugins) {
        const source = getExtensionPlugins();
        plugins = connectPluginChannels(() => [...services.values()], {
          contactChannels: () => source.contactChannels(),
          callContact: (pluginId, channelId, request) =>
            source.callContact(pluginId, channelId, request),
          onChange: (listener) => source.onChange(listener),
        });
        setPluginContactBridge(plugins.handlers);
      }
      for (const ctx of secretaryContexts()) await contacts.add(ctx);
    },

    async stop() {
      replyOrigin = null;
      setPluginContactBridge(null);
      setPluginOwnerBindingsProbe(null);
      plugins?.dispose();
      plugins = null;
      for (const service of services.values()) await service.stop();
      await hub.stopAll();
    },

    register() {
      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_STATE, async (event, secretaryId: unknown) => {
        const service = target(secretaryId);
        if (!isEditor(event.sender.id) || !service) {
          const state = service?.state();
          return {
            enabled: false,
            channels: [],
            telegram: { ...(state?.telegram ?? emptyTelegramView()), status: 'unbound' },
            owner: state?.owner ?? { githubLogins: [], externalConfirm: false },
          };
        }
        return { ...service.state(), secretaryId: resolveSecretaryRequest(secretaryId)?.id };
      });

      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_CONTACT_BIND,
        async (event, request: unknown, secretaryId: unknown) => {
          if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
          const service = target(secretaryId);
          if (!service) return { ok: false, error: 'secretary-required' };
          return service.bind(readToken(request));
        }
      );

      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_CANCEL, async (event, secretaryId: unknown) => {
        if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
        const service = target(secretaryId);
        if (!service) return { ok: false, error: 'secretary-required' };
        await service.cancelBind();
        return { ok: true };
      });

      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_UNBIND, async (event, secretaryId: unknown) => {
        if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
        const service = target(secretaryId);
        if (!service) return { ok: false, error: 'secretary-required' };
        return service.unbind();
      });

      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_CONTACT_FORGET_BOT,
        async (event, secretaryId: unknown) => {
          if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
          const service = target(secretaryId);
          if (!service) return { ok: false, error: 'secretary-required' };
          return service.forgetBot();
        }
      );

      // 不带渠道是 Telegram 的测试消息；带插件渠道 id 是「立即重试」：解除暂停并发一条测试消息
      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_CONTACT_TEST,
        async (event, secretaryId: unknown, request: unknown) => {
          if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
          const service = target(secretaryId);
          if (!service) return { ok: false, error: 'secretary-required' };
          const channelId =
            request && typeof request === 'object' && !Array.isArray(request)
              ? (request as Record<string, unknown>).channelId
              : undefined;
          if (typeof channelId === 'string' && channelId && channelId !== TELEGRAM_CHANNEL_ID)
            return service.retryChannel(channelId);
          return service.sendTest();
        }
      );

      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_CONTACT_SETTINGS,
        async (event, request: unknown, secretaryId: unknown) => {
          if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
          const service = target(secretaryId);
          if (!service) return { ok: false, error: 'secretary-required' };
          const channel = readChannelPrefs(request);
          if (channel) return service.setChannelPrefs(channel.channelId, channel.prefs);
          const group = readTelegramGroup(request);
          if (group) return service.setTelegramGroup(group.action, group.chatId);
          const route = readTelegramRoute(request);
          if (route) return service.removeTelegramRoute(route.chatId, route.topicId);
          const scope = readTelegramGroupScope(request);
          if (scope) return service.setTelegramGroupScope(scope.chatId, scope.scope);
          const logins = readGithubLogins(request);
          if (logins) return service.setGithubLogins(logins.value);
          const enabled = readFlag(request, 'enabled');
          const cards = readFlag(request, 'allowCardConfirm');
          const memory = readFlag(request, 'allowMemory');
          const externalConfirm = readFlag(request, 'externalConfirm');
          if (enabled === null && cards === null && memory === null && externalConfirm === null)
            return { ok: false, error: 'invalid request' };
          if (enabled !== null) await service.setEnabled(enabled);
          if (cards !== null) service.setAllowCardConfirm(cards);
          if (memory !== null) service.setAllowMemory(memory);
          if (externalConfirm !== null) service.setExternalConfirm(externalConfirm);
          return { ok: true };
        }
      );

      ipcMain.handle(IPC_CHANNELS.SECRETARY_CONTACT_GITHUB_SUGGEST, async (event) => {
        if (!isEditor(event.sender.id)) return { login: null };
        return { login: await suggestGithubLogin() };
      });

      // 手机关注的任务：取消一项或全清；列表跟着联系方式状态一起推
      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_CONTACT_FOLLOWING,
        async (event, request: unknown, secretaryId: unknown) => {
          if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
          const service = target(secretaryId);
          if (!service) return { ok: false, error: 'secretary-required' };
          const parsed = readFollowingRequest(request);
          if (!parsed) return { ok: false, error: 'invalid request' };
          if (parsed.action === 'clear') return service.clearFollowed();
          return service.unfollow(parsed.id);
        }
      );

      // 设置页勾话题：确认群可达、是否开了话题，并给出 bot 见过的话题
      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_CONTACT_TELEGRAM_TOPICS,
        async (event, request: unknown, secretaryId: unknown) => {
          if (!isEditor(event.sender.id)) return { ok: false, error: 'invalid sender' };
          const service = target(secretaryId);
          if (!service) return { ok: false, error: 'secretary-required' };
          const chatId =
            request && typeof request === 'object' && !Array.isArray(request)
              ? (request as Record<string, unknown>).chatId
              : undefined;
          return service.telegramTopics(chatId);
        }
      );
    },
  };
  return contacts;
}

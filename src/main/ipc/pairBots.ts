import { existsSync } from 'node:fs';
import path from 'node:path';
import type { HostToPhone, PairBotRunState } from '@enso/pair';
import { app } from '@platform';
import { INBOX_DISMISSIBLE, visibleInbox } from '@shared/bots/inbox';
import type { RendererAgentEvent } from '@shared/types/agent';
import type { BotChat } from '@shared/types/bot';
import { requestSnapshot } from '../services/agentHost';
import { BotActivityTracker } from '../services/bots/activityTracker';
import {
  type ActivityBinding,
  botSessionAccess,
  fitGroupTimelineFrame,
  pairActivityItems,
  summarizeBotChat,
  toPairBotMember,
} from '../services/pairBotFrames';
import {
  broadcastPairFrame,
  isPairSessionRunning,
  type PairBotCommand,
  type PairReply,
  setPairBotPort,
} from '../services/pairHost';
import { projectParentHistoryAll, resolveParentHistoryFile } from '../services/sessionHistoryTail';
import { getSourceAuthorityRegistry } from './agent';
import {
  botModeEnabled,
  createBotThread,
  getBotServices,
  newBotSession,
  observeBotEvents,
  readBotTimeline,
  retryBotChat,
  selectBotThread,
  sendBotMessage,
} from './bots';
import { phoneArtifactImage, phoneArtifacts } from './botsContent';
import { agentSessionIndex } from './sessionIndex';

/**
 * 手机端 Bot 模式：pair 命令 → 与桌面 IPC 同一套 Bot 服务；Bot 事件/目录 → 已连接手机。
 * 只在 Bot 模式开启时响应；关闭后仅对曾下发过目录的连接补一帧 enabled:false。
 */

const TIMELINE_PAGE = 50;
const PUSH_DEBOUNCE_MS = 250;
/** 运行态节流：流式输出事件很密，按固定间隔合并 */
const ACTIVITY_THROTTLE_MS = 500;
const NEW_SESSION_CACHE_MS = 10 * 60_000;
const NEW_SESSION_CACHE_LIMIT = 1024;

type NewSessionCommand = Extract<PairBotCommand, { type: 'bot-new-session' }>;
type NewSessionReply = Extract<HostToPhone, { type: 'bot-new-session-result' }>;
type ThreadCommand = Extract<PairBotCommand, { type: 'bot-thread-create' | 'bot-thread-select' }>;
type ThreadReply = Extract<HostToPhone, { type: 'bot-thread-result' }>;
const newSessionRequests = new Map<
  string,
  {
    chatId: string;
    confirmed: boolean;
    result: Promise<NewSessionReply>;
    settledAt?: number;
  }
>();

type Services = NonNullable<ReturnType<typeof getBotServices>>;

/** 本进程是否下发过 Bot 目录：关闭 Bot 模式后据此通知手机隐藏分段 */
let announced = false;
let pushTimer: NodeJS.Timeout | null = null;
let activityTimer: NodeJS.Timeout | null = null;
/** 上次下发的运行态（不含 now）：没变就不重推 */
let activitySent = '';
const activity = new BotActivityTracker(Date.now, (id) => Boolean(botConversation(id)));

function enabledServices(): Services | null {
  return botModeEnabled() ? getBotServices() : null;
}

function runStates(services: Services): {
  conversation(conversationId: string | undefined): PairBotRunState;
} {
  const queued = new Set(services.host.queueState().map((item) => item.conversationId));
  return {
    conversation: (id) =>
      !id ? 'idle' : isPairSessionRunning(id) ? 'running' : queued.has(id) ? 'queued' : 'idle',
  };
}

const merge = (states: PairBotRunState[]): PairBotRunState =>
  states.includes('running') ? 'running' : states.includes('queued') ? 'queued' : 'idle';

function chatState(services: Services, chat: BotChat, states: ReturnType<typeof runStates>) {
  const own = Object.values(chat.sessions).map((s) => states.conversation(s.conversationId));
  if (chat.kind === 'group') {
    const round = services.groups.state(chat.id);
    if (round.ok && round.current) own.push('running');
  }
  return merge(own);
}

function catalogFrame(services: Services): HostToPhone {
  const states = runStates(services);
  const chats = services.chats.list();
  return {
    type: 'bot-catalog',
    enabled: true,
    newSession: true,
    threads: true,
    bots: services.bots
      .list()
      .map((bot) =>
        toPairBotMember(
          bot,
          merge(chats.map((chat) => states.conversation(chat.sessions[bot.id]?.conversationId)))
        )
      ),
  };
}

function chatsFrame(services: Services): HostToPhone {
  const states = runStates(services);
  const summarize = (chat: BotChat) =>
    summarizeBotChat(
      chat,
      services.chats.readEntries(chat.id, { limit: 1 })[0],
      services.chats.lastSeq(chat.id),
      chatState(services, chat, states)
    );
  const all = services.chats.list();
  // 根群进列表；其子话题另列，供手机话题切换
  const roots = all.filter((chat) => chat.archivedAt === undefined && !chat.parentId);
  const rootIds = new Set(roots.map((chat) => chat.id));
  return {
    type: 'bot-chats',
    chats: roots.map(summarize),
    threads: all
      .filter((chat) => chat.parentId !== undefined && rootIds.has(chat.parentId))
      .map(summarize),
  };
}

async function replyDirectory(services: Services, reply: PairReply): Promise<void> {
  announced = true;
  await reply(catalogFrame(services));
  await reply(chatsFrame(services));
  await reply(inboxFrame(services));
  await reply(activityFrame(services));
}

function activityFrame(services: Services): Extract<HostToPhone, { type: 'bot-activity' }> {
  const bindingOf = (id: string): ActivityBinding | undefined => {
    const bot = botConversation(id)?.bot;
    if (!bot) return undefined;
    const delegationId = bot.delegationId;
    const owner = delegationId ? services.delegations.parentBotOf(delegationId) : undefined;
    return {
      botId: bot.botId,
      chatId: bot.chatId ?? (delegationId ? services.delegations.chatIdOf(delegationId) : null),
      ...(owner ? { ownerBotId: owner } : {}),
    };
  };
  const items = pairActivityItems(activity.list(), services.host.queueState(), bindingOf);
  activitySent = JSON.stringify(items);
  return { type: 'bot-activity', now: Date.now(), items };
}

/** 运行态节流重推；内容没变不发 */
function scheduleActivity(): void {
  if (activityTimer) return;
  activityTimer = setTimeout(() => {
    activityTimer = null;
    const services = enabledServices();
    if (!services || !announced) return;
    const previous = activitySent;
    const frame = activityFrame(services);
    if (activitySent !== previous) broadcastPairFrame(frame);
  }, ACTIVITY_THROTTLE_MS);
}

function inboxFrame(services: Services): HostToPhone {
  return {
    type: 'bot-inbox',
    items: visibleInbox(services.inbox.list()).map((item) => ({
      key: item.key,
      kind: item.kind,
      chatId: item.chatId,
      ...(item.botId ? { botId: item.botId } : {}),
      ...(item.ownerBotId ? { ownerBotId: item.ownerBotId } : {}),
      ...(item.text ? { text: item.text } : {}),
      ...(item.since !== undefined ? { since: item.since } : {}),
      createdAt: item.createdAt,
      dismissible: INBOX_DISMISSIBLE.includes(item.kind),
    })),
  };
}

function replyTimeline(
  services: Services,
  chatId: string,
  beforeSeq: number | undefined,
  reply: PairReply
): Promise<boolean> | undefined {
  const result = readBotTimeline(services, {
    chatId,
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    limit: TIMELINE_PAGE,
  });
  if (!result.ok) return undefined;
  return reply(
    fitGroupTimelineFrame({
      type: 'group-timeline',
      chatId,
      entries: result.entries,
      lastSeq: result.lastSeq,
      epochSeq: services.chats.get(chatId)?.epochSeq ?? 0,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      hasOlder: (result.entries[0]?.seq ?? 1) > 1,
    })
  );
}

function replyState(services: Services, chatId: string, reply: PairReply): void {
  const state = services.groups.state(chatId);
  if (!state.ok) return;
  const { ok: _ok, ...rest } = state;
  void reply({ type: 'bot-chat-state', chatId, ...rest });
}

function newSessionResult(
  pairId: string,
  command: NewSessionCommand,
  services: Services | null
): Promise<NewSessionReply> {
  const { chatId, requestId } = command;
  const confirmed = command.confirmed === true;
  const base = { type: 'bot-new-session-result' as const, chatId, requestId };
  const now = Date.now();
  for (const [key, entry] of newSessionRequests) {
    if (entry.settledAt !== undefined && now - entry.settledAt > NEW_SESSION_CACHE_MS) {
      newSessionRequests.delete(key);
    }
  }
  const key = JSON.stringify([pairId, requestId]);
  const previous = newSessionRequests.get(key);
  if (previous) {
    return previous.chatId === chatId && previous.confirmed === confirmed
      ? previous.result
      : Promise.resolve({ ...base, ok: false, error: 'invalid-request' });
  }
  // 不淘汰执行中的请求；缓存满时拒绝，不能冒险重复 reset。
  if (newSessionRequests.size >= NEW_SESSION_CACHE_LIMIT) {
    return Promise.resolve({ ...base, ok: false, error: 'session-busy' });
  }
  const result = (async (): Promise<NewSessionReply> => {
    if (!services) return { ...base, ok: false, error: 'disabled' };
    try {
      const result = await newBotSession(services, { chatId }, confirmed);
      if (result.ok) return { ...base, ok: true };
      return 'needsConfirmation' in result
        ? { ...base, ok: false, needsConfirmation: true }
        : { ...base, ok: false, error: result.error };
    } catch {
      return { ...base, ok: false, error: 'failed' };
    }
  })();
  const entry: {
    chatId: string;
    confirmed: boolean;
    result: Promise<NewSessionReply>;
    settledAt?: number;
  } = { chatId, confirmed, result };
  newSessionRequests.set(key, entry);
  void result.then(() => {
    entry.settledAt = Date.now();
  });
  return result;
}

function threadResult(services: Services | null, command: ThreadCommand): ThreadReply {
  const { chatId, requestId } = command;
  const base = { type: 'bot-thread-result' as const, chatId, requestId };
  if (!services) return { ...base, ok: false, error: 'disabled' };
  if (command.type === 'bot-thread-create') {
    const result = createBotThread(services, { chatId });
    return result.ok
      ? { ...base, ok: true, threadId: result.chat.id }
      : { ...base, ok: false, error: result.error };
  }
  const result = selectBotThread(services, { chatId, threadId: command.threadId });
  return result.ok
    ? { ...base, ok: true, threadId: command.threadId }
    : { ...base, ok: false, error: result.error };
}

async function handle(pairId: string, command: PairBotCommand, reply: PairReply): Promise<void> {
  const services = enabledServices();
  if (command.type === 'bot-thread-create' || command.type === 'bot-thread-select') {
    const result = threadResult(services, command);
    // 先推目录：手机按根群 activeThreadId 换视图，回执到达时已对齐
    if (result.ok && services) await reply(chatsFrame(services));
    await reply(result);
    return;
  }
  if (command.type === 'bot-new-session') {
    const result = await newSessionResult(pairId, command, services);
    await reply(result);
    if (result.ok && services) {
      await reply(chatsFrame(services));
      if (services.chats.get(command.chatId)?.kind === 'group') {
        await replyTimeline(services, command.chatId, undefined, reply);
        replyState(services, command.chatId, reply);
      }
    }
    return;
  }
  if (!services) {
    if (command.type === 'bot-catalog-request' && announced) {
      await reply({ type: 'bot-catalog', enabled: false, bots: [] });
    }
    return;
  }
  switch (command.type) {
    case 'bot-catalog-request':
      await replyDirectory(services, reply);
      return;
    case 'bot-inbox-request':
      await reply(inboxFrame(services));
      return;
    case 'bot-inbox-dismiss':
      // 结果经 inbox 事件整表重推；不可忽略的条目 Main 拒绝
      services.inbox.dismiss(command.key);
      return;
    case 'bot-chat-open': {
      const chat = services.chats.get(command.chatId);
      if (chat?.kind !== 'group') return;
      await replyTimeline(services, chat.id, undefined, reply);
      replyState(services, chat.id, reply);
      return;
    }
    case 'bot-timeline':
      await replyTimeline(services, command.chatId, command.beforeSeq, reply);
      return;
    case 'bot-stop': {
      const result = await services.groups.stop(command.chatId);
      if (result.ok) replyState(services, command.chatId, reply);
      return;
    }
    case 'bot-retry': {
      const result = await retryBotChat(services, {
        chatId: command.chatId,
        entryId: command.entryId,
      });
      await reply({
        type: 'bot-retry-result',
        chatId: command.chatId,
        entryId: command.entryId,
        ...result,
      });
      if (result.ok) {
        await replyTimeline(services, command.chatId, undefined, reply);
        replyState(services, command.chatId, reply);
      }
      return;
    }
    case 'bot-artifacts': {
      const found = await phoneArtifacts(services, command.target);
      await reply({
        type: 'bot-artifacts',
        target: command.target,
        artifacts: found?.artifacts ?? [],
        media: found?.media ?? [],
      });
      return;
    }
    case 'bot-artifact-image': {
      const { requestId, target, mediaId, rel } = command;
      const result = await phoneArtifactImage(services, {
        ...target,
        ...(mediaId !== undefined ? { mediaId } : { rel }),
      });
      await reply({ type: 'bot-artifact-image', requestId, ...result });
      return;
    }
    case 'bot-send': {
      const { type: _type, ...request } = command;
      const result = await sendBotMessage(services, request);
      // 与桌面 store.send 同步：已在 worker 的会话补一份快照，订阅中的手机据此对齐
      if (result.ok && result.conversationId) requestSnapshot(result.conversationId);
      await reply({
        type: 'bot-send-result',
        chatId: command.chatId,
        deliveryId: command.deliveryId,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      });
      return;
    }
  }
}

/** 成员状态与聊天列表合并防抖重推（两帧都小，状态变化都要刷新） */
function schedulePush(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const services = enabledServices();
    if (!services) return;
    announced = true;
    broadcastPairFrame(catalogFrame(services));
    broadcastPairFrame(chatsFrame(services));
  }, PUSH_DEBOUNCE_MS);
}

function botConversation(sessionId: string) {
  const conversation = getSourceAuthorityRegistry()?.conversation(sessionId);
  return conversation?.bot ? conversation : undefined;
}

async function coldSnapshot(sessionId: string): Promise<RendererAgentEvent | null> {
  const conversation = botConversation(sessionId);
  if (!conversation || !botModeEnabled()) return null;
  const sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions');
  const file = resolveParentHistoryFile(sessionDir, conversation.sessionFile);
  let messages: ReturnType<typeof projectParentHistoryAll> = [];
  if (file && existsSync(file)) {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    messages = projectParentHistoryAll(SessionManager.open(file, sessionDir).getBranch());
  }
  // 无 generation：会话随后被拉起时 worker 快照带新 generation，手机按换代重订阅
  return {
    type: 'snapshot',
    partial: true,
    sessions: [{ identity: { sessionId }, sessionId, status: 'idle', messages, commands: [] }],
  } as unknown as RendererAgentEvent;
}

export function registerPairBotHandlers(): void {
  setPairBotPort({
    handle,
    resync(_pairId, reply) {
      const services = enabledServices();
      if (services) void replyDirectory(services, reply);
      else if (announced) void reply({ type: 'bot-catalog', enabled: false, bots: [] });
    },
    sessionAccess: (sessionId) =>
      botSessionAccess(
        botConversation(sessionId),
        botModeEnabled(),
        agentSessionIndex.isAlive(sessionId)
      ),
    coldSnapshot,
    sessionTitle(sessionId) {
      const bot = botConversation(sessionId)?.bot;
      return bot ? getBotServices()?.bots.get(bot.botId)?.name : undefined;
    },
    observe(event) {
      if (!botModeEnabled()) return;
      activity.apply(event);
      if (!announced) return;
      const id = 'identity' in event ? event.identity?.sessionId : undefined;
      if (!id || botConversation(id)) scheduleActivity();
      if (event.type === 'status' && id && botConversation(id)) schedulePush();
    },
  });
  observeBotEvents((event) => {
    // 收件箱变化：整表重推（手机端没有 bot-event 的 inbox kind）
    if (event.kind === 'inbox') {
      const services = enabledServices();
      if (services && announced) broadcastPairFrame(inboxFrame(services));
      return;
    }
    // 群任务看板 / 核心笔记手机端暂不支持、通知跳转只给本机窗口：不转发新 kind，pair 协议保持不变
    if (
      !botModeEnabled() ||
      event.kind === 'tasks' ||
      event.kind === 'notes' ||
      event.kind === 'budget' ||
      event.kind === 'silence' ||
      event.kind === 'reminder' ||
      event.kind === 'open'
    )
      return;
    broadcastPairFrame({ type: 'bot-event', event: { ...event, kind: event.kind } });
    schedulePush();
    if (event.kind === 'queue') scheduleActivity();
  });
}

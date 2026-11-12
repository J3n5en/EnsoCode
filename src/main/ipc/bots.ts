import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { app, ipcMain, shell } from '@platform';
import { botBrowserKey } from '@shared/bots/browser';
import { checkAvatarImage } from '@shared/bots/cardPng';
import { applyChatFlags, wakeOnActivity } from '@shared/bots/chatFlags';
import { normalizeBotMaxRunningTurns } from '@shared/bots/concurrency';
import { BOT_NOTES_MAX_CHARS } from '@shared/bots/notes';
import { isSkipReply } from '@shared/bots/router';
import { assignTeamNames } from '@shared/bots/team';
import type { SessionIdentity } from '@shared/builtinAgents';
import { BUILTIN_AGENT_TYPES, IPC_CHANNELS } from '@shared/types';
import { type AgentWorkerEvent, type AttachedImage, isDeliveryId } from '@shared/types/agent';
import type { SkillEntry } from '@shared/types/assets';
import {
  type BotChat,
  type BotChatWorkspace,
  type BotEngine,
  GROUP_TASK_TEXT_MAX,
  GROUP_TASK_TITLE_MAX,
  type HumanEntryRefs,
  isBotId,
  TASK_CHECK_TEXT_MAX,
} from '@shared/types/bot';
import type {
  BotAbilitySuggestResult,
  BotActionResult,
  BotChatSessionsResult,
  BotChatsListResult,
  BotChatWriteResult,
  BotEvent,
  BotFileSearchResult,
  BotGetResult,
  BotGoalSuggestResult,
  BotInboxListResult,
  BotNewSessionResult,
  BotNotesResult,
  BotPersonaSuggestResult,
  BotSendResult,
  BotsListResult,
  BotTeamCreateResult,
  BotTeamPreviewResult,
  BotTimelineResult,
  BotWriteIpcResult,
} from '@shared/types/botIpc';
import { isUsageRangeDays } from '@shared/usage/types';
import {
  abortCompleteText,
  abortSession,
  agentTypeRegistrySnapshot,
  classifyChoice,
  completeText,
  isAgentWorkerReady,
  promptSession,
  readSettingsState,
  releaseParentSession,
  resolveModelSelection,
  resolveVirtualClassifier,
  respondApproval,
  retrySession,
  rewindSession,
  setSessionModel,
  setSessionReasoning,
  setSessionThinking,
  spawnSession,
  steerSession,
} from '../services/agentHost';
import {
  type AbilityCompleter,
  suggestAbilities,
  suggestGoal,
  suggestPersona,
} from '../services/bots/abilitySuggester';
import { BotMemoryService } from '../services/bots/botMemory';
import { BotNotesService, BotNotesStore, type BotNotesTarget } from '../services/bots/botNotes';
import {
  BOT_READONLY_DISABLED_TOOLS,
  mergeBotInstruction,
  pickBotModel,
} from '../services/bots/botPrompt';
import { type BotRuntimePort, BotSessionHost } from '../services/bots/botSessionHost';
import { BotStore } from '../services/bots/botStore';
import { directTurnNotice, groupBatchNotice } from '../services/bots/botTurnNotice';
import { BotUsageService } from '../services/bots/botUsage';
import { ChatSnoozeTimer } from '../services/bots/chatSnooze';
import { BotChatStore } from '../services/bots/chatStore';
import { type ComposerRefs, createComposerRefs } from '../services/bots/composerRefs';
import { turnDelegationTargets } from '../services/bots/delegationBatch';
import { delegationPolicy } from '../services/bots/delegationPolicy';
import { DelegationService } from '../services/bots/delegationService';
import { DelegationStore } from '../services/bots/delegationStore';
import { GroupChatService } from '../services/bots/groupChat';
import {
  parseGroupHistoryQuery,
  queryGroupHistoryNewestFirst,
} from '../services/bots/groupHistory';
import { GroupTaskStore } from '../services/bots/groupTaskStore';
import { GroupTaskService } from '../services/bots/groupTasks';
import { BotInboxService } from '../services/bots/inbox';
import { BotInboxStore } from '../services/bots/inboxStore';
import { mediaFile, ScreenshotCache, sendImage, storeMedia } from '../services/bots/media';
import { compressImage } from '../services/bots/mediaImage';
import { createMemberTaskClassifier } from '../services/bots/memberTaskClassifier';
import { removeBotMemorySpace } from '../services/bots/memoryCleanup';
import {
  briefErrorReason,
  createModelProbe,
  describeModelIssue,
  modelLabel,
} from '../services/bots/modelProbe';
import { proposeRoutine } from '../services/bots/routineProposal';
import { RoutineRunner } from '../services/bots/routineRunner';
import { BotRoutineRunLog } from '../services/bots/routineRuns';
import { RoutineScheduler, routineBlock } from '../services/bots/routineScheduler';
import { BotRoutineStore } from '../services/bots/routineStore';
import {
  type BranchEntry,
  readBotSessionBranch,
  readBotSessionMessages,
  readBotSessionSummary,
} from '../services/bots/sessionMessages';
import { createSmartRouter, type SmartRouterDeps } from '../services/bots/smartRouter';
import { createTeam } from '../services/bots/teamCreate';
import { ThreadTitler } from '../services/bots/threadTitler';
import { type BotDesktop, botDesktop } from '../services/desktopHooks';
import { searchFiles } from '../services/fileSearch';
import { resolveGlobalInstruction } from '../services/instructionStore';
import { setBotAvatarResolver } from '../services/localImageProtocol';
import { listMemories } from '../services/memory/store';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import {
  botChatPasteOwner,
  removePastedTextFiles,
  savePastedTextFile,
} from '../services/pastedTextFiles';
import { resolveRemoteModels } from '../services/remoteModels';
import { broadcastToRenderers, isMainRenderer } from '../services/renderers';
import { removeConversationSessionFiles } from '../services/sessionFileCleanup';
import { botAssistantModelCandidates, titleModelCandidates } from '../services/titleSummary';
import { getUsagePricing, loadUsageSession } from '../services/usage/usageService';
import {
  getSourceAuthorityRegistry,
  readSessionHistoryFile,
  setBotWorkerEventObserver,
} from './agent';
import { listArtifacts, openArtifact, readArtifact, searchChats } from './botsContent';
import {
  type ChatWorkspaceInput,
  parseAbilitySuggestRequest,
  parseBotDraftInput,
  parseBotUpdateInput,
  parseChatCloneInput,
  parseChatCreateInput,
  parseChatUpdateInput,
  parseGoalSuggestRequest,
  parseInboxUpdateInput,
  parseNotesSaveInput,
  parseNotesTargetInput,
  parseOpenWorkspaceInput,
  parsePersonaSuggestRequest,
  parseSendInput,
  parseSessionHistoryInput,
  parseSessionSwitchInput,
  parseThreadChatInput,
  parseThreadSelectInput,
  parseThreadUpdateInput,
  parseTimelineInput,
} from './botsInput';
import { parseTeamCreateInput, parseTeamPreviewInput } from './botsTeamInput';
import { agentSessionIndex } from './sessionIndex';

interface BotServices {
  bots: BotStore;
  chats: BotChatStore;
  host: BotSessionHost;
  groups: GroupChatService;
  memory: BotMemoryService;
  notes: BotNotesService;
  delegations: DelegationService;
  routines: BotRoutineStore;
  routineRuns: BotRoutineRunLog;
  scheduler: RoutineScheduler;
  runner: RoutineRunner;
  tasks: GroupTaskService;
  usage: BotUsageService;
  snooze: ChatSnoozeTimer;
  inbox: BotInboxService;
  composerRefs: ComposerRefs;
  titler: ThreadTitler;
  /** 停掉话题命名：退订事件并丢弃进行中的结果 */
  stopTitler: () => void;
}

type GroupSender = (
  chat: BotChat,
  text: string,
  options: { images?: AttachedImage[]; deliveryId: string },
  refs?: HumanEntryRefs,
  media?: string[]
) => Promise<BotSendResult>;

let services: BotServices | null = null;
let groupSender: GroupSender | null = null;

const DISABLED = { ok: false as const, error: 'disabled' };
const INVALID = { ok: false as const, error: 'invalid' };
const UNAVAILABLE = { ok: false as const, error: 'unavailable' };

/** 群聊模块挂点：未注册时群聊发送返回 group-not-ready */
export function setBotGroupSender(sender: GroupSender | null): void {
  groupSender = sender;
}

export function botModeEnabled(): boolean {
  return readSettingsState()?.botModeEnabled === true;
}

/** 讨论模式（实验性）总开关；非布尔值一律按关闭 */
function botDiscussModeEnabled(): boolean {
  return readSettingsState()?.botDiscussModeEnabled === true;
}

export function emitBotEvent(event: BotEvent): void {
  if (event.kind === 'catalog' || event.kind === 'chat') services?.scheduler.refresh();
  if (event.kind === 'chat') services?.snooze.refresh();
  if (event.kind !== 'inbox') services?.inbox.onBotEvent(event);
  try {
    broadcastToRenderers(IPC_CHANNELS.BOT_EVENT, event);
  } catch {
    // renderer 已销毁
  }
  for (const observer of botEventObservers) {
    try {
      observer(event);
    } catch (error) {
      console.warn('[bots] event observer failed', error);
    }
  }
}

const botEventObservers = new Set<(event: BotEvent) => void>();

/** 窗口之外的 Bot 事件订阅方（手机转发） */
export function observeBotEvents(observer: (event: BotEvent) => void): () => void {
  botEventObservers.add(observer);
  return () => botEventObservers.delete(observer);
}

const sessionDir = () => path.join(app.getPath('userData'), 'agent', 'sessions');

function notifyQuietly(chatId: string, build: Parameters<BotDesktop['notifyChat']>[1]): void {
  void botDesktop()
    .notifyChat(chatId, build)
    .catch((error) => console.warn('[bots] notification failed', error));
}

/** 新消息让已搁置的聊天回到进行中 */
function wakeChat(chats: BotChatStore, chatId: string): void {
  // 搁置状态在根群上，话题里的新消息同样唤醒
  const chat = chats.rootOf(chatId);
  if (!chat || !wakeOnActivity(chat)) return;
  if (chats.update(chat.id, (draft) => wakeOnActivity(draft) ?? draft))
    emitBotEvent({ kind: 'chat', chatId: chat.id });
}

function rootIdentity(conversationId: string): SessionIdentity | undefined {
  const identity = agentSessionIndex.currentIdentity(conversationId);
  return identity && !('parent' in identity) ? identity : undefined;
}

/** 成员模型解析失败时的可读提示：所选引擎不可用报所选；无引擎/默认也不可用报默认或「未配置可用模型」 */
function botModelIssue(engine: BotEngine | undefined, keys: ReadonlySet<string>): string {
  const state = readSettingsState();
  if (engine) return describeModelIssue(state, engine, keys);
  const fallback = readSettingsState()?.defaultModel;
  const ref =
    fallback && typeof fallback === 'object'
      ? (fallback as { providerId?: unknown; modelId?: unknown })
      : null;
  return ref && typeof ref.providerId === 'string' && typeof ref.modelId === 'string'
    ? describeModelIssue(state, { providerId: ref.providerId, modelId: ref.modelId }, keys)
    : '未配置可用模型';
}

/**
 * Bot 父会话最近一次 spawn 成功的实例：sessionId → { 实例号, 是否还没见到它的结束 }。
 * 会话索引在 status:failed 时也把 alive 置 false，但 failed 只说明回合出错：supervisor 里的实例没销毁，
 * 也不保证随后发 parent-ended。只凭 isAlive 跳过 release，下次同 identity spawn 会命中旧实例直接回
 * parent-ready，说明重建形同虚设。只有回显本实例号的 parent-ended / parent-rejected、worker-exited 或 release
 * 成功才算结束；这些之后 worker 里确实没有该实例，release-parent 不会有回执，跳过可免空等超时。
 * 归属只看实例号（宿主每次 spawn 生成、worker 回显）：旧实例命令的拒绝回显旧号，不会关掉新实例的登记。
 */
const instances = new Map<string, { instanceId: string; open: boolean }>();
/**
 * 正在等 releaseParentSession 的调用。agentHost 见到同会话的第一条 parent-ended / parent-rejected 就唤醒
 * 等待者，不看它属于哪个实例；这里按实例号记下唤醒它的那条事件是不是要释放的实例。agentHost 先唤醒、再把同一条
 * 事件同步交给 Bot 观察者，release 的后续代码在微任务里执行，此时 trackInstanceEnd 已记好。
 * 唤醒者若是旧实例的拒绝，新实例的 release-parent 还排在 worker 里，不能当作已释放。
 */
const releaseWatches = new Map<string, Set<{ instanceId: string; stale?: boolean }>>();

function trackInstanceEnd(event: AgentWorkerEvent | { type: 'worker-exited' }): void {
  if (event.type === 'worker-exited') {
    instances.clear();
    return;
  }
  if (event.type !== 'parent-ended' && event.type !== 'parent-rejected') return;
  const id = event.identity.sessionId;
  for (const watch of releaseWatches.get(id) ?? [])
    watch.stale ??= event.instanceId !== watch.instanceId;
  const current = instances.get(id);
  if (current && event.instanceId === current.instanceId) current.open = false;
}

/** 等 agentHost 的 release 回执，并认出被别的实例的结束事件提前唤醒的情况（见 releaseWatches） */
async function releaseConfirmed(identity: SessionIdentity, instanceId: string): Promise<void> {
  const id = identity.sessionId;
  const watch: { instanceId: string; stale?: boolean } = { instanceId };
  const watches = releaseWatches.get(id) ?? new Set();
  watches.add(watch);
  releaseWatches.set(id, watches);
  let released: { ok: boolean; error?: string };
  try {
    released = await releaseParentSession(identity);
  } finally {
    watches.delete(watch);
    if (!watches.size && releaseWatches.get(id) === watches) releaseWatches.delete(id);
  }
  if (!released.ok) throw new Error(released.error ?? 'release-failed');
  // 实例登记保留，等排在后面的 release-parent 回真正的 parent-ended 再清；宿主按 release 失败处理
  if (watch.stale) throw new Error('release-unconfirmed');
}

function createRuntime(botsRoot: string): BotRuntimePort {
  return {
    async updateEngine(conversationId, engine) {
      const identity = rootIdentity(conversationId);
      if (!identity) return { ok: false, error: 'stale session generation' };
      let keys: ReadonlySet<string>;
      try {
        keys = await readStoredOauthCredentialKeys();
      } catch {
        return { ok: false, error: 'model credentials unavailable' };
      }
      const model = pickBotModel(
        engine,
        readSettingsState() ?? {},
        (ref) => resolveModelSelection(ref.providerId, ref.modelId, keys, { allowVirtual: true }).ok
      );
      if (!model) return { ok: false, error: botModelIssue(engine, keys) };
      if (rootIdentity(conversationId)?.generation !== identity.generation)
        return { ok: false, error: 'stale session generation' };
      // worker 按会话串行执行命令，模型与推理档先于随后投递的 prompt 生效。
      const changed = setSessionModel(identity, model.providerId, model.modelId, keys);
      if (!changed.ok) return changed;
      const reasoning = setSessionReasoning(identity, model.reasoningEnabled, model.thinkingLevel);
      return reasoning.ok ? setSessionThinking(identity, model.thinkingLevel) : reasoning;
    },
    async spawn(spec) {
      const identity = rootIdentity(spec.conversationId) ?? {
        sessionId: spec.conversationId,
        generation: randomUUID(),
      };
      agentSessionIndex.prepareParent(identity);
      let keys: ReadonlySet<string>;
      try {
        keys = await readStoredOauthCredentialKeys();
      } catch {
        return { ok: false, error: 'model credentials unavailable' };
      }
      const model = pickBotModel(
        spec.bot.engine,
        readSettingsState() ?? {},
        (ref) => resolveModelSelection(ref.providerId, ref.modelId, keys, { allowVirtual: true }).ok
      );
      if (!model) return { ok: false, error: botModelIssue(spec.bot.engine, keys) };
      const spawned = spawnSession(
        identity,
        {
          sessionId: spec.conversationId,
          providerId: model.providerId,
          modelId: model.modelId,
          cwd: spec.cwd,
          ...(spec.resumeFile ? { resumeFile: spec.resumeFile } : {}),
          reasoningEnabled: model.reasoningEnabled,
          thinkingLevel: model.thinkingLevel,
          approvalMode: spec.bot.approvalMode,
        },
        keys,
        undefined,
        spec.projectId,
        {
          extraDisabledTools: spec.bot.tools === 'readonly' ? BOT_READONLY_DISABLED_TOOLS : [],
          bot: {
            systemPrompt: spec.systemPrompt,
            instruction: mergeBotInstruction(
              resolveGlobalInstruction(),
              spec.instructionText,
              path.join(botsRoot, spec.bot.id, 'BOT_MODE.md')
            ),
            skillIds: spec.bot.skillIds,
            mcpServerIds: spec.bot.mcpServerIds,
            ...(spec.groupTasks ? { groupTasks: true } : {}),
            ...(spec.groupTasks && spec.discussMode ? { discussMode: true } : {}),
            ...(spec.routines ? { routines: true } : {}),
            ...(spec.delegationTask ? { delegationTask: true } : {}),
            ...(spec.writeLock ? { writeLock: spec.writeLock } : {}),
          },
          // 之后同会话的 prompt / steer / retry 由 agentHost 自动带上这个号
          instanceId: spec.instanceId,
        }
      );
      if (spawned.ok)
        instances.set(identity.sessionId, { instanceId: spec.instanceId, open: true });
      return spawned;
    },
    prompt(conversationId, text, images, deliveryId, resume) {
      const identity = rootIdentity(conversationId);
      if (!identity) return { ok: false, error: 'stale session generation' };
      return resume
        ? promptSession(identity, text, images, deliveryId, resume)
        : promptSession(identity, text, images, deliveryId);
    },
    steer(conversationId, text, images, deliveryId) {
      const identity = rootIdentity(conversationId);
      return identity
        ? steerSession(identity, text, images, deliveryId, true)
        : { ok: false, error: 'stale session generation' };
    },
    async release(conversationId) {
      const identity = rootIdentity(conversationId);
      const instance = instances.get(conversationId);
      if (!identity || !instance || (!instance.open && !agentSessionIndex.isAlive(conversationId)))
        return;
      await releaseConfirmed(identity, instance.instanceId);
      if (instances.get(conversationId) === instance) instance.open = false;
    },
    abort(conversationId) {
      const identity = rootIdentity(conversationId);
      if (identity) abortSession(identity);
    },
    rewind(conversationId, entryId, restoreFiles) {
      const identity = rootIdentity(conversationId);
      return identity
        ? rewindSession(identity, entryId, restoreFiles)
        : { ok: false, error: 'stale session generation' };
    },
    retry(conversationId) {
      const identity = rootIdentity(conversationId);
      return identity ? retrySession(identity) : { ok: false, error: 'stale session generation' };
    },
    removeSessionFiles(conversation) {
      removeConversationSessionFiles({
        sessionDir: sessionDir(),
        conversationId: conversation.conversationId,
        ...(conversation.sessionFile ? { sessionFile: conversation.sessionFile } : {}),
      });
    },
  };
}

/** 首次使用时才建；开关关闭时不创建任何 Bot 服务 */
export function getBotServices(): BotServices | null {
  if (!botModeEnabled()) return null;
  if (services) return services;
  const authority = getSourceAuthorityRegistry();
  if (!authority) return null;
  const userData = app.getPath('userData');
  const botsRoot = path.join(userData, 'bots');
  const bots = new BotStore(botsRoot);
  const chats = new BotChatStore(path.join(userData, 'bot-chats'));
  const notes = new BotNotesService({
    store: new BotNotesStore({ bots: botsRoot, chats: path.join(userData, 'bot-chats') }),
    complete: assistantCompleter(4096),
    enabled: (botId) => bots.get(botId)?.memory.enabled === true,
    recent: recentDistilled,
    onChange: (target) => emitBotEvent(notesEvent(target)),
  });
  const usage = new BotUsageService({
    bots,
    conversations: () => authority.botConversations(),
    load: loadUsageSession,
    pricing: getUsagePricing,
  });
  const routingDeps: SmartRouterDeps = {
    settings: () => readSettingsState(),
    judge: async ({ preferred, maxTokens = 1024, ...request }, signal) => {
      const state = readSettingsState();
      if (!state) throw new Error('设置不可用');
      if (!isAgentWorkerReady()) throw new Error('会话服务未启动');
      const chain = [...(preferred ? [preferred] : []), ...titleModelCandidates(state)];
      const keys = await readStoredOauthCredentialKeys();
      const candidates = await resolveRemoteModels(chain);
      if (candidates.length === 0) {
        if (signal.aborted) return null;
        const first = chain[0];
        throw new Error(first ? describeModelIssue(state, first, keys) : '未配置可用模型');
      }
      if (signal.aborted) return null;
      const requestId = randomUUID();
      const abort = () => abortCompleteText(requestId);
      signal.addEventListener('abort', abort, { once: true });
      try {
        return await completeText({
          requestId,
          ...request,
          candidates,
          maxTokens,
          reasoning: 'off',
        });
      } catch (error) {
        if (signal.aborted) return null;
        const ref = preferred ?? chain[0];
        throw new Error(
          ref ? `模型 ${modelLabel(state, ref)}：${briefErrorReason(error)}` : '选人模型不可用'
        );
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    classify: async (config, question, signal) => {
      const state = readSettingsState();
      if (!state) throw new Error('设置不可用');
      const keys = await readStoredOauthCredentialKeys();
      const resolved = resolveVirtualClassifier(config, keys);
      if (!resolved?.classifier) throw new Error(describeModelIssue(state, config.model, keys));
      if (!isAgentWorkerReady()) throw new Error('会话服务未启动');
      try {
        return await classifyChoice(
          { classifier: resolved.classifier, ...question, timeoutMs: config.timeoutMs },
          signal
        );
      } catch (error) {
        if (signal.aborted) return null;
        throw new Error(`模型 ${modelLabel(state, config.model)}：${briefErrorReason(error)}`);
      }
    },
  };
  const probe = createModelProbe({
    settings: () => readSettingsState(),
    credentials: () => readStoredOauthCredentialKeys(),
    resolve: (ref, keys) => {
      const resolved = resolveModelSelection(ref.providerId, ref.modelId, keys, {
        allowVirtual: true,
      });
      return resolved.ok
        ? { ok: true, config: resolved.selection.config }
        : { ok: false, error: resolved.error };
    },
    isWorkerReady: isAgentWorkerReady,
    complete: ({ systemPrompt, userText, candidates, timeoutMs, maxTokens }) =>
      completeText({ systemPrompt, userText, candidates, timeoutMs, maxTokens, probe: true }),
  });
  const host = new BotSessionHost({
    bots,
    chats,
    authority,
    runtime: createRuntime(botsRoot),
    maxRunningTurns: normalizeBotMaxRunningTurns(readSettingsState()?.botMaxRunningTurns),
    emit: emitBotEvent,
    notes,
    budget: usage,
    classifyMemberTask: createMemberTaskClassifier(routingDeps),
    probe: (bot) => probe(bot.engine),
    invalidateProbe: (bot) => probe.invalidate(bot.engine),
    language: () => (String(readSettingsState()?.language ?? 'zh').startsWith('zh') ? 'zh' : 'en'),
    discussEnabled: botDiscussModeEnabled,
  });
  const delegationStore = new DelegationStore(
    path.join(userData, 'bot-chats', 'delegations.jsonl')
  );
  const taskStore = new GroupTaskStore(path.join(userData, 'bot-chats'));
  let titlerRef: ThreadTitler | undefined;
  const composerRefs = createComposerRefs({
    bots,
    chats,
    skills: () => skillEntries(readSettingsState()?.skills),
    sessionMessages: (conversationId) =>
      readBotSessionMessages(sessionDir(), authority.conversation(conversationId)?.sessionFile),
    workspacePath: (chatId) => host.workspacePath(chatId),
    taskBrief: (chatId, taskId) => tasks.previousRuns(chatId, taskId),
  });
  const groups = new GroupChatService({
    bots,
    chats,
    host,
    emit: emitBotEvent,
    retryImages: (chatId, ids) =>
      ids.map((id) => {
        const file = mediaFile(chats.mediaDir(chatId), id);
        if (!file) throw new Error('missing image');
        return {
          data: readFileSync(file).toString('base64'),
          mimeType: id.endsWith('.jpg') ? 'image/jpeg' : `image/${id.split('.').at(-1)}`,
        };
      }),
    refsAppendix: (chat, botId, entries) => composerRefs.groupAppendix(chat, botId, entries),
    onBatchSettled: (batch) => {
      titlerRef?.notify(batch.chatId);
      const chat = chats.get(batch.chatId);
      if (!chat) return;
      const name = (id: string) => bots.get(id)?.name ?? '?';
      notifyQuietly(chat.id, (lang) =>
        groupBatchNotice(
          {
            chatTitle: chat.title,
            names: batch.botIds.map(name),
            failedNames: batch.failed.map(name),
            ...(batch.lastBotId ? { lastName: name(batch.lastBotId) } : {}),
            ...(batch.lastText ? { lastText: batch.lastText } : {}),
          },
          lang
        )
      );
    },
    delegatedTargets: (conversationId, turnKey) =>
      turnDelegationTargets(delegationStore.list(), conversationId, turnKey),
    groupState: (chatId) => ({
      delegations: delegationStore
        .list(chatId)
        .filter((record) => record.state === 'queued' || record.state === 'running')
        .map((record) => ({
          from: record.parentBotId,
          to: record.targetBotId,
          state: record.state,
          task: record.task,
        })),
      tasks: taskStore
        .list(chats.rootOf(chatId)?.id ?? chatId)
        .filter((task) => task.status !== 'done' && task.status !== 'canceled'),
    }),
    responder: createSmartRouter(routingDeps),
    discussEnabled: botDiscussModeEnabled,
  });
  host.onDiscard((scope) => {
    if (scope.chatId) groups.discard(scope.chatId);
    groups.clearCompacted(scope);
  });
  host.onTurnFinished((event) => {
    // 私聊每轮一条；群聊按接力批次合并（onBatchSettled）；委派结果回到发起方再通知；用户停止不报
    const chat = event.chatId && !event.delegationId ? chats.get(event.chatId) : undefined;
    if (chat && event.ok && event.text.trim() && !isSkipReply(event.text)) wakeChat(chats, chat.id);
    if (chat?.kind !== 'direct' || event.error === 'canceled') return;
    const name = bots.get(event.botId)?.name ?? '?';
    notifyQuietly(chat.id, (lang) =>
      directTurnNotice(
        {
          name,
          ok: event.ok,
          text: event.text,
          ...(event.error ? { error: event.error } : {}),
          ...(event.estimated ? { estimated: event.estimated } : {}),
        },
        lang
      )
    );
  });
  let delegationsRef: DelegationService | undefined;
  const conversationMessages = (conversationId: string) =>
    readBotSessionMessages(sessionDir(), authority.conversation(conversationId)?.sessionFile);
  const tasks = new GroupTaskService({
    store: taskStore,
    chats,
    bots,
    emit: emitBotEvent,
    send: (chatId, text, refs) =>
      groups.send(chatId, text, { deliveryId: randomUUID(), source: 'human' }, refs),
    cancelDelegation: (id) => {
      delegationsRef?.cancel(id);
    },
    sessionMessages: async (chatId, botId) => {
      const conversationId = chats.get(chatId)?.sessions[botId]?.conversationId;
      if (!conversationId) throw new Error('member session unavailable');
      return conversationMessages(conversationId);
    },
    delegations: () => delegationStore.list(),
    rework: (input) => delegationsRef?.rework(input) ?? { ok: false, error: 'disabled' },
    reply: (input) => delegationsRef?.reply(input) ?? { ok: false, error: 'disabled' },
    interject: async (input) =>
      delegationsRef ? delegationsRef.interject(input) : { ok: false, error: 'disabled' },
  });
  host.onDiscard((scope) => {
    if (scope.botId) tasks.releaseBot(scope.botId);
  });
  const delegations = new DelegationService({
    bots,
    chats,
    host,
    authority,
    store: delegationStore,
    emit: emitBotEvent,
    tasks,
    sessionMessages: conversationMessages,
    deliverGroupResult: async (record, text, deliveryId, batch) => {
      if (
        !record.chatId ||
        chats.get(record.chatId)?.sessions[record.parentBotId]?.conversationId !==
          record.parentConversationId
      )
        return { ok: false, error: 'parent-session-changed' };
      return groups.runAs(
        record.chatId,
        record.parentBotId,
        text,
        undefined,
        { onlyIfIdle: true, source: 'bot', deliveryId },
        { hideDelegationIds: batch.map((item) => item.id) }
      );
    },
  });
  delegationsRef = delegations;
  // 群话题 AI 命名：复用设置里的标题总结开关与标题模型回退链（群话题没有会话模型这一级）
  const titler = new ThreadTitler({
    chats,
    enabled: () => readSettingsState()?.titleSummaryEnabled === true,
    work: {
      groupState: (chatId) => groups.state(chatId),
      conversationBusy: (conversationId) => host.isBusy(conversationId),
      queued: (chatId) => host.queueState().some((item) => item.chatId === chatId),
      delegations: (chatId) => delegationStore.list(chatId),
    },
    candidates: async () => {
      const state = readSettingsState();
      if (!state || !isAgentWorkerReady()) return [];
      return resolveRemoteModels(titleModelCandidates(state));
    },
    complete: (input) => completeText(input),
    abort: (requestId) => abortCompleteText(requestId),
    emit: (chatId) => emitBotEvent({ kind: 'chat', chatId }),
  });
  titlerRef = titler;
  host.onTurnFinished((event) => {
    if (event.chatId) titler.notify(event.chatId);
  });
  const stopTitlerEvents = observeBotEvents((event) => {
    if (event.kind === 'delegation' && event.chatId) titler.notify(event.chatId);
  });
  const routines = new BotRoutineStore(botsRoot);
  const routineRuns = new BotRoutineRunLog(botsRoot);
  const runner = new RoutineRunner({
    host,
    chats,
    groups,
    deny: (identity, requestId) => {
      if (agentSessionIndex.isCurrent(identity)) respondApproval(identity, requestId, 'deny');
    },
  });
  const scheduler = new RoutineScheduler({
    store: routines,
    runs: routineRuns,
    eligible: (routine) => {
      const bot = bots.get(routine.botId);
      return Boolean(bot && bot.archivedAt === undefined);
    },
    check: (routine) =>
      routineBlock(routine, { bot: (id) => bots.get(id), chat: (id) => chats.get(id) }),
    run: (routine, options) => runner.run(routine, options),
    emit: emitBotEvent,
  });
  const inbox = new BotInboxService({
    store: new BotInboxStore(path.join(userData, 'bot-chats', 'inbox.jsonl')),
    conversation: (id) => authority.conversation(id),
    delegations: () => delegationStore.list(),
    routines: () => routines.listAll(),
    usage: () => usage.overview(),
    silences: () => host.silences(),
    emit: emitBotEvent,
    taskBlocked: (record) =>
      !!record.chatId &&
      tasks
        .list(record.chatId)
        .some(
          (task) =>
            task.id === record.taskId &&
            task.status === 'blocked' &&
            task.delegationId === record.id
        ),
  });
  host.onTurnFinished((event) => inbox.turnFinished(event.conversationId));
  setBotWorkerEventObserver((event) => {
    trackInstanceEnd(event);
    runner.observe(event);
    host.observe(event);
    inbox.observe(event);
    if (event.type === 'status' && event.status === 'running')
      delegations.observeRunning(event.identity.sessionId);
  });
  const memory = new BotMemoryService({
    bots,
    chats,
    watermarksFile: path.join(userData, 'bot-chats', 'memory-watermarks.json'),
    isCodeProject: (id) => {
      const project = authority.project(id);
      return (
        project?.state === 'active' && project.kind !== 'bot-home' && project.kind !== 'scratch'
      );
    },
    schedule: async (payload) =>
      (await import('../services/memoryHost')).scheduleMemoryDistill(payload),
    onDistilled: (input) => void notes.afterDistill(input),
  });
  host.onDiscard((scope) => {
    if (scope.conversationId) memory.remove(scope.conversationId);
  });
  setBotGroupSender((chat, text, options, refs, media) =>
    groups.send(chat.id, text, options, refs, media)
  );
  const snooze = new ChatSnoozeTimer({
    chats,
    onDue: (chat) => {
      emitBotEvent({ kind: 'reminder', chatId: chat.id });
      emitBotEvent({ kind: 'chat', chatId: chat.id });
      const title =
        chat.kind === 'group' ? chat.title : (bots.get(chat.members[0])?.name ?? chat.title);
      notifyQuietly(chat.id, (lang) => ({
        title: lang === 'zh' ? `稍后提醒 · ${title}` : `Reminder · ${title}`,
        body: lang === 'zh' ? '到时间回来看看这个聊天了。' : 'Time to get back to this chat.',
      }));
    },
  });
  services = {
    bots,
    chats,
    host,
    groups,
    memory,
    notes,
    delegations,
    routines,
    routineRuns,
    scheduler,
    runner,
    tasks,
    usage,
    composerRefs,
    snooze,
    inbox,
    titler,
    stopTitler: () => {
      stopTitlerEvents();
      titler.dispose();
    },
  };
  if (botModeEnabled()) scheduler.start();
  snooze.refresh();
  return services;
}

export function syncBotModeServices(): void {
  if (botModeEnabled()) {
    const current = getBotServices();
    current?.host.setMaxRunningTurns(readSettingsState()?.botMaxRunningTurns);
    current?.scheduler.start();
  } else if (services) {
    const previous = services;
    previous.host.freeze();
    previous.scheduler.stop();
    previous.groups.dispose();
    previous.delegations.disable();
    previous.host.dispose();
    previous.runner.dispose();
    previous.memory.dispose();
    previous.snooze.dispose();
    previous.stopTitler();
    setBotWorkerEventObserver(null);
    setBotGroupSender(null);
    services = null;
  }
}

/**
 * 讨论模式开关变化：群聊在锁内收掉 / 放开讨论，群成员会话按新说明重建（上下文保留）。
 * 不能复用 syncBotModeServices：它在 Bot 模式关闭时会销毁整套服务。Bot 服务没在跑时无事可做，
 * 之后建出来的服务与会话直接读当前开关。
 */
export function syncBotDiscussMode(): void {
  const current = services;
  if (!current) return;
  void current.groups
    .syncDiscussMode()
    .catch((error) => console.warn('[bots] discuss mode sync failed', error));
  void current.host
    .refreshGroupInstructions()
    .catch((error) => console.warn('[bots] instruction refresh failed', error));
}

function reservedNames(): string[] {
  return [
    ...BUILTIN_AGENT_TYPES.map((type) => type.name),
    ...agentTypeRegistrySnapshot()
      .candidates.filter((candidate) => candidate.source !== 'bot')
      .map((candidate) => candidate.displayName),
  ];
}

function resolveWorkspaceInput(
  bots: BotServices,
  chatId: string,
  input: ChatWorkspaceInput
): BotChatWorkspace | { error: string } {
  if (input.kind === 'member-home') return { kind: 'member-home' };
  const authority = getSourceAuthorityRegistry();
  if (input.kind === 'chat-home') {
    const project = authority?.ensureBotHomeProject(bots.chats.workspaceDir(chatId));
    return project ? { kind: 'chat-home', projectId: project.projectId } : { error: 'unavailable' };
  }
  const project = authority?.project(input.projectId);
  if (project?.state !== 'active') return { error: 'workspace-unavailable' };
  if (project.kind === 'ssh' || project.kind === 'bot-home') {
    return { error: 'workspace-unsupported' };
  }
  if (project.kind === 'scratch') return { error: 'workspace-unsupported' };
  return { kind: 'project', projectId: project.projectId };
}

function activeMembers(bots: BotServices, members: readonly string[]): boolean {
  return members.every((id) => {
    const bot = bots.bots.get(id);
    return bot !== undefined && bot.archivedAt === undefined;
  });
}

/** 建群失败：撤掉刚建的群专属目录项目 */
function discardNewChatHome(bots: BotServices, chatId: string, workspace: BotChatWorkspace): void {
  if (workspace.kind !== 'chat-home') return;
  getSourceAuthorityRegistry()?.removeBotHomeProject(workspace.projectId);
  rmSync(path.dirname(bots.chats.workspaceDir(chatId)), { recursive: true, force: true });
}

/**
 * 群开新对话：停掉所有成员与排队，未 keep 的委派取消，结束全部成员会话，写分隔线并记 epochSeq。
 * 旧段不提炼进记忆；当前段为空时不重复写分隔线。
 */
async function startGroupConversation(
  services: BotServices,
  chat: BotChat
): Promise<BotNewSessionResult> {
  const { chats, host, groups, delegations } = services;
  const epochSeq = chat.epochSeq ?? 0;
  if (chats.lastSeq(chat.id) <= epochSeq) return { ok: true, epochSeq };
  const stopped = await groups.stop(chat.id);
  if (!stopped.ok) return stopped;
  await Promise.all(Object.keys(chat.sessions).map((botId) => host.stopTurn(chat.id, botId)));
  delegations.startOver(chat.id);
  host.resetSessions(chat.id);
  const divider = chats.appendEntry(chat.id, {
    kind: 'system',
    id: randomUUID(),
    at: Date.now(),
    text: '新对话',
    newConversation: true,
  });
  if (!divider) return INVALID;
  chats.update(chat.id, (draft) => ({ ...draft, epochSeq: divider.seq }));
  emitBotEvent({ kind: 'timeline', chatId: chat.id, seq: divider.seq });
  emitBotEvent({ kind: 'chat', chatId: chat.id });
  void delegations.deliverPending();
  return { ok: true, epochSeq: divider.seq };
}

const resettingChats = new Set<string>();

function groupHasPendingWork(services: BotServices, chat: BotChat): boolean {
  const state = services.groups.state(chat.id);
  return Boolean(
    (state.ok && (state.current || state.queue.length || state.pendingHuman || state.routing)) ||
      Object.values(chat.sessions).some(({ conversationId }) =>
        services.host.isBusy(conversationId)
      ) ||
      services.host.queueState().some((item) => item.chatId === chat.id) ||
      services.delegations
        .list(chat.id)
        .some((item) => item.state === 'queued' || item.state === 'running')
  );
}

/** 桌面已在 UI 确认；手机必须在 Main 按当前运行态检查是否需要确认。 */
export async function newBotSession(
  services: BotServices,
  request: unknown,
  confirmed = true
): Promise<BotNewSessionResult | { ok: false; needsConfirmation: true }> {
  const { chats, host, memory } = services;
  const chatId = chatIdOf(request);
  const chat = chatId ? chats.get(chatId) : undefined;
  if (!chat) return INVALID;
  if (resettingChats.has(chat.id)) return { ok: false, error: 'session-busy' };
  if (chat.kind === 'group' && !confirmed && groupHasPendingWork(services, chat)) {
    return { ok: false, needsConfirmation: true };
  }
  resettingChats.add(chat.id);
  try {
    if (chat.kind === 'group') return await startGroupConversation(services, chat);
    const old = chat.sessions[chat.members[0]];
    if (old) await host.stopTurn(chat.id, chat.members[0]);
    const conversation = old && getSourceAuthorityRegistry()?.conversation(old.conversationId);
    if (conversation) await memory.distill(conversation);
    return host.ensureSession(chat.id, chat.members[0], { fresh: true });
  } finally {
    resettingChats.delete(chat.id);
  }
}

/** 私聊切回旧对话：先停当前回合并提炼当前会话记忆，再重新打开目标会话；回复中由桌面先确认 */
/** 群新话题（桌面与手机共用）：当前话题还没人说话时直接复用，不堆空话题 */
export function createBotThread({ chats }: BotServices, request: unknown): BotChatWriteResult {
  const chatId = parseThreadChatInput(request);
  const root = chatId ? chats.get(chatId) : undefined;
  if (root?.kind !== 'group' || root.parentId || root.archivedAt !== undefined) return INVALID;
  const active = chats.activeThread(root.id);
  if (active?.parentId && chats.lastSeq(active.id) === 0) return { ok: true, chat: active };
  const thread = chats.createThread(root.id);
  if (!thread) return INVALID;
  chats.update(root.id, (draft) => ({ ...draft, activeThreadId: thread.id }));
  emitBotEvent({ kind: 'chat', chatId: thread.id });
  emitBotEvent({ kind: 'chat', chatId: root.id });
  return { ok: true, chat: thread };
}

export function selectBotThread({ chats }: BotServices, request: unknown): BotActionResult {
  const input = parseThreadSelectInput(request);
  const root = input ? chats.get(input.chatId) : undefined;
  if (!input || !root || !chats.threadsOf(root.id).some((chat) => chat.id === input.threadId))
    return INVALID;
  chats.update(root.id, (draft) => {
    if (input.threadId === root.id) delete draft.activeThreadId;
    else draft.activeThreadId = input.threadId;
    return draft;
  });
  emitBotEvent({ kind: 'chat', chatId: root.id });
  return { ok: true };
}

async function switchBotSession(services: BotServices, request: unknown): Promise<BotActionResult> {
  const { chats, host, memory } = services;
  const input = parseSessionSwitchInput(request);
  const chat = input ? chats.get(input.chatId) : undefined;
  if (!input || chat?.kind !== 'direct') return INVALID;
  const botId = chat.members[0];
  const checked = host.canSwitch(chat.id, botId, input.conversationId);
  if (!checked.ok) return checked;
  if (resettingChats.has(chat.id)) return { ok: false, error: 'session-busy' };
  resettingChats.add(chat.id);
  try {
    const old = chat.sessions[botId];
    if (old?.conversationId === input.conversationId) return { ok: true };
    if (old) await host.stopTurn(chat.id, botId);
    const conversation = old && getSourceAuthorityRegistry()?.conversation(old.conversationId);
    if (conversation) await memory.distill(conversation);
    return host.switchSession(chat.id, botId, input.conversationId);
  } finally {
    resettingChats.delete(chat.id);
  }
}

type Handler = (sender: number, request: unknown, bots: BotServices) => unknown;

/**
 * 开关关闭时一律返回 whenDisabled 且不创建任何 Bot 服务（列表类返回空 + enabled:false）；
 * write 另要求主窗口。
 */
function handle(
  channel: string,
  kind: 'read' | 'write',
  handler: Handler,
  whenDisabled: unknown = DISABLED
): void {
  ipcMain.handle(channel, async (event, request: unknown) => {
    if (kind === 'write' && !isMainRenderer(event.sender.id)) return UNAVAILABLE;
    if (!botModeEnabled()) return whenDisabled;
    try {
      const bots = getBotServices();
      return bots ? await handler(event.sender.id, request, bots) : UNAVAILABLE;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'unavailable' };
    }
  });
}

const botIdOf = (request: unknown): string | null => {
  const botId =
    request && typeof request === 'object' && 'botId' in request ? request.botId : undefined;
  return isBotId(botId) ? botId : null;
};
const chatIdOf = (request: unknown): string | null => {
  const chatId =
    request && typeof request === 'object' && 'chatId' in request ? request.chatId : undefined;
  return isBotId(chatId) ? chatId : null;
};

/** 设置里的技能 / MCP 条目 → 推荐候选（只取 id、名称、描述） */
function catalogItems(value: unknown): { id: string; name: string; description?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { id, name, description, enabled } = item as Record<string, unknown>;
    // 全局停用的条目成员也用不上，不作为候选
    if (typeof id !== 'string' || typeof name !== 'string' || enabled === false) return [];
    return [{ id, name, ...(typeof description === 'string' ? { description } : {}) }];
  });
}

const notesEvent = (target: BotNotesTarget): BotEvent =>
  target.kind === 'chat' ? { kind: 'notes', chatId: target.id } : { kind: 'notes' };

/** 设置里的技能条目（成员按 skillIds 取用，与 worker 的技能加载一致：不看全局开关） */
function skillEntries(value: unknown): SkillEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is SkillEntry =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.path === 'string' &&
      item.path.length > 0
  );
}

/** since 之后整理写入某空间的结论（核心笔记重写的输入） */
async function recentDistilled(spaceId: string, since: number): Promise<string[]> {
  const { memoryDatabase } = await import('../services/memoryHost');
  return listMemories(memoryDatabase(), { spaceIds: [spaceId], limit: 50 })
    .filter((memory) => memory.source === 'distill' && Date.parse(memory.createdAt) >= since)
    .map((memory) => `${memory.title}: ${memory.content}`);
}

/** 笔记归属必须存在；群笔记只给群聊 */
function notesOwnerExists({ bots, chats }: BotServices, target: BotNotesTarget): boolean {
  return target.kind === 'bot'
    ? bots.get(target.id) !== undefined
    : chats.get(target.id)?.kind === 'group' && !chats.get(target.id)?.parentId;
}

/** Bot 辅助任务的一次性补全：Bot 助理模型 → 默认模型 */
function assistantCompleter(maxTokens: number): AbilityCompleter {
  return async (completion, signal) => {
    const state = readSettingsState();
    if (!state || !isAgentWorkerReady()) return null;
    const candidates = await resolveRemoteModels(botAssistantModelCandidates(state));
    if (candidates.length === 0) return null;
    const requestId = randomUUID();
    signal.addEventListener('abort', () => abortCompleteText(requestId), { once: true });
    return completeText({ requestId, ...completion, candidates, maxTokens });
  };
}

/** 附件必须先存下，任何一张失败都拒绝发送，不能只让成员看到而丢掉时间线附件。 */
function keepGroupImages(
  chats: BotChatStore,
  chatId: string,
  images: readonly AttachedImage[] | undefined
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const ids: string[] = [];
  for (const image of images ?? []) {
    try {
      const stored = storeMedia(chats.mediaDir(chatId), Buffer.from(image.data, 'base64'), {
        compress: compressImage,
      });
      if (!stored.ok) return { ok: false, error: `image-${stored.error}` };
      if (!ids.includes(stored.mediaId)) ids.push(stored.mediaId);
    } catch {
      return { ok: false, error: 'image-storage' };
    }
  }
  return { ok: true, ids };
}

/** 桌面 BOT_SEND 与手机 bot-send 共用 */
export async function sendBotMessage(
  { chats, host, composerRefs, titler }: BotServices,
  request: unknown
): Promise<BotSendResult> {
  const input = parseSendInput(request);
  const chat = input ? chats.get(input.chatId) : undefined;
  if (!input || !chat) return INVALID;
  if (chat.archivedAt !== undefined) return { ok: false, error: 'chat-archived' };
  // 引用不合法时整条拒绝：此时什么都还没发给 worker
  const refused = composerRefs.check(chat, input);
  if (refused) return { ok: false, error: refused };
  // 人类在已搁置的聊天里发言：回到进行中
  wakeChat(chats, chat.id);
  const options = {
    deliveryId: input.deliveryId,
    source: 'human' as const,
    ...(input.images ? { images: input.images } : {}),
  };
  if (chat.kind === 'group') {
    const refs: HumanEntryRefs | undefined =
      input.chats || input.skill
        ? {
            ...(input.chats ? { chats: input.chats } : {}),
            ...(input.skill ? { skill: input.skill } : {}),
          }
        : undefined;
    if (!groupSender) return { ok: false, error: 'group-not-ready' };
    if (input.deliveryId && chats.findEntry(chat.id, `human:${input.deliveryId}`))
      return { ok: true, duplicate: true };
    const images = keepGroupImages(chats, chat.id, input.images);
    if (!images.ok) return images;
    const sent = await groupSender(chat, input.text, options, refs, images.ids);
    // 话题标题：首句占位 + 新话题的 AI 命名（开关关时与原来一样只给子话题取首句）
    if (sent.ok && !sent.duplicate) titler.humanSent(chat.id, input.text);
    return sent;
  }
  const text = await composerRefs.expandDirect(chat, input);
  return host.deliver(chat.id, chat.members[0], text, options);
}

/** 桌面 BOT_CHAT_TIMELINE 与手机 bot-timeline 共用 */
export function readBotTimeline({ chats }: BotServices, request: unknown): BotTimelineResult {
  const input = parseTimelineInput(request);
  if (!input || !chats.get(input.chatId)) return INVALID;
  return {
    ok: true,
    entries:
      input.afterSeq !== undefined
        ? chats.readSince(input.chatId, input.afterSeq, input.limit)
        : chats.readEntries(input.chatId, input),
    lastSeq: chats.lastSeq(input.chatId),
  };
}

/** @文件补全：根目录只来自聊天工作区，renderer 不能指定 */
function searchChatFiles({ chats, host }: BotServices, request: unknown): BotFileSearchResult {
  const input = objectInput(request);
  if (
    !input ||
    Object.keys(input).some((key) => key !== 'chatId' && key !== 'query') ||
    !isBotId(input.chatId) ||
    typeof input.query !== 'string' ||
    input.query.length > 200 ||
    !chats.get(input.chatId)
  )
    return INVALID;
  const root = host.workspacePath(input.chatId);
  return root ? { ok: true, files: searchFiles(root, input.query) } : UNAVAILABLE;
}

/** 私聊回退 / 重试的目标会话：只认私聊当前会话 */
function directSession(
  { chats }: BotServices,
  chatId: unknown
): { chatId: string; conversationId: string } | { ok: false; error: string } {
  const chat = isBotId(chatId) ? chats.get(chatId) : undefined;
  if (!chat) return INVALID;
  if (chat.kind !== 'direct') return { ok: false, error: 'direct-only' };
  if (chat.archivedAt !== undefined) return { ok: false, error: 'chat-archived' };
  const conversationId = chat.sessions[chat.members[0]]?.conversationId;
  return conversationId
    ? { chatId: chat.id, conversationId }
    : { ok: false, error: 'session-unavailable' };
}

/**
 * 私聊回退（复用 Code 的 worker rewind，含文件还原）。worker 接受后同步收尾：
 * 回退点之后发起的委派取消 / 结果作废，记忆水位退回回退点之前。
 */
export async function rewindBotChat(
  services: BotServices,
  request: unknown,
  readBranch: (sessionFile: string | undefined) => Promise<readonly BranchEntry[]> = (file) =>
    readBotSessionBranch(sessionDir(), file)
): Promise<BotActionResult> {
  const input = objectInput(request);
  if (
    !input ||
    Object.keys(input).some((key) => !['chatId', 'entryId', 'restoreFiles'].includes(key)) ||
    typeof input.entryId !== 'string' ||
    !input.entryId.trim() ||
    input.entryId.length > 200 ||
    (input.restoreFiles !== undefined && typeof input.restoreFiles !== 'boolean')
  )
    return INVALID;
  const target = directSession(services, input.chatId);
  if ('ok' in target) return target;
  const { conversationId } = target;
  if (services.host.isBusy(conversationId)) return { ok: false, error: 'session-busy' };
  const branch = await readBranch(
    getSourceAuthorityRegistry()?.conversation(conversationId)?.sessionFile
  ).catch(() => []);
  const entry = branch.find((item) => item.id === input.entryId && item.userAt !== undefined);
  if (!entry?.userAt) return { ok: false, error: 'rewind-target-not-found' };
  const result = await services.host.rewindConversation(
    conversationId,
    entry.id,
    input.restoreFiles === true
  );
  if (!result.ok) return result;
  services.delegations.discardRewound(conversationId, entry.userAt);
  services.memory.rewind(
    conversationId,
    branch.map((item) => item.id),
    entry.id
  );
  emitBotEvent({ kind: 'chat', chatId: target.chatId });
  return { ok: true };
}

/** 重试只收聊天及失败条目标识，目标会话由 Main 权威记录推导。 */
export async function retryBotChat(
  services: BotServices,
  request: unknown
): Promise<BotActionResult> {
  const input = objectInput(request);
  if (
    !input ||
    !isBotId(input.chatId) ||
    Object.keys(input).some((key) => key !== 'chatId' && key !== 'entryId')
  )
    return INVALID;
  if (services.chats.get(input.chatId)?.kind === 'group') {
    if (typeof input.entryId !== 'string' || !input.entryId || input.entryId.length > 200)
      return INVALID;
    return services.groups.retry(input.chatId, input.entryId);
  }
  if (input.entryId !== undefined) return INVALID;
  const target = directSession(services, input.chatId);
  if ('ok' in target) return target;
  const result = await services.host.retryConversation(target.conversationId);
  return result.ok ? { ok: true } : result;
}

const objectInput = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const optionalText = (value: unknown, max: number): value is string | undefined =>
  value === undefined || (typeof value === 'string' && value.length <= max);

/** 看板写入口的公共收窄：chatId + 已存在的群 + 任务 id */
function taskTarget(
  { chats }: BotServices,
  request: unknown
): { input: Record<string, unknown>; chatId: string; id: string } | undefined {
  const input = objectInput(request);
  if (!input || !isBotId(input.chatId) || !isBotId(input.id)) return undefined;
  return chats.get(input.chatId)?.kind === 'group'
    ? { input, chatId: input.chatId, id: input.id }
    : undefined;
}

/** worker 的 group_tasks 调用：只对群聊里该成员的当前会话开放 */
export function groupTasksTool(
  services: BotServices | null | undefined,
  conversationId: string,
  binding: { botId: string; chatId: string | null },
  params: Record<string, unknown>
): unknown {
  const chat = services && binding.chatId ? services.chats.get(binding.chatId) : undefined;
  if (
    !services ||
    chat?.kind !== 'group' ||
    chat.sessions[binding.botId]?.conversationId !== conversationId
  )
    return { ok: false, error: 'Tasks are only available in the current group chat session.' };
  return services.tasks.tool(chat.id, binding.botId, params);
}

/** worker 的 group_history 调用：chatId 只取会话权威绑定，且必须是该成员在该群的当前会话 */
export function groupHistoryTool(
  services: BotServices | null | undefined,
  conversationId: string,
  binding: { botId: string; chatId: string | null },
  params: Record<string, unknown>
): unknown {
  const chat = services && binding.chatId ? services.chats.get(binding.chatId) : undefined;
  if (
    !services ||
    chat?.kind !== 'group' ||
    !chat.members.includes(binding.botId) ||
    chat.sessions[binding.botId]?.conversationId !== conversationId
  )
    return { ok: false, error: 'History is only available in the current group chat session.' };
  const query = parseGroupHistoryQuery(params);
  if (typeof query === 'string') return { ok: false, error: query };
  return queryGroupHistoryNewestFirst(
    services.chats.backward(chat.id, undefined, chat.epochSeq ?? 0),
    (id) => services.bots.get(id)?.name,
    query
  );
}

/** worker 的 routine_propose：chatId 取自会话权威绑定，且必须是该成员在该聊天的当前会话 */
export function routineProposeTool(
  services: BotServices | null | undefined,
  conversationId: string,
  binding: { botId: string; chatId: string | null; delegationId?: string },
  params: Record<string, unknown>
): unknown {
  if (!services) return { ok: false, error: 'disabled' };
  return proposeRoutine({ ...services, emit: emitBotEvent }, conversationId, binding, params);
}

/** 成员会话最近的截图（browser / computer），send_image 从这里取 */
export const botScreenshots = new ScreenshotCache();

/** worker 的 send_image：chatId 取自会话权威绑定；工作区根取会话所属项目（SSH 不支持文件） */
export function sendImageTool(
  services: BotServices | null | undefined,
  conversationId: string,
  binding: { botId: string; chatId: string | null; delegationId?: string },
  params: Record<string, unknown>
): unknown {
  if (!services) return { ok: false, error: 'disabled' };
  const authority = getSourceAuthorityRegistry();
  const conversation = authority?.conversation(conversationId);
  const project = conversation ? authority?.project(conversation.projectId) : undefined;
  return sendImage(
    {
      chat: (id) => services.chats.get(id),
      mediaDir: (id) => services.chats.mediaDir(id),
      workspaceRoot: () => (project && project.kind !== 'ssh' ? project.canonicalPath : null),
      screenshots: botScreenshots,
      compress: compressImage,
    },
    conversationId,
    binding,
    params
  );
}

export function registerBotHandlers(): void {
  syncBotModeServices();
  setBotAvatarResolver((botId) =>
    botModeEnabled() ? (getBotServices()?.bots.avatarPath(botId) ?? null) : null
  );
  handle(
    IPC_CHANNELS.BOT_DELEGATIONS_LIST,
    'read',
    (_sender, request, { delegations }) => {
      const input = objectInput(request ?? {});
      if (!input || (input.chatId !== undefined && !isBotId(input.chatId))) return INVALID;
      return {
        ok: true,
        delegations: delegations.list(typeof input.chatId === 'string' ? input.chatId : undefined),
        enabled: true,
      };
    },
    { ok: true, delegations: [], enabled: false }
  );
  handle(IPC_CHANNELS.BOT_DELEGATION_CANCEL, 'write', (_sender, request, { delegations }) => {
    const input = objectInput(request);
    return input && isBotId(input.id) ? delegations.cancel(input.id) : INVALID;
  });
  handle(IPC_CHANNELS.BOT_DELEGATION_RETRY, 'write', (_sender, request, { delegations }) => {
    const input = objectInput(request);
    const mode = input?.mode;
    return input &&
      isBotId(input.id) &&
      (mode === undefined || mode === 'resume' || mode === 'restart')
      ? delegations.retry(input.id, mode)
      : INVALID;
  });
  handle(
    IPC_CHANNELS.BOT_ROUTINES_LIST,
    'read',
    (_sender, request, { routines }) => {
      const input = objectInput(request ?? {});
      if (!input || (input.botId !== undefined && !isBotId(input.botId))) return INVALID;
      return {
        ok: true,
        routines: typeof input.botId === 'string' ? routines.list(input.botId) : routines.listAll(),
        enabled: true,
      };
    },
    { ok: true, routines: [], enabled: false }
  );
  handle(
    IPC_CHANNELS.BOT_ROUTINE_SAVE,
    'write',
    (_sender, request, { routines, chats, bots, scheduler }) => {
      const input = objectInput(request);
      if (
        !input ||
        !isBotId(input.botId) ||
        !isBotId(input.chatId) ||
        typeof input.title !== 'string' ||
        typeof input.prompt !== 'string' ||
        typeof input.schedule !== 'string' ||
        (input.id !== undefined && !isBotId(input.id)) ||
        (input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
        (input.catchUp !== undefined && typeof input.catchUp !== 'boolean') ||
        (input.doneBy !== undefined && input.doneBy !== null && !isBotId(input.doneBy))
      )
        return INVALID;
      const previous =
        typeof input.id === 'string'
          ? routines.list(input.botId).find((item) => item.id === input.id)
          : undefined;
      // 缺省沿用原执行者；null 改回归属成员自己
      const doneBy = input.doneBy === undefined ? previous?.doneBy : (input.doneBy ?? undefined);
      const owner = bots.get(input.botId);
      const executor = doneBy ? bots.get(doneBy) : owner;
      if (!owner || !executor || !chats.get(input.chatId)?.members.includes(executor.id))
        return INVALID;
      if (executor.id !== owner.id && delegationPolicy(owner, executor, 1, 0))
        return { ok: false, error: 'acl' };
      const result = routines.save(input.botId, {
        title: input.title,
        prompt: input.prompt,
        schedule: input.schedule,
        chatId: input.chatId,
        doneBy: doneBy ?? null,
        ...(typeof input.id === 'string' ? { id: input.id } : {}),
        ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        ...(typeof input.catchUp === 'boolean' ? { catchUp: input.catchUp } : {}),
      });
      if (!result.ok) return { ok: false, error: result.reason };
      const routine = scheduler.verify(input.botId, result.routine.id) ?? result.routine;
      scheduler.refresh();
      emitBotEvent({ kind: 'routine' });
      return { ok: true, routine };
    }
  );
  handle(
    IPC_CHANNELS.BOT_ROUTINE_DELETE,
    'write',
    (_sender, request, { routines, routineRuns, scheduler }) => {
      const input = objectInput(request);
      if (
        !input ||
        !isBotId(input.botId) ||
        !isBotId(input.id) ||
        !routines.remove(input.botId, input.id)
      )
        return INVALID;
      routineRuns.forget(input.botId, input.id);
      scheduler.refresh();
      emitBotEvent({ kind: 'routine' });
      return { ok: true };
    }
  );
  handle(IPC_CHANNELS.BOT_ROUTINE_RUN_NOW, 'write', (_sender, request, { scheduler }) => {
    const input = objectInput(request);
    if (
      !input ||
      !isBotId(input.botId) ||
      !isBotId(input.id) ||
      (input.dryRun !== undefined && typeof input.dryRun !== 'boolean')
    )
      return INVALID;
    const started = scheduler.trigger(input.botId, input.id, input.dryRun ? 'dry-run' : 'manual');
    if (!started.ok)
      return {
        ok: false,
        error: started.error,
        ...(started.reason ? { reason: started.reason } : {}),
      };
    void started.done.catch((error) => console.warn('[bots] routine failed', error));
    return { ok: true };
  });
  handle(IPC_CHANNELS.BOT_ROUTINE_REVIEW, 'write', (_sender, request, { routines, scheduler }) => {
    const input = objectInput(request);
    if (!input || !isBotId(input.botId) || !isBotId(input.id) || typeof input.approve !== 'boolean')
      return INVALID;
    const result = routines.review(input.botId, input.id, input.approve);
    if (!result.ok) return { ok: false, error: result.reason };
    const routine = 'routine' in result ? scheduler.verify(input.botId, input.id) : undefined;
    scheduler.refresh();
    emitBotEvent({ kind: 'routine' });
    return routine ? { ok: true, routine } : { ok: true };
  });
  handle(
    IPC_CHANNELS.BOT_ROUTINE_RUNS,
    'read',
    (_sender, request, { routineRuns }) => {
      const input = objectInput(request);
      if (!input || !isBotId(input.botId) || !isBotId(input.id)) return INVALID;
      return { ok: true, runs: routineRuns.list(input.botId, input.id, 20) };
    },
    { ok: true, runs: [] }
  );
  handle(
    IPC_CHANNELS.BOT_TASKS_LIST,
    'read',
    (_sender, request, { chats, tasks }) => {
      const chatId = chatIdOf(request);
      if (!chatId || chats.get(chatId)?.kind !== 'group') return INVALID;
      return { ok: true, tasks: tasks.list(chatId), enabled: true };
    },
    { ok: true, tasks: [], enabled: false }
  );
  handle(IPC_CHANNELS.BOT_TASK_SAVE, 'write', (_sender, request, { chats, tasks }) => {
    const input = objectInput(request);
    if (
      !input ||
      !isBotId(input.chatId) ||
      chats.get(input.chatId)?.kind !== 'group' ||
      typeof input.title !== 'string' ||
      input.title.length > GROUP_TASK_TITLE_MAX ||
      !optionalText(input.detail, GROUP_TASK_TEXT_MAX) ||
      !optionalText(input.check, TASK_CHECK_TEXT_MAX) ||
      (input.id !== undefined && !isBotId(input.id))
    )
      return INVALID;
    const detail = typeof input.detail === 'string' ? input.detail : undefined;
    const text = typeof input.check === 'string' ? input.check.trim() : undefined;
    const check = text ? { kind: 'output-contains' as const, text } : undefined;
    return typeof input.id === 'string'
      ? tasks.update(input.chatId, 'human', input.id, {
          title: input.title,
          ...(detail !== undefined ? { detail } : {}),
          ...(text !== undefined ? { check: check ?? null } : {}),
        })
      : tasks.add(input.chatId, 'human', {
          title: input.title,
          ...(detail ? { detail } : {}),
          ...(check ? { check } : {}),
        });
  });
  handle(IPC_CHANNELS.BOT_TASK_ASSIGN, 'write', (_sender, request, services) => {
    const target = taskTarget(services, request);
    if (!target || !isBotId(target.input.botId)) return INVALID;
    return services.tasks.assign(target.chatId, target.id, target.input.botId);
  });
  handle(IPC_CHANNELS.BOT_TASK_COMPLETE, 'write', (_sender, request, services) => {
    const target = taskTarget(services, request);
    if (!target || !optionalText(target.input.result, GROUP_TASK_TEXT_MAX)) return INVALID;
    const result = typeof target.input.result === 'string' ? target.input.result : undefined;
    return services.tasks.complete(target.chatId, 'human', target.id, result);
  });
  handle(IPC_CHANNELS.BOT_TASK_CANCEL, 'write', (_sender, request, services) => {
    const target = taskTarget(services, request);
    return target ? services.tasks.cancel(target.chatId, 'human', target.id) : INVALID;
  });
  handle(IPC_CHANNELS.BOT_TASK_DELETE, 'write', (_sender, request, services) => {
    const target = taskTarget(services, request);
    return target ? services.tasks.remove(target.chatId, target.id) : INVALID;
  });
  handle(IPC_CHANNELS.BOT_TASK_REVIEW, 'write', (_sender, request, services) => {
    const target = taskTarget(services, request);
    if (!target || typeof target.input.accept !== 'boolean') return INVALID;
    const rework = target.input.rework;
    if (rework !== undefined && (typeof rework !== 'boolean' || target.input.accept))
      return INVALID;
    if (target.input.accept) return services.tasks.accept(target.chatId, 'human', target.id);
    const reason = target.input.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > GROUP_TASK_TEXT_MAX)
      return INVALID;
    return services.tasks.reject(target.chatId, 'human', target.id, reason, rework === true);
  });
  handle(IPC_CHANNELS.BOT_TASK_REPLY, 'write', (_sender, request, services) => {
    const target = taskTarget(services, request);
    const text = target?.input.text;
    if (!target || typeof text !== 'string' || !text.trim() || text.length > GROUP_TASK_TEXT_MAX)
      return INVALID;
    return services.tasks.reply(target.chatId, target.id, text);
  });
  handle(
    IPC_CHANNELS.BOTS_LIST,
    'read',
    (_sender, _request, { bots }): BotsListResult => ({
      ok: true,
      bots: bots.list(),
      enabled: true,
    }),
    { ok: true, bots: [], enabled: false } satisfies BotsListResult
  );

  handle(IPC_CHANNELS.BOT_GET, 'read', (_sender, request, { bots }): BotGetResult => {
    const botId = botIdOf(request);
    const bot = botId ? bots.get(botId) : undefined;
    return bot ? { ok: true, bot, persona: bots.readPersona(bot.id) } : INVALID;
  });

  handle(IPC_CHANNELS.BOT_CREATE, 'write', (_sender, request, { bots }): BotWriteIpcResult => {
    const draft = parseBotDraftInput(request);
    if (!draft || draft.name === undefined) return INVALID;
    const result = bots.create(draft, reservedNames());
    if (!result.ok) return { ok: false, error: result.reason };
    emitBotEvent({ kind: 'catalog' });
    return result;
  });

  handle(
    IPC_CHANNELS.BOT_SUGGEST_ABILITIES,
    'write',
    (_sender, request, { bots }): Promise<BotAbilitySuggestResult> | BotAbilitySuggestResult => {
      const parsed = parseAbilitySuggestRequest(request);
      if (!parsed) return INVALID;
      const state = readSettingsState();
      return suggestAbilities(
        {
          ...parsed,
          skills: catalogItems(state?.skills),
          mcpServers: catalogItems(state?.mcpServers),
          members: bots
            .list()
            .filter((bot) => bot.id !== parsed.botId && !bot.archivedAt)
            .map((bot) => ({ id: bot.id, name: bot.name, title: bot.title, scope: bot.scope })),
        },
        assistantCompleter(2048)
      );
    }
  );

  handle(
    IPC_CHANNELS.BOT_SUGGEST_PERSONA,
    'write',
    (_sender, request): Promise<BotPersonaSuggestResult> | BotPersonaSuggestResult => {
      const parsed = parsePersonaSuggestRequest(request);
      if (!parsed) return INVALID;
      return suggestPersona(parsed, assistantCompleter(4096));
    }
  );

  handle(
    IPC_CHANNELS.BOT_SUGGEST_GOAL,
    'write',
    (_sender, request): Promise<BotGoalSuggestResult> | BotGoalSuggestResult => {
      const parsed = parseGoalSuggestRequest(request);
      if (!parsed) return INVALID;
      return suggestGoal(parsed, assistantCompleter(4096));
    }
  );

  handle(IPC_CHANNELS.BOT_NOTES_GET, 'read', (_sender, request, services): BotNotesResult => {
    const target = parseNotesTargetInput(request);
    if (!target || !notesOwnerExists(services, target)) return INVALID;
    return {
      ok: true,
      notes: { ...services.notes.store.read(target), maxChars: BOT_NOTES_MAX_CHARS },
    };
  });

  handle(IPC_CHANNELS.BOT_NOTES_SAVE, 'write', (_sender, request, services): BotNotesResult => {
    const input = parseNotesSaveInput(request);
    if (!input || !notesOwnerExists(services, input.target)) return INVALID;
    const saved = services.notes.store.write(input.target, input.content, input.version);
    if (!saved.ok) return { ok: false, error: saved.error };
    emitBotEvent(notesEvent(input.target));
    return { ok: true, notes: { ...saved.notes, maxChars: BOT_NOTES_MAX_CHARS } };
  });

  handle(
    IPC_CHANNELS.BOT_TEAM_PREVIEW,
    'read',
    (_sender, request, { bots }): BotTeamPreviewResult => {
      const parsed = parseTeamPreviewInput(request);
      if (!parsed.ok) return parsed;
      return { ok: true, ...assignTeamNames(parsed.team, bots.list(), reservedNames()) };
    }
  );

  handle(
    IPC_CHANNELS.BOT_TEAM_CREATE,
    'write',
    (_sender, request, services): BotTeamCreateResult => {
      const input = parseTeamCreateInput(request);
      if (!input) return INVALID;
      const result = createTeam(services, input.team, {
        reserved: reservedNames(),
        ...(input.assets ? { assets: input.assets } : {}),
        resolveWorkspace: (chatId) => resolveWorkspaceInput(services, chatId, input.workspace),
        releaseWorkspace: (chatId, workspace) => {
          if (workspace.kind !== 'chat-home') return;
          getSourceAuthorityRegistry()?.removeBotHomeProject(workspace.projectId);
          rmSync(path.dirname(services.chats.workspaceDir(chatId)), {
            recursive: true,
            force: true,
          });
        },
      });
      if (!result.ok) return result;
      emitBotEvent({ kind: 'catalog' });
      emitBotEvent({ kind: 'chat', chatId: result.chat.id });
      return result;
    }
  );

  handle(
    IPC_CHANNELS.BOT_UPDATE,
    'write',
    async (_sender, request, { bots, host }): Promise<BotWriteIpcResult> => {
      const parsed = parseBotUpdateInput(request);
      if (!parsed) return INVALID;
      const result = bots.update(
        parsed.botId,
        parsed.draft,
        reservedNames(),
        parsed.expectedVersion
      );
      if (!result.ok) return { ok: false, error: result.reason };
      emitBotEvent({ kind: 'catalog' });
      await host.refreshModel(result.bot.id);
      return result;
    }
  );

  handle(IPC_CHANNELS.BOT_ARCHIVE, 'write', (_sender, request, { bots }): BotWriteIpcResult => {
    const botId = botIdOf(request);
    const archived = (request as { archived?: unknown } | null)?.archived;
    if (!botId || typeof archived !== 'boolean') return INVALID;
    const result = bots.setArchived(botId, archived);
    if (!result.ok) return { ok: false, error: result.reason };
    emitBotEvent({ kind: 'catalog' });
    return result;
  });

  handle(IPC_CHANNELS.BOT_SET_AVATAR, 'write', (_sender, request, { bots }): BotWriteIpcResult => {
    const botId = botIdOf(request);
    const image = (request as { image?: unknown } | null)?.image;
    if (!botId || !(image === null || (image instanceof Uint8Array && checkAvatarImage(image))))
      return INVALID;
    const result = bots.setAvatar(botId, image);
    if (!result.ok) return { ok: false, error: result.reason };
    emitBotEvent({ kind: 'catalog' });
    return result;
  });

  handle(
    IPC_CHANNELS.BOT_DELETE,
    'write',
    async (_sender, request, { host, chats, groups }): Promise<BotActionResult> => {
      const botId = botIdOf(request);
      if (!botId) return INVALID;
      if (!chats.list().some((chat) => chat.bossBotId === botId)) {
        for (const chat of chats.list()) {
          const state = chat.kind === 'group' ? groups.state(chat.id) : undefined;
          if (state?.ok && state.current === botId) {
            const stopped = await groups.stop(chat.id);
            if (!stopped.ok) return stopped;
          }
        }
      }
      const result = host.discardBot(botId);
      if (result.ok) await removeBotMemorySpace(app.getPath('userData'), `bot:${botId}`);
      return result.ok
        ? result
        : {
            ok: false,
            error: result.reason,
            reason: result.reason,
            ...(result.chatIds ? { chatIds: result.chatIds } : {}),
          };
    }
  );

  handle(
    IPC_CHANNELS.BOT_CHATS_LIST,
    'read',
    (_sender, _request, { chats, host }): BotChatsListResult => ({
      ok: true,
      chats: chats.list(),
      queue: host.queueState(),
      silences: host.silences(),
      enabled: true,
    }),
    { ok: true, chats: [], queue: [], enabled: false } satisfies BotChatsListResult
  );

  handle(
    IPC_CHANNELS.BOT_CHAT_CREATE,
    'write',
    (_sender, request, services): BotChatWriteResult => {
      const input = parseChatCreateInput(request);
      if (!input || !activeMembers(services, input.members)) return INVALID;
      if (input.kind === 'direct') {
        const existing = services.chats
          .list()
          .find((chat) => chat.kind === 'direct' && chat.members[0] === input.members[0]);
        if (existing) return { ok: true, chat: existing };
      }
      const chatId = randomUUID();
      const workspace = resolveWorkspaceInput(services, chatId, input.workspace);
      if ('error' in workspace) return { ok: false, error: workspace.error };
      const chat = services.chats.create({ ...input, workspace }, chatId);
      if (!chat) {
        discardNewChatHome(services, chatId, workspace);
        return INVALID;
      }
      emitBotEvent({ kind: 'chat', chatId });
      return { ok: true, chat };
    }
  );

  handle(
    IPC_CHANNELS.BOT_CHAT_UPDATE,
    'write',
    async (_sender, request, services): Promise<BotChatWriteResult> => {
      const input = parseChatUpdateInput(request);
      const current = input ? services.chats.get(input.chatId) : undefined;
      // 话题的群配置随根群级联，不能单独改
      if (!input || !current || current.parentId) return INVALID;
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        return { ok: false, error: 'conflict' };
      }
      const added = (input.members ?? []).filter((id) => !current.members.includes(id));
      if (!activeMembers(services, added)) return INVALID;
      let workspace: BotChatWorkspace | undefined;
      if (input.workspace) {
        const resolved = resolveWorkspaceInput(services, current.id, input.workspace);
        if ('error' in resolved) return { ok: false, error: resolved.error };
        workspace = resolved;
      }
      const workspaceChanged =
        workspace !== undefined && JSON.stringify(workspace) !== JSON.stringify(current.workspace);
      const threads = current.kind === 'group' ? services.chats.threadsOf(current.id) : [current];
      for (const thread of threads) {
        const routing = thread.kind === 'group' ? services.groups.state(thread.id) : undefined;
        if (
          routing?.ok &&
          (workspaceChanged ||
            input.archived === true ||
            (routing.current && input.members && !input.members.includes(routing.current)))
        ) {
          const stopped = await services.groups.stop(thread.id);
          if (!stopped.ok) return stopped;
        }
      }
      const before = threads.map((thread) => thread.sessions);
      const at = Date.now();
      const chat = services.chats.update(current.id, (draft) => {
        if (input.title !== undefined) draft.title = input.title;
        if (input.archived === true) draft.archivedAt = at;
        if (input.archived === false) delete draft.archivedAt;
        if (input.members) draft.members = input.members;
        if (input.bossBotId !== undefined) draft.bossBotId = input.bossBotId;
        if (input.routing) draft.routing = { ...draft.routing, ...input.routing };
        if (workspace) draft.workspace = workspace;
        if (workspaceChanged) draft.sessions = {};
        return applyChatFlags(draft, input, at);
      });
      if (!chat) return INVALID;
      if (workspaceChanged)
        for (const thread of threads.slice(1))
          services.chats.update(thread.id, (draft) => ({ ...draft, sessions: {} }));
      for (const sessions of before)
        for (const [botId, session] of Object.entries(sessions)) {
          if (workspaceChanged || !chat.members.includes(botId)) {
            services.host.retireSession(session.conversationId);
          }
        }
      for (const botId of current.members)
        if (!chat.members.includes(botId)) services.tasks.releaseMember(chat.id, botId);
      for (const thread of threads) emitBotEvent({ kind: 'chat', chatId: thread.id });
      return { ok: true, chat };
    }
  );

  handle(
    IPC_CHANNELS.BOT_CHAT_DELETE,
    'write',
    async (_sender, request, { host, chats, groups, tasks }): Promise<BotActionResult> => {
      const chatId = chatIdOf(request);
      const chat = chatId ? chats.get(chatId) : undefined;
      if (!chatId || !chat || chat.parentId) return INVALID;
      // 根群连同全部话题一起删：先全部停下，再逐个清理，最后删根群
      const threads = chat.kind === 'group' ? chats.threadsOf(chatId) : [chat];
      for (const thread of threads) {
        if (thread.kind !== 'group') continue;
        const stopped = await groups.stop(thread.id);
        if (!stopped.ok) return stopped;
      }
      for (const thread of threads.slice(1)) host.discardChat(thread.id);
      if (!host.discardChat(chatId)) return INVALID;
      for (const thread of threads)
        removePastedTextFiles(sessionDir(), botChatPasteOwner(thread.id));
      tasks.forget(chatId);
      await botDesktop().closeBrowser(botBrowserKey(chatId));
      await removeBotMemorySpace(app.getPath('userData'), `chat:${chatId}`);
      return { ok: true };
    }
  );

  handle(IPC_CHANNELS.BOT_CHAT_NEW_SESSION, 'write', (_sender, request, services) =>
    newBotSession(services, request)
  );
  handle(IPC_CHANNELS.BOT_CHAT_SWITCH_SESSION, 'write', (_sender, request, services) =>
    switchBotSession(services, request)
  );

  handle(IPC_CHANNELS.BOT_THREAD_CREATE, 'write', (_sender, request, services) =>
    createBotThread(services, request)
  );
  handle(IPC_CHANNELS.BOT_THREAD_SELECT, 'write', (_sender, request, services) =>
    selectBotThread(services, request)
  );

  handle(
    IPC_CHANNELS.BOT_THREAD_UPDATE,
    'write',
    (_sender, request, { chats }): BotChatWriteResult => {
      const input = parseThreadUpdateInput(request);
      const current = input ? chats.get(input.chatId) : undefined;
      if (!input || current?.kind !== 'group') return INVALID;
      // 手动改名即锁定：删掉 autoTitle，之后（含进行中的）自动命名都不再写回
      const chat = chats.update(current.id, (draft) => {
        delete draft.autoTitle;
        return { ...draft, threadTitle: input.title };
      });
      if (!chat) return INVALID;
      emitBotEvent({ kind: 'chat', chatId: chat.id });
      return { ok: true, chat };
    }
  );

  handle(
    IPC_CHANNELS.BOT_THREAD_DELETE,
    'write',
    async (_sender, request, { chats, groups, host }): Promise<BotActionResult> => {
      const chatId = parseThreadChatInput(request);
      const thread = chatId ? chats.get(chatId) : undefined;
      const root = thread?.parentId ? chats.get(thread.parentId) : undefined;
      if (!thread || !root) return INVALID;
      const stopped = await groups.stop(thread.id);
      if (!stopped.ok) return stopped;
      if (!host.discardChat(thread.id)) return INVALID;
      removePastedTextFiles(sessionDir(), botChatPasteOwner(thread.id));
      if (root.activeThreadId === thread.id)
        chats.update(root.id, (draft) => {
          delete draft.activeThreadId;
          return draft;
        });
      emitBotEvent({ kind: 'chat', chatId: root.id });
      return { ok: true };
    }
  );

  handle(IPC_CHANNELS.BOT_CHAT_CLONE, 'write', (_sender, request, services): BotChatWriteResult => {
    const input = parseChatCloneInput(request);
    // 在话题里克隆等同克隆整个群（不带话题）
    const source = input ? services.chats.rootOf(input.chatId) : undefined;
    if (!input || source?.kind !== 'group') return INVALID;
    const members = source.members.filter((id) => activeMembers(services, [id]));
    const chatId = randomUUID();
    // 群专属目录不能共用（删原群会连目录一起删），克隆群新建空目录；绑项目的沿用同一项目
    const workspace = resolveWorkspaceInput(
      services,
      chatId,
      source.workspace.kind === 'project'
        ? { kind: 'project', projectId: source.workspace.projectId }
        : { kind: source.workspace.kind }
    );
    if ('error' in workspace) return { ok: false, error: workspace.error };
    const chat = services.chats.create(
      {
        kind: 'group',
        title: input.title,
        members,
        bossBotId: source.bossBotId && members.includes(source.bossBotId) ? source.bossBotId : null,
        workspace,
        routing: source.routing,
      },
      chatId
    );
    if (!chat) {
      discardNewChatHome(services, chatId, workspace);
      return INVALID;
    }
    emitBotEvent({ kind: 'chat', chatId });
    return { ok: true, chat };
  });

  handle(
    IPC_CHANNELS.BOT_CHAT_SESSIONS,
    'read',
    async (_sender, request, { chats, host }): Promise<BotChatSessionsResult> => {
      const chatId = chatIdOf(request);
      if (!chatId || !chats.get(chatId)) return INVALID;
      const authority = getSourceAuthorityRegistry();
      const sessions = await Promise.all(
        host.sessionsOf(chatId).map(async (session) => {
          const file = authority?.conversation(session.conversationId)?.sessionFile;
          const summary = await readBotSessionSummary(sessionDir(), file);
          return {
            ...session,
            ...(summary?.title ? { title: summary.title } : {}),
            ...(summary ? { activityAt: summary.activityAt } : {}),
          };
        })
      );
      return { ok: true, sessions };
    }
  );

  handle(IPC_CHANNELS.BOT_CHAT_STOP, 'write', (_sender, request, { groups }) => {
    const chatId = chatIdOf(request);
    return chatId ? groups.stop(chatId) : INVALID;
  });
  handle(IPC_CHANNELS.BOT_CHAT_INTERJECT_QUEUED, 'write', (_sender, request, { host }) => {
    const chatId = chatIdOf(request);
    const deliveryId =
      request && typeof request === 'object' && 'deliveryId' in request
        ? request.deliveryId
        : undefined;
    if (!chatId || !isDeliveryId(deliveryId)) return INVALID;
    // Only the writable desktop Main renderer reaches this handler; no worker / phone route.
    return host.interjectQueued(chatId, deliveryId, { kind: 'human', readOnly: false });
  });
  handle(IPC_CHANNELS.BOT_CHAT_STATE, 'read', (_sender, request, { groups }) => {
    const chatId = chatIdOf(request);
    return chatId ? groups.state(chatId) : INVALID;
  });

  handle(
    IPC_CHANNELS.BOT_CHAT_TIMELINE,
    'read',
    (_sender, request, services): BotTimelineResult => readBotTimeline(services, request)
  );

  handle(IPC_CHANNELS.BOT_SEND, 'write', (_sender, request, services) =>
    sendBotMessage(services, request)
  );

  handle(IPC_CHANNELS.BOT_OPEN_WORKSPACE, 'write', async (_sender, request, services) => {
    const input = parseOpenWorkspaceInput(request);
    if (!input) return INVALID;
    const dir =
      'botId' in input
        ? services.bots.get(input.botId) && services.bots.homeDir(input.botId)
        : services.host.workspacePath(input.chatId);
    if (!dir) return UNAVAILABLE;
    try {
      mkdirSync(dir, { recursive: true });
      const failure = await shell.openPath(dir);
      return failure ? { ok: false, error: failure } : { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'unavailable' };
    }
  });

  handle(IPC_CHANNELS.BOT_SESSION_HISTORY, 'read', async (_sender, request) => {
    const input = parseSessionHistoryInput(request);
    const conversation = input
      ? getSourceAuthorityRegistry()?.conversation(input.conversationId)
      : undefined;
    if (!input || !conversation?.bot) {
      return { ok: false, code: 'not-found', error: 'Not a bot conversation.' };
    }
    return readSessionHistoryFile(conversation.sessionFile, input.beforeIndex);
  });

  handle(IPC_CHANNELS.BOT_SEARCH, 'read', (_sender, request, services) =>
    searchChats(services, request)
  );
  handle(IPC_CHANNELS.BOT_FILE_SEARCH, 'read', (_sender, request, services) =>
    searchChatFiles(services, request)
  );
  handle(IPC_CHANNELS.BOT_CHAT_SAVE_PASTED_TEXT, 'write', (_sender, request, { chats }) => {
    const input = objectInput(request);
    if (!input || !isBotId(input.chatId) || typeof input.text !== 'string')
      return { ok: false, error: 'invalid-request' };
    if (!chats.get(input.chatId)) return { ok: false, error: 'chat-not-found' };
    return savePastedTextFile(sessionDir(), botChatPasteOwner(input.chatId), input.text);
  });
  handle(IPC_CHANNELS.BOT_REWIND, 'write', (_sender, request, services) =>
    rewindBotChat(services, request)
  );
  handle(IPC_CHANNELS.BOT_RETRY, 'write', (_sender, request, services) =>
    retryBotChat(services, request)
  );
  handle(IPC_CHANNELS.BOT_ARTIFACTS_LIST, 'read', (_sender, request, services) =>
    listArtifacts(services, request)
  );
  handle(IPC_CHANNELS.BOT_ARTIFACT_READ, 'read', (_sender, request, services) =>
    readArtifact(services, request)
  );
  handle(IPC_CHANNELS.BOT_ARTIFACT_OPEN, 'write', (_sender, request, services) =>
    openArtifact(services, request)
  );
  handle(
    IPC_CHANNELS.BOT_USAGE_SUMMARY,
    'read',
    async (_sender, days, services) =>
      isUsageRangeDays(days) ? { ok: true, rows: await services.usage.summary(days) } : INVALID,
    { ok: true, rows: [] }
  );
  handle(
    IPC_CHANNELS.BOT_USAGE,
    'read',
    async (_sender, _request, services) => ({ ok: true, ...(await services.usage.overview()) }),
    { ok: true, day: '', bots: {} }
  );
  handle(
    IPC_CHANNELS.BOT_INBOX_LIST,
    'read',
    (_sender, _request, { inbox }): BotInboxListResult => ({ ok: true, items: inbox.list() }),
    { ok: true, items: [] } satisfies BotInboxListResult
  );
  handle(IPC_CHANNELS.BOT_INBOX_UPDATE, 'write', (_sender, request, { inbox }) => {
    const input = parseInboxUpdateInput(request);
    if (!input) return INVALID;
    return input.action === 'dismiss' ? inbox.dismiss(input.key) : inbox.reopen(input.key);
  });
}

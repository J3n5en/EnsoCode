import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { browserSessionKey } from '@shared/bots/browser';
import type { ChildSessionIdentity, SessionIdentity } from '@shared/builtinAgents';
import { resolveSshTarget } from '@shared/ssh';
import {
  IPC_CHANNELS,
  projectDisabledBuiltinTools,
  resolveDisabledBuiltinTools,
} from '@shared/types';
import type {
  AgentActionResult,
  AgentControlContext,
  AgentControlToolResponse,
  AgentRemoteConfig,
  AgentSpawnRequest,
  AgentWorkerEvent,
  ApprovalDecision,
  ApprovalMode,
  ChildHistoryResult,
  ConversationReloadResult,
  McpStatusPush,
  ParentHistoryTailResult,
  RendererAgentEvent,
  SpawnModelConfig,
  ThinkingLevel,
} from '@shared/types/agent';
import {
  APPROVAL_MODES,
  isDeliveryId,
  parseAgentCommand,
  parseConversationAuthorityRequest,
  parseCreateConversationAuthorityRequest,
  parseTitleSummaryInput,
  parseUpdateConversationSelectionRequest,
  THINKING_LEVELS,
} from '@shared/types/agent';
import { parseTaskCheck } from '@shared/types/bot';
import { effectiveSubagentAllowedModes } from '@shared/types/builtinTools';
import {
  parseAgentDispatchRequest,
  parseParentModelSelectionRequest,
  parseParentSourceBindingRequest,
} from '@shared/types/mentions';
import { app, ipcMain, powerMonitor, type WebContents, webContents } from 'electron';
import { EnsoSafeJournal } from '../../agent/ensoSafeJournal';
import { titleSummaryTimeoutMs } from '../../agent/titleSummary';
import { ActiveConversationRegistry } from '../services/activeConversationRegistry';
import { AgentDispatchService } from '../services/agentDispatchService';
import {
  abortRetrySession,
  abortSession,
  agentTypeRegistrySnapshot,
  appendSessionCustomEntry,
  backgroundForegroundTool,
  compactSession,
  completeText,
  dismissChildSession,
  dismissCoworkerSession,
  forgetParentToolProfile,
  forkSession,
  isAgentWorkerReady,
  promptChildSession,
  promptSession,
  readSettingsState,
  releaseParentSession,
  reloadSession,
  requestSnapshot,
  resolveAgentTypeSpawnConfig,
  resolveModelSelection,
  resolveSubagentModelSelection,
  respondApproval,
  respondAsk,
  resumeCoworkerSession,
  retrySession,
  rewindSession,
  sendAgentCommand,
  sendBrowserResultToSession,
  sendComputerResultToSession,
  sendDelegationResultToSession,
  sendMemoryResultToSession,
  setAgentEventListener,
  setPinnedSessions,
  setSessionApprovalMode,
  setSessionModel,
  setSessionReasoning,
  setSessionThinking,
  spawnChildSession,
  spawnSession,
  steerSession,
  stopBackgroundTask,
  stopSubagent,
  stopWorkflow,
  summarizeConversationTitle,
} from '../services/agentHost';
import { validateAgentRun } from '../services/agentRunValidation';
import { AgentService } from '../services/agentService';
import { HumanRequestTimeouts } from '../services/bots/humanRequestTimeouts';
import { pickBrowserFileRoot, setBrowserFileRootResolver } from '../services/browserFileRoot';
import { browserHost } from '../services/browserHost';
import type { BrowserActor } from '../services/browserTabClaims';
import { chatModelsRoot } from '../services/chatModels';
import { computerHost } from '../services/computerHost';
import { reloadConversation } from '../services/conversationReload';
import { searchFiles } from '../services/fileSearch';
import { createLocalComplete, memoryCompleteFromSettings } from '../services/llama/chat';
import {
  localChatModelPathIfReady,
  REMOTE_CHAT_MODEL_ID,
  resolveChatModelSpec,
  voiceCorrectionModelIdFromSettings,
} from '../services/llama/chatModels';
import { toStoredTokens } from '../services/mcpOAuth';
import { getMcpOAuthStore } from '../services/mcpOAuthStore';
import { clearMcpStatuses, recordMcpStatus } from '../services/mcpStatusCache';
import type { Complete } from '../services/memory/distill';
import { memorySpaceContext } from '../services/memory/space';
import {
  configureMemoryDistill,
  invokeMemory,
  rootSessionId,
  scheduleMemoryDistill,
} from '../services/memoryHost';
import { maybeNotify, maybeNotifyBot, setViewedSession } from '../services/notifications';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import { forwardAgentEvent, setPairAgentBridge } from '../services/pairHost';
import {
  configurePairSessionHost,
  handlePairHeadlessAgentEvent,
} from '../services/pairSessionHost';
import { remoteCandidates } from '../services/remoteModels';
import { removeConversationSessionFiles } from '../services/sessionFileCleanup';
import {
  projectParentHistoryPage,
  projectParentHistoryTail,
  resolveParentHistoryFile,
} from '../services/sessionHistoryTail';
import {
  importExternalSession,
  listExternalSessions,
  readExternalSession,
} from '../services/sessionImport';
import { SourceAuthorityRegistry } from '../services/sourceAuthorityRegistry';
import { setSpeechCorrector } from '../services/speech/service';
import { buildCorrectionRequest } from '../services/speech/text';
import { getSshConnectionStore } from '../services/sshConnectionStore';
import { titleModelCandidates } from '../services/titleSummary';
import { ingestSessionJsonl } from '../services/usage/ledgerStore';
import { sendToAllWindows } from '../windows/createAppWindow';
import { isMainWebContents } from '../windows/MainWindow';
import {
  botModeEnabled,
  botScreenshots,
  getBotServices,
  groupHistoryTool,
  groupTasksTool,
  routineProposeTool,
  sendImageTool,
} from './bots';
import { agentSessionIndex, capabilityGateway, handleCapabilityInvoke } from './capabilities';
import { readSettings, readSshTimeoutSeconds } from './settings';
import {
  removeRegisteredWorktree,
  sessionWorktree,
  sessionWorktreeBusy,
  shareSessionWorktree,
} from './worktree';

const pendingWorktreeForks = new Map<
  string,
  { identity: SessionIdentity; worktree: ReturnType<typeof sessionWorktree> }
>();
function discardForkWorktree(conversationId: string): void {
  const pending = pendingWorktreeForks.get(conversationId);
  pendingWorktreeForks.delete(conversationId);
  if (!pending?.worktree) return;
  void removeRegisteredWorktree(conversationId, pending.worktree).catch((error) => {
    console.warn('[worktree] failed to remove fork binding', error);
  });
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isValidImages = (value: unknown): value is { data: string; mimeType: string }[] | undefined =>
  value === undefined ||
  (Array.isArray(value) &&
    value.every(
      (image) =>
        image &&
        typeof image === 'object' &&
        typeof (image as Record<string, unknown>).data === 'string' &&
        typeof (image as Record<string, unknown>).mimeType === 'string'
    ));

const isValidMessageInput = (sessionId: unknown, text: unknown, images: unknown): boolean =>
  isNonEmptyString(sessionId) &&
  typeof text === 'string' &&
  isValidImages(images) &&
  (text.length > 0 || (Array.isArray(images) && images.length > 0));

let dispatchService: AgentDispatchService | null = null;
let agentService: AgentService | null = null;
const pendingAgentControl = new Map<string, AbortController>();
const pendingComputer = new Map<string, AbortController>();
let sourceBindings: ActiveConversationRegistry | null = null;
let sourceAuthority: SourceAuthorityRegistry | null = null;
let botWorkerObserver: ((event: AgentWorkerEvent | { type: 'worker-exited' }) => void) | null =
  null;
const selectionClockOwners = new WeakSet<WebContents>();

function watchSelectionClock(sender: WebContents): void {
  if (selectionClockOwners.has(sender)) return;
  selectionClockOwners.add(sender);
  sender.once('destroyed', () => {
    sourceBindings?.invalidateOwner(sender.id);
    sourceBindings?.forgetRendererSelectionClock(sender.id);
  });
}

export function getAgentDispatchService(): AgentDispatchService | null {
  return dispatchService;
}

export function getAgentService(): AgentService | null {
  return agentService;
}

export function getSourceAuthorityRegistry(): SourceAuthorityRegistry | null {
  return sourceAuthority;
}

/** Bot 会话宿主订阅 worker 事件（turn 结果、运行态） */
export function setBotWorkerEventObserver(
  observer: ((event: AgentWorkerEvent | { type: 'worker-exited' }) => void) | null
): void {
  botWorkerObserver = observer;
}

function broadcastAgentEvent(event: RendererAgentEvent): void {
  try {
    sendToAllWindows(IPC_CHANNELS.AGENT_EVENT, event);
  } catch {
    // renderer 已崩但 webContents 对象还在：Render frame was disposed
  }
  const conversationId =
    'identity' in event && event.identity ? rootSessionId(event.identity) : undefined;
  const binding = conversationId ? sourceAuthority?.conversation(conversationId)?.bot : undefined;
  if (
    binding &&
    conversationId &&
    (event.type === 'approval-request' || event.type === 'ask-request')
  ) {
    const enabled = botModeEnabled();
    void maybeNotifyBot(event, {
      enabled,
      chatId: binding.chatId,
      conversationId,
      name: (enabled ? getBotServices()?.bots.get(binding.botId)?.name : undefined) ?? '成员',
    }).catch((error) => console.warn('[bots] notification failed', error));
    // bot 会话的回合完成 / 失败由 Bot 服务按聊天发带成员名的通知（群接力整批合并）
  } else if (!binding) maybeNotify(event);
  // 手机第二屏：按订阅过滤后加密下发（host 在 main，不依赖窗口焦点）
  forwardAgentEvent(event);
  handlePairHeadlessAgentEvent(event);
}

export function pushMcpStatus(push: McpStatusPush): void {
  try {
    sendToAllWindows(IPC_CHANNELS.MCP_STATUS_EVENT, push);
  } catch {
    // renderer 已崩但 webContents 对象还在
  }
}

function exactIdentity(sessionId: unknown): SessionIdentity | ChildSessionIdentity | undefined {
  return isNonEmptyString(sessionId) ? agentSessionIndex.currentIdentity(sessionId) : undefined;
}

function rootIdentity(sessionId: unknown): SessionIdentity | undefined {
  const identity = exactIdentity(sessionId);
  return identity && !('parent' in identity) ? identity : undefined;
}

function persistedRootSpawn(request: AgentSpawnRequest, ownerWebContentsId: number): boolean {
  if (!isMainWebContents(ownerWebContentsId) || request.sessionId.includes('::cw-')) return false;
  const conversation = sourceAuthority?.conversation(request.sessionId);
  const project = conversation ? sourceAuthority?.project(conversation.projectId) : undefined;
  if (
    conversation?.kind !== 'root' ||
    conversation.lifecycle === 'ended' ||
    project?.state !== 'active'
  ) {
    return false;
  }
  // cwd 授权：项目主工作树，或该会话在 main 登记过的隔离 worktree（不信任其它路径）
  if (project.canonicalPath === request.cwd) return true;
  // ssh 项目无 worktree：cwd 只允许等于远端 canonicalPath
  if (project.kind === 'ssh') return false;
  return sessionWorktree(request.sessionId)?.path === request.cwd;
}

/** ssh 项目→远程执行配置。只认 main 侧项目权威,渲染层请求里不存在也不采信此字段 */
function remoteConfigFor(sessionId: string): AgentRemoteConfig | undefined {
  const conversation = sourceAuthority?.conversation(sessionId);
  const project = conversation ? sourceAuthority?.project(conversation.projectId) : undefined;
  if (project?.kind !== 'ssh') return undefined;
  const secret = project.sshConnectionId
    ? getSshConnectionStore().getSecret(project.sshConnectionId)
    : undefined;
  const timeoutSeconds = readSshTimeoutSeconds();
  if (secret) {
    return {
      host: resolveSshTarget(secret),
      auth: secret.auth,
      ...(secret.port ? { port: secret.port } : {}),
      ...(secret.auth === 'password' && secret.password ? { password: secret.password } : {}),
      timeoutSeconds,
    };
  }
  return project.sshHost ? { host: project.sshHost, auth: 'key', timeoutSeconds } : undefined;
}

function projectIdFor(sessionId: string): string | undefined {
  return sourceAuthority?.conversation(sessionId)?.projectId;
}

/** 旁路会话继承父会话工作区；路径由 Main 从权威记录推导，不采信 renderer。 */
export function resolveConversationWorkspace(conversationId: string): {
  cwd: string;
  projectId: string;
  remote?: AgentRemoteConfig;
} | null {
  const conversation = sourceAuthority?.conversation(conversationId);
  const project = conversation ? sourceAuthority?.project(conversation.projectId) : undefined;
  if (!conversation || conversation.lifecycle === 'ended' || project?.state !== 'active') {
    return null;
  }
  const cwd = sessionWorktree(conversationId)?.path ?? project.canonicalPath;
  if (!cwd) return null;
  const remote = remoteConfigFor(conversationId);
  return { cwd, projectId: conversation.projectId, ...(remote ? { remote } : {}) };
}

function spawnBoundSession(
  identity: SessionIdentity,
  request: AgentSpawnRequest,
  credentialKeys: ReadonlySet<string>
) {
  // bot 会话的人设 / 工作区只能由 Main 的 BotSessionHost 组装，通用 spawn 路径一律拒绝
  if (sourceAuthority?.conversation(request.sessionId)?.bot) {
    return { ok: false, error: 'bot conversation must be spawned by bot host' };
  }
  return spawnSession(
    identity,
    request,
    credentialKeys,
    remoteConfigFor(request.sessionId),
    projectIdFor(request.sessionId)
  );
}

function parseSpawnRequest(value: unknown): AgentSpawnRequest | null {
  const request = asRecord(value);
  if (!request) return null;
  const allowed = new Set([
    'sessionId',
    'providerId',
    'modelId',
    'cwd',
    'resumeFile',
    'reasoningEnabled',
    'thinkingLevel',
    'loadLocalSkills',
    'disabledTools',
    'presetId',
    'approvalMode',
    'planMode',
  ]);
  if (
    Object.keys(request).some((key) => !allowed.has(key)) ||
    !isNonEmptyString(request.sessionId) ||
    request.sessionId.startsWith('builtin-agent:') ||
    !isNonEmptyString(request.providerId) ||
    !isNonEmptyString(request.modelId) ||
    typeof request.cwd !== 'string' ||
    (request.resumeFile !== undefined && typeof request.resumeFile !== 'string') ||
    (request.reasoningEnabled !== undefined && typeof request.reasoningEnabled !== 'boolean') ||
    (request.thinkingLevel !== undefined &&
      !THINKING_LEVELS.includes(request.thinkingLevel as ThinkingLevel)) ||
    (request.loadLocalSkills !== undefined && typeof request.loadLocalSkills !== 'boolean') ||
    (request.disabledTools !== undefined &&
      (!Array.isArray(request.disabledTools) ||
        request.disabledTools.some((id) => typeof id !== 'string'))) ||
    (request.presetId !== undefined && typeof request.presetId !== 'string') ||
    (request.approvalMode !== undefined &&
      !APPROVAL_MODES.includes(request.approvalMode as ApprovalMode)) ||
    (request.planMode !== undefined && typeof request.planMode !== 'boolean')
  ) {
    return null;
  }
  return request as unknown as AgentSpawnRequest;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 已结束 child 的只读历史。只读不复活：不进 sessionIndex、不占容量、不注册能力授权。
 *
 * 路径的唯一来源是 Main 自己读的持久化会话记录，再叠两道校验：
 * 必须落在 sessions 目录内（防穿越）、basename 必须是 enso- 前缀的 safe journal
 * （不读 pi 的普通 session 文件，那里面没经过脱敏）。
 */
async function readChildHistory(conversationId: string): Promise<ChildHistoryResult> {
  const persisted = agentSessionIndex.persistedConversation(conversationId);
  const sessionFile = persisted?.sessionFile;
  if (!isNonEmptyString(sessionFile)) {
    return { ok: false, code: 'not-found', error: 'No persisted history for this conversation.' };
  }
  const sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions');
  const resolved = path.resolve(sessionFile);
  const withinSessionDir =
    resolved === path.resolve(sessionDir) ||
    resolved.startsWith(`${path.resolve(sessionDir)}${path.sep}`);
  if (!withinSessionDir || !path.basename(resolved).startsWith('enso-')) {
    return { ok: false, code: 'unavailable', error: 'History file is not a safe journal.' };
  }
  if (!existsSync(resolved)) {
    return { ok: false, code: 'not-found', error: 'History file is missing.' };
  }
  return { ok: true, projection: await EnsoSafeJournal.restore(resolved) };
}

/**
 * 记忆蒸馏的 LLM 入口。设置为本地 GGUF 时走 llama.cpp；否则复用标题总结的远程回退链。
 * worker 不在线 / 本地权重未就绪返 null，让任务保留 pending 到下次开库续跑。
 */
async function distillCompletion(): Promise<Complete | null> {
  const state = (
    readSettings()?.['enso-settings'] as { state?: Record<string, unknown> } | undefined
  )?.state;
  return memoryCompleteFromSettings(state, {
    modelsRoot: chatModelsRoot(),
    remoteComplete: () => remoteDistillCompletion(state),
  });
}

async function remoteDistillCompletion(
  state: Record<string, unknown> | undefined
): Promise<Complete | null> {
  if (!isAgentWorkerReady() || !state) return null;
  // 记忆提炼有自己的模型时排在最前；未设则完全走标题模型的既有回退链
  // （标题总结要快而便宜，提炼要质量，两者诉求不同）
  const candidates = await remoteCandidates(state, state.memoryDistillModel);
  if (candidates.length === 0) return null;
  return (systemPrompt, userText, options) =>
    completeText({
      systemPrompt,
      userText,
      candidates,
      timeoutMs: titleSummaryTimeoutMs(1),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    });
}

const VOICE_CORRECTION_TIMEOUT_MS = 15_000;

/** 语音纠错：本地 GGUF 走 llama.cpp；远程用单独选的模型，未选跟随标题模型。不可用返 null，保留原文 */
async function voiceCorrection(text: string): Promise<string | null> {
  const state = readSettingsState();
  if (!state) return null;
  const modelId = voiceCorrectionModelIdFromSettings(state);
  const request = buildCorrectionRequest(modelId, text);
  if (modelId === REMOTE_CHAT_MODEL_ID) {
    if (!isAgentWorkerReady()) return null;
    const candidates = await remoteCandidates(state, state.voiceCorrectionRemoteModel);
    if (candidates.length === 0) return null;
    return completeText({ ...request, candidates, timeoutMs: VOICE_CORRECTION_TIMEOUT_MS });
  }
  const gguf = localChatModelPathIfReady(chatModelsRoot(), modelId);
  if (!gguf) return null;
  const complete = createLocalComplete(gguf, {
    contextSize: resolveChatModelSpec(modelId)?.contextSize,
    timeoutMs: VOICE_CORRECTION_TIMEOUT_MS,
  });
  return complete(request.systemPrompt, request.userText, { maxTokens: request.maxTokens });
}

async function readParentHistoryTail(
  conversationId: string,
  beforeIndex?: number
): Promise<ParentHistoryTailResult> {
  const persisted = agentSessionIndex.persistedConversation(conversationId);
  const sessionFile =
    typeof persisted?.sessionFile === 'string' ? persisted.sessionFile : undefined;
  return readSessionHistoryFile(sessionFile, beforeIndex);
}

/** 根会话 pi jsonl 的尾窗 / 分页投影；路径须落在 sessions 目录内 */
export async function readSessionHistoryFile(
  sessionFile: string | undefined,
  beforeIndex?: number
): Promise<ParentHistoryTailResult> {
  const sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions');
  const resolved = resolveParentHistoryFile(sessionDir, sessionFile);
  if (!resolved) {
    return {
      ok: false,
      code: sessionFile ? 'unavailable' : 'not-found',
      error: 'No parent history file.',
    };
  }
  if (!existsSync(resolved)) {
    return { ok: false, code: 'not-found', error: 'History file is missing.' };
  }
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(resolved, sessionDir);
    const branch = manager.getBranch();
    return {
      ok: true,
      ...(beforeIndex === undefined
        ? projectParentHistoryTail(branch)
        : projectParentHistoryPage(branch, beforeIndex)),
    };
  } catch (error) {
    return {
      ok: false,
      code: 'unavailable',
      error: error instanceof Error ? error.message : 'Failed to read parent history.',
    };
  }
}

/**
 * 手机第二屏只持有裸 sessionId，而会话命令已收紧为 exact identity。身份解析与 spawn
 * 准入是策略，留在本文件（与渲染层走同一套 exactIdentity / persistedRootSpawn 守卫）；
 * pairHost 只做传输。解析不出身份就丢弃命令，不降级成按 sessionId 盲发。
 */
/**
 * 会话结束 / 闲置回收 / 压缩完成：从权威 jsonl 异步蒸馏长期记忆（开关、幂等、水位、失败全在
 * memoryHost / BotMemoryService 内收口）。返回 bot 绑定供调用方做后续处理。
 */
function distillSessionMemory(identity: SessionIdentity) {
  const conversation = sourceAuthority?.conversation(identity.sessionId);
  const sessionFile = agentSessionIndex.sessionFile(identity);
  if (sessionFile) {
    const project = conversation ? sourceAuthority?.project(conversation.projectId) : undefined;
    if (conversation?.bot) void getBotServices()?.memory.distill({ ...conversation, sessionFile });
    else
      void scheduleMemoryDistill(
        {
          sessionId: identity.sessionId,
          sessionFile,
          projectId: project?.state === 'active' ? project.projectId : null,
        },
        { continueFromLastJob: true }
      );
  }
  return conversation?.bot;
}

function botControlError(sessionId: unknown): { ok: false; error: string } | undefined {
  return typeof sessionId === 'string' && sourceAuthority?.conversation(sessionId)?.bot
    ? { ok: false, error: 'Bot sessions must use Bot services for execution and policy changes.' }
    : undefined;
}

/** 浏览器会话键：Bot 聊天（含委派子会话）共享一个，其余按会话隔离 */
function browserKeyFor(sessionId: string): string {
  return browserSessionKey(sessionId, sourceAuthority?.conversation(sessionId)?.bot, (id) =>
    getBotServices()?.delegations.chatIdOf(id)
  );
}

const sharesBrowser = (sessionId: string) => browserKeyFor(sessionId) !== sessionId;

/** 共享浏览器里按成员会话加标签锁；委派子会话按它自己的会话占用 */
function browserActorFor(sessionId: string): BrowserActor | undefined {
  if (!sharesBrowser(sessionId)) return undefined;
  const botId = sourceAuthority?.conversation(sessionId)?.bot?.botId;
  const name = botId ? getBotServices()?.bots.get(botId)?.name : undefined;
  return { sessionId, name: name ?? 'Another member' };
}

/** Bot 会话的截图留最近 3 张给 send_image（子会话截的图归到父会话）；非 Bot 会话不缓存 */
function cacheBotScreenshots(
  identity: SessionIdentity | ChildSessionIdentity,
  shots: readonly unknown[],
  source: 'web' | 'desktop'
): void {
  const sessionId = rootSessionId(identity);
  if (!sourceAuthority?.conversation(sessionId)?.bot) return;
  for (const shot of shots) {
    const data = shot && typeof shot === 'object' ? (shot as { data?: unknown }).data : undefined;
    if (typeof data === 'string' && data)
      botScreenshots.push(sessionId, { data: Buffer.from(data, 'base64'), source });
  }
}

function wirePairAgentBridge(): void {
  setPairAgentBridge({
    prompt: (sessionId, text, images) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (identity) promptSession(identity, text, images);
    },
    steer: (sessionId, text, images) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (identity) steerSession(identity, text, images);
    },
    abort: (sessionId) => {
      const identity = exactIdentity(sessionId);
      if (identity) abortSession(identity);
    },
    respondApproval: (sessionId, requestId, decision) => {
      const identity = exactIdentity(sessionId);
      if (identity) respondApproval(identity, requestId, decision);
    },
    respondAsk: (sessionId, requestId, answer) => {
      const identity = exactIdentity(sessionId);
      if (identity) respondAsk(identity, requestId, answer);
    },
    spawn: async (request) => {
      const identity = rootIdentity(request.sessionId) ?? {
        sessionId: request.sessionId,
        generation: randomUUID(),
      };
      agentSessionIndex.prepareParent(identity);
      let credentialKeys: ReadonlySet<string>;
      try {
        credentialKeys = await readStoredOauthCredentialKeys();
      } catch {
        return { ok: false, error: 'model credentials unavailable' };
      }
      return spawnBoundSession(identity, request, credentialKeys);
    },
  });
}

function wirePairSessionHost(): void {
  configurePairSessionHost({
    isAlive: (sessionId) => agentSessionIndex.isAlive(sessionId),
    requestSnapshot: (sessionId) => {
      requestSnapshot(sessionId);
    },
    spawn: async (request) => {
      const identity = rootIdentity(request.sessionId) ?? {
        sessionId: request.sessionId,
        generation: randomUUID(),
      };
      agentSessionIndex.prepareParent(identity);
      let credentialKeys: ReadonlySet<string>;
      try {
        credentialKeys = await readStoredOauthCredentialKeys();
      } catch {
        return { ok: false, error: 'model credentials unavailable' };
      }
      return spawnBoundSession(identity, request, credentialKeys);
    },
    prompt: (sessionId, text, images) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (identity) promptSession(identity, text, images);
    },
    steer: (sessionId, text, images) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (identity) steerSession(identity, text, images);
    },
    abort: (sessionId) => {
      const identity = exactIdentity(sessionId);
      if (identity) abortSession(identity);
    },
    setModel: (sessionId, providerId, modelId) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = rootIdentity(sessionId);
      if (!identity) return;
      void readStoredOauthCredentialKeys()
        .then((keys) => setSessionModel(identity, providerId, modelId, keys))
        .catch(() => {});
    },
    setReasoning: (sessionId, enabled, level) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (!identity) return;
      const thinking =
        typeof level === 'string' && (THINKING_LEVELS as readonly string[]).includes(level)
          ? (level as ThinkingLevel)
          : undefined;
      setSessionReasoning(identity, enabled, thinking);
    },
    setThinking: (sessionId, level) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (!identity || !(THINKING_LEVELS as readonly string[]).includes(level)) return;
      setSessionThinking(identity, level as ThinkingLevel);
    },
    compact: (sessionId, instructions) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (identity) compactSession(identity, instructions);
    },
    rewind: (sessionId, userIndexFromEnd, restoreFiles) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (identity) rewindSession(identity, userIndexFromEnd, restoreFiles);
    },
    retry: (sessionId) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (identity) retrySession(identity);
    },
    stopTask: (sessionId, taskId) => {
      const identity = exactIdentity(sessionId);
      if (identity) stopBackgroundTask(identity, taskId);
    },
    stopSubagent: (sessionId, agentId) => {
      const identity = exactIdentity(sessionId);
      if (identity) stopSubagent(identity, agentId);
    },
    createAuthority: (sessionId, projectId) => {
      const project = sourceAuthority?.project(projectId);
      if (!sourceAuthority || !project || project.state !== 'active') return;
      sourceAuthority.createConversation({
        requestId: randomUUID(),
        projectId,
        projectVersion: project.version,
        conversationId: sessionId,
      });
    },
    worktreePath: (sessionId) => sessionWorktree(sessionId)?.path,
    worktreeMissing: (sessionId) => {
      const worktree = sessionWorktree(sessionId);
      return Boolean(worktree && !existsSync(worktree.path));
    },
    projectPath: (projectId) => {
      const project = sourceAuthority?.project(projectId);
      return project?.state === 'active' ? project.canonicalPath : undefined;
    },
    loadLocalSkills: () => readSettingsState()?.loadLocalSkills === true,
  });
}

function agentControlContext(
  identity: SessionIdentity | ChildSessionIdentity
): AgentControlContext | undefined {
  const root = 'parent' in identity ? identity.parent : identity;
  const conversation = sourceAuthority?.conversation(root.sessionId);
  const project = conversation ? sourceAuthority?.project(conversation.projectId) : undefined;
  if (project?.state !== 'active') return undefined;
  return {
    owner: { ownerId: root.sessionId, projectId: project.projectId, kind: 'chatSession' },
    actor: {
      kind: 'agent',
      actorId: root.sessionId,
      ownerId: root.sessionId,
      projectId: project.projectId,
      identity: root,
    },
  };
}

async function runAgentControl(
  identity: SessionIdentity | ChildSessionIdentity,
  requestId: string,
  request: Extract<AgentWorkerEvent, { type: 'agent-control-invoke' }>['request'],
  signal: AbortSignal
): Promise<AgentControlToolResponse> {
  const context = agentControlContext(identity);
  if (!context || !agentService) {
    return { ok: false, code: 'runtime-unavailable', error: 'Agent control is unavailable.' };
  }
  const base = { context, requestId };
  switch (request.operation) {
    case 'spawn': {
      const spawned = await agentService.spawn({
        ...base,
        mode: request.mode,
        ...(request.name ? { name: request.name } : {}),
        description: request.description,
        prompt: request.prompt,
        ...(request.agentType ? { agentType: request.agentType } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.thinking ? { thinking: request.thinking } : {}),
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
        ...(request.gate ? { gate: request.gate } : {}),
      });
      if (!spawned.ok || !request.wait) return spawned;
      const waited = await agentService.wait(
        { context, requestId: `${requestId}:wait`, runIds: [spawned.value.runId], until: 'all' },
        signal
      );
      return waited.ok ? { ok: true, value: { ...spawned.value, report: waited.value } } : waited;
    }
    case 'send': {
      const sent = await agentService.send({
        ...base,
        agentId: request.agentId,
        message: request.message,
        delivery: request.delivery,
        ...(request.expectedRunId ? { expectedRunId: request.expectedRunId } : {}),
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
        ...(request.gate ? { gate: request.gate } : {}),
      });
      if (!sent.ok || !request.wait) return sent;
      const waited = await agentService.wait(
        { context, requestId: `${requestId}:wait`, runIds: [sent.value.runId], until: 'all' },
        signal
      );
      return waited.ok ? { ok: true, value: { ...sent.value, report: waited.value } } : waited;
    }
    case 'wait':
      return agentService.wait(
        {
          ...base,
          runIds: request.runIds,
          until: request.until,
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        },
        signal
      );
    case 'report':
      return agentService.report({ ...base, runId: request.runId });
    case 'list':
      return agentService.list({
        ...base,
        ...(request.status ? { status: request.status } : {}),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        limit: request.limit,
      });
    case 'message':
      return agentService.message({ ...base, to: request.to, text: request.text });
    case 'stop':
      return agentService.stop({ ...base, runId: request.runId });
    case 'dismiss':
      return agentService.dismiss({ ...base, agentId: request.agentId });
  }
}

export function registerAgentHandlers(): void {
  wirePairAgentBridge();
  wirePairSessionHost();
  configureMemoryDistill({ complete: distillCompletion });
  setSpeechCorrector(voiceCorrection);
  const agentDataDir = path.join(app.getPath('userData'), 'agent');
  sourceAuthority = new SourceAuthorityRegistry({
    registryFile: path.join(agentDataDir, 'source-registry.json'),
    safeSessionRoot: path.join(agentDataDir, 'sessions'),
    legacySettings: readSettings,
    resolveSshConnection: (id) => {
      const row = getSshConnectionStore().getSecret(id);
      return row ? { host: row.host, user: row.user, name: row.name } : null;
    },
    onChanged: (projection) => {
      sendToAllWindows(IPC_CHANNELS.SOURCE_AUTHORITY_CHANGED, projection);
    },
  });
  setBrowserFileRootResolver((conversationId) => {
    const conversation = sourceAuthority?.conversation(conversationId);
    const project = conversation ? sourceAuthority?.project(conversation.projectId) : undefined;
    const cwd = pickBrowserFileRoot({
      conversation,
      project,
      worktree: sessionWorktree(conversationId),
    });
    if (!cwd) return null;
    try {
      return statSync(cwd).isDirectory() ? cwd : null;
    } catch {
      return null;
    }
  });
  sourceBindings = new ActiveConversationRegistry({
    authority: sourceAuthority,
    sessionIndex: agentSessionIndex,
    isMainWebContents,
    resolveDefaultModel: () => {
      const state = asRecord(asRecord(readSettings()?.['enso-settings'])?.state);
      const selection = asRecord(state?.defaultModel);
      return selection &&
        typeof selection.providerId === 'string' &&
        typeof selection.modelId === 'string'
        ? { providerId: selection.providerId, modelId: selection.modelId }
        : null;
    },
  });
  dispatchService = new AgentDispatchService({
    sourceRegistry: sourceBindings,
    sessionIndex: agentSessionIndex,
    readStoredOauthCredentialKeys,
    emitRendererEvent: broadcastAgentEvent,
    emitDispatchEvent: (ownerWebContentsId, dispatchEvent) => {
      const owner = webContents.fromId(ownerWebContentsId);
      if (owner && !owner.isDestroyed()) {
        owner.send(IPC_CHANNELS.AGENT_DISPATCH_EVENT, dispatchEvent);
      }
    },
    host: {
      registrySnapshot: agentTypeRegistrySnapshot,
      // 派发继承父会话模型：父会话是虚拟模型时子会话同样按虚拟模型路由
      resolveModel: (providerId, modelId, credentialKeys) =>
        resolveModelSelection(providerId, modelId, credentialKeys, { allowVirtual: true }),
      resolveAgentType: (typeKey, parentModel, credentialKeys, parentConversationId) =>
        resolveAgentTypeSpawnConfig(
          typeKey,
          parentModel,
          credentialKeys,
          parentConversationId
            ? {
                parentSessionId: parentConversationId,
                projectId: projectIdFor(parentConversationId),
                remote: remoteConfigFor(parentConversationId) !== undefined,
              }
            : undefined
        ),
      resolveSubagentModel: resolveSubagentModelSelection,
      spawnParent: spawnBoundSession,
      spawnChild: spawnChildSession,
      promptChild: promptChildSession,
      appendCustomEntry: appendSessionCustomEntry,
      dismissChild: dismissChildSession,
      resumeCoworker: resumeCoworkerSession,
    },
    registerCapabilityInvocation: (context) => capabilityGateway.registerInvocation(context),
    terminateGeneration: (child) => capabilityGateway.terminateGeneration(child),
  });

  agentService = new AgentService({
    allowedModes: (context) => {
      const state = readSettingsState() ?? {};
      const projects = Array.isArray(state.projects) ? state.projects : [];
      const project = projects.find(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          (entry as { id?: unknown }).id === context.owner.projectId
      ) as { disabledBuiltinTools?: unknown; subagentAllowedModes?: unknown } | undefined;
      const disabled = resolveDisabledBuiltinTools(state.disabledBuiltinTools, {
        disabledBuiltinTools: project?.disabledBuiltinTools,
      });
      return new Set(
        effectiveSubagentAllowedModes(
          project?.subagentAllowedModes ?? state.subagentAllowedModes,
          disabled
        )
      );
    },
    runtime: {
      spawn: (input) =>
        dispatchService!.spawnControlledAgent({
          agentId: input.agentId,
          parentConversationId: input.context.owner.ownerId,
          name: input.name ?? input.description,
          mode: input.mode,
          ...(input.agentType ? { agentType: input.agentType } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinking ? { thinking: input.thinking } : {}),
        }),
      prompt: async (input) =>
        promptChildSession(input.identity, input.runId, {
          text: input.prompt,
          images: [],
          fileMentions: [],
        }),
      steer: async (input) => steerSession(input.identity, input.prompt),
      stop: async (input) => abortSession(input.identity),
      dismiss: async (input) => dismissChildSession(input.identity.parent, input.identity, false),
      validate: async (input) => {
        const source = sourceBindings?.resolveParentSource(input.context.owner.ownerId);
        if (!source) return { ok: false, error: 'Agent parent workspace is unavailable.' };
        return validateAgentRun({
          cwd: source.parentProjectPath,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.schema !== undefined ? { schema: input.schema } : {}),
          ...(input.gate ? { gate: input.gate } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      },
    },
  });

  const humanTimeouts = new HumanRequestTimeouts({
    now: Date.now,
    expire: (identity, kind, requestId) => {
      sendAgentCommand({ type: 'request-timeout', identity, kind, requestId });
    },
  });
  setInterval(() => humanTimeouts.check(), 1000).unref();
  powerMonitor.on('resume', () => humanTimeouts.check());

  setAgentEventListener((workerEvent) => {
    // MCP 旁路事件不属于任何会话：只转发到独立通道 / 落 token，不进 dispatch 与会话广播
    if (workerEvent.type === 'mcp-status') {
      recordMcpStatus(workerEvent);
      pushMcpStatus(workerEvent);
      return;
    }
    if (workerEvent.type === 'worker-exited') {
      for (const controller of pendingAgentControl.values()) controller.abort();
      pendingAgentControl.clear();
      for (const controller of pendingComputer.values()) controller.abort();
      pendingComputer.clear();
      computerHost.closeAll();
      for (const targetId of pendingWorktreeForks.keys()) discardForkWorktree(targetId);
      // worker 死后连接全部失效：清掉残留状态，避免设置页长期显示假 ready
      clearMcpStatuses();
      pushMcpStatus({ type: 'mcp-status-cleared' });
    }
    if (workerEvent.type === 'mcp-tokens-refreshed') {
      // worker 回传的 token 同样过一道白名单，不直接落盘
      getMcpOAuthStore().saveTokens(workerEvent.serverId, toStoredTokens(workerEvent.tokens));
      return;
    }
    // 手动重读结果按 requestId 在 agentHost 结算给 invoke 等待者；无主的迟到结果直接丢弃，
    // 绝不进普通事件流（renderer 的 snapshot 分支有 started / 审批副作用）
    if (
      workerEvent.type === 'session-reloaded' ||
      workerEvent.type === 'workspace-lock-result' ||
      workerEvent.type === 'oauth-pool-select' ||
      workerEvent.type === 'workspace-unlock-result'
    )
      return;
    dispatchService?.observe(workerEvent);
    agentService?.observe(workerEvent);
    botWorkerObserver?.(workerEvent);
    humanTimeouts.observe(workerEvent);
    if (workerEvent.type === 'turn-completed' || workerEvent.type === 'turn-failed') {
      const file = agentSessionIndex.sessionFile(workerEvent.identity);
      if (file) {
        void ingestSessionJsonl(
          path.join(app.getPath('userData'), 'agent', 'sessions'),
          file
        ).catch(() => {});
      }
    }
    if (workerEvent.type === 'parent-ready') {
      sourceAuthority?.markReady(
        workerEvent.identity.sessionId,
        workerEvent.sessionFile,
        workerEvent.model
      );
      sourceBindings?.invalidateBindingsForConversation(workerEvent.identity.sessionId);
    }
    if (workerEvent.type === 'fork-done') {
      const pending = pendingWorktreeForks.get(workerEvent.targetConversationId);
      if (
        !pending ||
        pending.identity.sessionId !== workerEvent.identity.sessionId ||
        pending.identity.generation !== workerEvent.identity.generation
      )
        return;
      const target = sourceAuthority?.conversation(workerEvent.targetConversationId);
      if (
        workerEvent.sessionFile &&
        !workerEvent.error &&
        target &&
        target.lifecycle !== 'ended' &&
        (!pending.worktree || sessionWorktree(workerEvent.targetConversationId))
      ) {
        pendingWorktreeForks.delete(workerEvent.targetConversationId);
        sourceAuthority?.markReady(
          workerEvent.targetConversationId,
          workerEvent.sessionFile,
          target.selection ?? { providerId: 'unknown', modelId: 'unknown' },
          workerEvent.entryId
            ? { conversationId: workerEvent.identity.sessionId, entryId: workerEvent.entryId }
            : target.forkedFrom
        );
      } else {
        discardForkWorktree(workerEvent.targetConversationId);
        if (workerEvent.sessionFile)
          removeConversationSessionFiles({
            sessionDir: path.join(app.getPath('userData'), 'agent', 'sessions'),
            conversationId: workerEvent.targetConversationId,
            sessionFile: workerEvent.sessionFile,
          });
        if (target) {
          sourceAuthority?.removeConversation({
            requestId: randomUUID(),
            conversationId: target.conversationId,
            version: target.version,
          });
        }
        broadcastAgentEvent({
          ...workerEvent,
          sessionFile: undefined,
          error: workerEvent.error ?? 'Fork target is unavailable.',
        });
        return;
      }
    }
    if (workerEvent.type === 'capability-invoke') {
      handleCapabilityInvoke(workerEvent);
      return;
    }
    // 回合结束：agent 开的无头 tab 关掉（用户正看的 / 锁住的不动）；parent-ended 强关
    // Bot 聊天的浏览器由成员共享，随聊天删除才关
    if (
      (workerEvent.type === 'turn-completed' || workerEvent.type === 'turn-failed') &&
      !sharesBrowser(workerEvent.identity.sessionId)
    ) {
      void browserHost.closeForSession(workerEvent.identity.sessionId);
    }
    if (workerEvent.type === 'turn-completed' || workerEvent.type === 'turn-failed') {
      browserHost.releaseActor(workerEvent.identity.sessionId);
    }
    if (workerEvent.type === 'parent-ended') {
      forgetParentToolProfile(workerEvent.identity.sessionId);
      browserHost.forgetActor(workerEvent.identity.sessionId);
      if (!sharesBrowser(workerEvent.identity.sessionId))
        void browserHost.closeForSession(workerEvent.identity.sessionId, { force: true });
      computerHost.close(workerEvent.identity.sessionId);
      distillSessionMemory(workerEvent.identity);
    }
    // 压缩成功：jsonl 原文仍在，按水位提前整理记忆；群聊成员下次投递补群状态
    if (
      workerEvent.type === 'compaction' &&
      workerEvent.state === 'end' &&
      !workerEvent.error &&
      !workerEvent.abandoned
    ) {
      const bot = distillSessionMemory(workerEvent.identity);
      if (bot?.chatId)
        getBotServices()?.groups.markCompacted(
          bot.chatId,
          bot.botId,
          workerEvent.identity.sessionId
        );
    }
    if (workerEvent.type === 'browser-invoke') {
      const { identity, requestId, op, params } = workerEvent;
      void browserHost
        .invoke(browserKeyFor(identity.sessionId), op, params, browserActorFor(identity.sessionId))
        .then(
          (result) => {
            if (op === 'screenshot') cacheBotScreenshots(identity, [result], 'web');
            sendBrowserResultToSession(identity, requestId, { ok: true, result });
          },
          (error: unknown) =>
            sendBrowserResultToSession(identity, requestId, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
        );
      return;
    }
    if (workerEvent.type === 'memory-invoke') {
      const { identity, requestId, op, params } = workerEvent;
      // 项目 space 只认 Main 权威：worker 不上报 projectId，也不上报路径
      const conversation = sourceAuthority?.conversation(rootSessionId(identity));
      const project = conversation ? sourceAuthority?.project(conversation.projectId) : undefined;
      const projectId = project?.state === 'active' ? project.projectId : null;
      const memory = conversation?.bot
        ? getBotServices()?.memory.context({ ...conversation, projectId })
        : { enabled: true, context: memorySpaceContext({ projectId }) };
      if (!memory?.enabled) {
        sendMemoryResultToSession(identity, requestId, { ok: false, error: '该成员已关闭记忆' });
        return;
      }
      const state = readSettingsState() ?? {};
      const disabled = resolveDisabledBuiltinTools(state.disabledBuiltinTools, {
        disabledBuiltinTools: projectDisabledBuiltinTools(state.projects, projectId ?? undefined),
      });
      if (disabled.includes('memory')) {
        sendMemoryResultToSession(identity, requestId, {
          ok: false,
          error: 'Memory tool is disabled',
        });
        return;
      }
      void invokeMemory(op, params, memory.context).then(
        (result) => sendMemoryResultToSession(identity, requestId, { ok: true, result }),
        (error: unknown) =>
          sendMemoryResultToSession(identity, requestId, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
      );
      return;
    }
    if (workerEvent.type === 'delegation-invoke') {
      const { identity, requestId, op, params } = workerEvent;
      try {
        const conversation = sourceAuthority?.conversation(identity.sessionId);
        const services =
          botModeEnabled() && conversation?.bot && agentSessionIndex.isCurrent(identity)
            ? getBotServices()
            : undefined;
        const service = services?.delegations;
        if (!service || !params || typeof params !== 'object' || Array.isArray(params)) {
          sendDelegationResultToSession(identity, requestId, {
            ok: false,
            error: botModeEnabled()
              ? 'Bot delegation unavailable or invalid arguments.'
              : 'disabled',
          });
          return;
        }
        const input = params as Record<string, unknown>;
        let result: unknown;
        if (op === 'group_tasks' && conversation?.bot) {
          result = groupTasksTool(services, identity.sessionId, conversation.bot, input);
        } else if (op === 'group_history' && conversation?.bot) {
          result = groupHistoryTool(services, identity.sessionId, conversation.bot, input);
        } else if (op === 'routine_propose' && conversation?.bot) {
          result = routineProposeTool(services, identity.sessionId, conversation.bot, input);
        } else if (op === 'send_image' && conversation?.bot) {
          result = sendImageTool(services, identity.sessionId, conversation.bot, input);
        } else if (
          op === 'delegate' &&
          typeof input.to === 'string' &&
          typeof input.task === 'string' &&
          (input.context === undefined || typeof input.context === 'string') &&
          (input.taskId === undefined || typeof input.taskId === 'string') &&
          (input.deadlineMinutes === undefined || typeof input.deadlineMinutes === 'number') &&
          (input.keep === undefined || typeof input.keep === 'boolean') &&
          (input.check === undefined || parseTaskCheck(input.check))
        ) {
          const check = parseTaskCheck(input.check);
          result = service.delegate(identity.sessionId, {
            to: input.to,
            task: input.task,
            ...(typeof input.context === 'string' ? { context: input.context } : {}),
            ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}),
            ...(typeof input.deadlineMinutes === 'number'
              ? { deadlineMinutes: input.deadlineMinutes }
              : {}),
            ...(input.keep === true ? { keep: true } : {}),
            ...(check ? { check } : {}),
          });
        } else if (
          op === 'check_delegation' &&
          (input.id === undefined || typeof input.id === 'string') &&
          (input.cancel === undefined || typeof input.cancel === 'boolean')
        ) {
          result = service.check(identity.sessionId, {
            ...(typeof input.id === 'string' ? { id: input.id } : {}),
            ...(typeof input.cancel === 'boolean' ? { cancel: input.cancel } : {}),
          });
        } else result = { ok: false, error: 'Invalid delegation arguments.' };
        void Promise.resolve(result).then(
          (value) =>
            sendDelegationResultToSession(identity, requestId, { ok: true, result: value }),
          (error: unknown) =>
            sendDelegationResultToSession(identity, requestId, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
        );
      } catch (error) {
        sendDelegationResultToSession(identity, requestId, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (workerEvent.type === 'computer-cancel') {
      pendingComputer.get(workerEvent.requestId)?.abort();
      return;
    }
    if (workerEvent.type === 'computer-invoke') {
      const { identity, requestId, op, params } = workerEvent;
      // worker 只给父会话挂 computer；Main 再兜一层，child / coworker 一律拒绝
      if ('parent' in identity) {
        sendComputerResultToSession(identity, requestId, {
          ok: false,
          error: 'Computer is only available to the parent session',
        });
        return;
      }
      const conversation = sourceAuthority?.conversation(rootSessionId(identity));
      const project = conversation ? sourceAuthority?.project(conversation.projectId) : undefined;
      const projectId = project?.state === 'active' ? project.projectId : null;
      const state = readSettingsState() ?? {};
      const disabled = resolveDisabledBuiltinTools(state.disabledBuiltinTools, {
        disabledBuiltinTools: projectDisabledBuiltinTools(state.projects, projectId ?? undefined),
      });
      if (disabled.includes('computer') || project?.kind === 'ssh') {
        sendComputerResultToSession(identity, requestId, {
          ok: false,
          error:
            project?.kind === 'ssh'
              ? 'Computer is not available in SSH projects'
              : 'Computer tool is disabled',
        });
        return;
      }
      const controller = new AbortController();
      pendingComputer.set(requestId, controller);
      void computerHost
        .invoke(identity.sessionId, op, params, controller.signal)
        .then(
          (result) => {
            cacheBotScreenshots(identity, result.screenshots, 'desktop');
            sendComputerResultToSession(identity, requestId, { ok: true, result });
          },
          (error: unknown) =>
            sendComputerResultToSession(identity, requestId, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
        )
        .finally(() => pendingComputer.delete(requestId));
      return;
    }
    if (workerEvent.type === 'agent-control-cancel') {
      pendingAgentControl.get(workerEvent.requestId)?.abort();
      return;
    }
    if (workerEvent.type === 'agent-control-invoke') {
      const controller = new AbortController();
      pendingAgentControl.set(workerEvent.requestId, controller);
      const { identity, requestId, request } = workerEvent;
      void runAgentControl(identity, requestId, request, controller.signal)
        .then((response) =>
          sendAgentCommand({ type: 'agent-control-result', identity, requestId, response })
        )
        .catch((error: unknown) =>
          sendAgentCommand({
            type: 'agent-control-result',
            identity,
            requestId,
            response: {
              ok: false,
              code: 'runtime-unavailable',
              error: error instanceof Error ? error.message : String(error),
            },
          })
        )
        .finally(() => pendingAgentControl.delete(requestId));
      return;
    }
    if (workerEvent.type === 'child-ready' && agentService) {
      const metadata = agentSessionIndex.childMetadata(workerEvent.identity);
      const context = agentControlContext(workerEvent.identity.parent);
      if (metadata?.dispatchOrigin === 'agent-tool' && metadata.mode === 'coworker' && context) {
        agentService.adoptCoworker(context, workerEvent.identity);
      }
    }
    if (workerEvent.type === 'child-ready') {
      const { proof: _proof, ...rendererEvent } = workerEvent;
      broadcastAgentEvent(rendererEvent);
      return;
    }
    broadcastAgentEvent(workerEvent);
  });

  ipcMain.handle(IPC_CHANNELS.SOURCE_AUTHORITY_READ, () => sourceAuthority!.rendererProjection());

  ipcMain.handle(IPC_CHANNELS.SOURCE_CONVERSATION_CREATE, (event, request: unknown) => {
    if (!isMainWebContents(event.sender.id))
      return { accepted: false, error: 'Only MainWindow can create conversations.' };
    const parsed = parseCreateConversationAuthorityRequest(request);
    return parsed
      ? sourceAuthority!.createConversation(parsed)
      : { accepted: false, error: 'Invalid conversation request.' };
  });
  ipcMain.handle(IPC_CHANNELS.SOURCE_CONVERSATION_SELECT, (event, request: unknown) => {
    const parsed = parseConversationAuthorityRequest(request);
    if (!parsed || !isMainWebContents(event.sender.id))
      return { accepted: false, error: 'Invalid conversation selection.' };
    const result = sourceAuthority!.selectConversation(parsed);
    if (!result.accepted) return result;
    watchSelectionClock(event.sender);
    const bound = sourceBindings!.selectConversation(
      event.sender.id,
      result.value.conversationId,
      parsed.selectionEpoch,
      parsed.selectionBootId
    );
    return bound ? result : { accepted: false, error: 'Stale conversation selection.' };
  });
  ipcMain.handle(IPC_CHANNELS.SOURCE_CONVERSATION_END, (event, request: unknown) => {
    const parsed = parseConversationAuthorityRequest(request);
    if (!parsed || !isMainWebContents(event.sender.id))
      return { accepted: false, error: 'Invalid conversation request.' };
    const result = sourceAuthority!.endConversation(parsed);
    if (result.accepted) sourceBindings!.invalidateConversation(parsed.conversationId);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.SOURCE_CONVERSATION_REMOVE, (event, request: unknown) => {
    const parsed = parseConversationAuthorityRequest(request);
    if (!parsed || !isMainWebContents(event.sender.id))
      return { accepted: false, error: 'Invalid conversation request.' };
    const result = sourceAuthority!.removeConversation(parsed);
    if (result.accepted) {
      sourceBindings!.invalidateConversation(parsed.conversationId);
      removeConversationSessionFiles({
        sessionDir: path.join(app.getPath('userData'), 'agent', 'sessions'),
        conversationId: parsed.conversationId,
        ...(result.value.sessionFile ? { sessionFile: result.value.sessionFile } : {}),
      });
    }
    return result;
  });
  ipcMain.handle(
    IPC_CHANNELS.SOURCE_CONVERSATION_UPDATE_SELECTION,
    async (event, request: unknown) => {
      const parsed = parseUpdateConversationSelectionRequest(request);
      if (!parsed || !isMainWebContents(event.sender.id))
        return { accepted: false, error: 'Invalid model selection request.' };
      try {
        const keys = await readStoredOauthCredentialKeys();
        if (
          !resolveModelSelection(parsed.selection.providerId, parsed.selection.modelId, keys, {
            allowVirtual: true,
          }).ok
        ) {
          return { accepted: false, error: 'Selected model is unavailable.' };
        }
      } catch {
        return { accepted: false, error: 'Model credentials are unavailable.' };
      }
      const result = sourceAuthority!.updateSelection(parsed);
      if (result.accepted) sourceBindings!.invalidateBindingsForConversation(parsed.conversationId);
      return result;
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_TYPES_REGISTRY_LIST, () => agentTypeRegistrySnapshot());

  // 已结束 child 的只读历史：渲染层只能给 conversationId，路径一律由 Main 从自己读的
  // 持久化会话里推导。接受渲染层传路径等于开放任意文件读取。
  ipcMain.handle(IPC_CHANNELS.AGENT_CHILD_HISTORY_READ, async (_event, request: unknown) => {
    const conversationId = asRecord(request)?.conversationId;
    if (!isNonEmptyString(conversationId)) {
      return { ok: false, code: 'not-found', error: 'conversationId is required' };
    }
    return await readChildHistory(conversationId);
  });

  // 手动重新读取会话：来源由 Main 按会话索引决定（worker 内存活着 → 带 seq 的快照，否则 safe journal）。
  // 只读：不 spawn / resume，不动生命周期；失败回原因，渲染层自己决定保留旧内容。
  ipcMain.handle(
    IPC_CHANNELS.AGENT_CONVERSATION_RELOAD,
    async (_event, request: unknown): Promise<ConversationReloadResult> => {
      const conversationId = asRecord(request)?.conversationId;
      if (!isNonEmptyString(conversationId)) {
        return { ok: false, error: 'conversationId is required' };
      }
      return await reloadConversation(conversationId, {
        isLive: (id) => {
          const identity = agentSessionIndex.currentIdentity(id);
          return Boolean(identity && agentSessionIndex.isReady(identity));
        },
        reloadLive: reloadSession,
        // 离线正文的位置由会话种类决定：child 的在 safe journal，根会话的在 pi jsonl。
        // 种类从 Main 自读的持久化元数据判断，不采信渲染层。
        isChild: (id) => {
          const persisted = agentSessionIndex.persistedConversation(id);
          return isNonEmptyString(persisted?.parentId) || asRecord(persisted?.child) !== null;
        },
        readHistory: readChildHistory,
        readParentTail: (id) => readParentHistoryTail(id),
      });
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_PARENT_HISTORY_TAIL, async (_event, request: unknown) => {
    const record = asRecord(request);
    const conversationId = record?.conversationId;
    if (!isNonEmptyString(conversationId)) {
      return { ok: false, code: 'not-found', error: 'conversationId is required' };
    }
    const rawBefore = record?.beforeIndex;
    const beforeIndex =
      typeof rawBefore === 'number' && Number.isFinite(rawBefore) ? rawBefore : undefined;
    return await readParentHistoryTail(conversationId, beforeIndex);
  });

  // 标题总结：渲染层只传 conversationId + 输入（首条即时 / 每轮滚动）；模型与凭证由 Main 从设置自读。
  // 回退链（独立标题模型 → 全局默认 → 会话模型）上全部可解析的候选一次性下发，worker 依次尝试。
  // 解析阶段失败同步返 error（渲染层当 title-failed 处理），不影响发消息。
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SUMMARIZE_TITLE,
    async (_event, request: unknown): Promise<AgentActionResult> => {
      const record = asRecord(request);
      const conversationId = record?.conversationId;
      const input = parseTitleSummaryInput(record?.input);
      if (!isNonEmptyString(conversationId) || !input) {
        return { ok: false, error: 'invalid title summary request' };
      }
      // 会话模型是回退链末级：只收 id，凭证照样由 Main 补全；形状坏则当作未传
      const sessionModelRecord = asRecord(record?.sessionModel);
      const sessionModel =
        isNonEmptyString(sessionModelRecord?.providerId) &&
        isNonEmptyString(sessionModelRecord?.modelId)
          ? {
              providerId: sessionModelRecord.providerId,
              modelId: sessionModelRecord.modelId,
            }
          : undefined;
      const state = (
        readSettings()?.['enso-settings'] as { state?: Record<string, unknown> } | undefined
      )?.state;
      // 开关以 Main 自读的设置为准，不采信渲染层的调用时机
      if (state?.titleSummaryEnabled !== true) {
        return { ok: false, error: 'title summary disabled' };
      }
      let credentialKeys: ReadonlySet<string>;
      try {
        credentialKeys = await readStoredOauthCredentialKeys();
      } catch {
        return { ok: false, error: 'model credentials unavailable' };
      }
      const candidates: SpawnModelConfig[] = [];
      for (const candidate of titleModelCandidates(state, sessionModel)) {
        const resolved = resolveModelSelection(
          candidate.providerId,
          candidate.modelId,
          credentialKeys
        );
        if (resolved.ok && resolved.selection) candidates.push(resolved.selection.config);
      }
      if (candidates.length === 0) return { ok: false, error: 'no usable title model' };
      return summarizeConversationTitle(conversationId, input, candidates);
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_DISPATCH_BIND_SOURCE, (event, request: unknown) => {
    const parsed = parseParentSourceBindingRequest(request);
    if (!parsed) return { accepted: false, requestId: '', error: 'invalid source binding request' };
    event.sender.once('destroyed', () => sourceBindings?.invalidateOwner(event.sender.id));
    return sourceBindings!.bindSource(event.sender.id, parsed);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_MODEL_SELECTION_REGISTER, async (event, request: unknown) => {
    const parsed = parseParentModelSelectionRequest(request);
    if (!parsed) return { accepted: false, error: 'Invalid model selection request.' };
    let validated = false;
    try {
      const keys = await readStoredOauthCredentialKeys();
      validated = resolveModelSelection(
        parsed.selection.providerId,
        parsed.selection.modelId,
        keys,
        { allowVirtual: true }
      ).ok;
    } catch {}
    return sourceBindings!.registerModelSelection(event.sender.id, parsed, validated);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_DISPATCH, async (event, request: unknown) => {
    const snapshot = agentTypeRegistrySnapshot();
    const parsed = parseAgentDispatchRequest(
      request,
      new Set(snapshot.candidates.map((candidate) => candidate.typeKey))
    );
    if (!parsed) {
      const requestId = asRecord(request)?.requestId;
      return {
        accepted: false,
        requestId: typeof requestId === 'string' ? requestId : '',
        code: 'invalid-request',
        message: 'Invalid Agent dispatch request.',
      };
    }
    return dispatchService!.dispatch(parsed, event.sender.id);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SPAWN, async (event, request: unknown) => {
    const parsedRaw = parseSpawnRequest(request);
    if (parsedRaw && sessionWorktreeBusy(parsedRaw.sessionId)) {
      return { ok: false, error: 'worktree operation in progress' };
    }
    // 隔离会话的 cwd 以 main 登记的 worktree 为准，无条件覆写：
    // 渲染层的自动 resume 可能携陈旧 cwd 抢先 spawn（Move to worktree 竞态，CDP 实测），
    // 在权威侧收口后整类问题消失。
    const registeredWorktree = parsedRaw ? sessionWorktree(parsedRaw.sessionId) : undefined;
    const parsed =
      parsedRaw && registeredWorktree ? { ...parsedRaw, cwd: registeredWorktree.path } : parsedRaw;
    if (!parsed || !persistedRootSpawn(parsed, event.sender.id)) {
      return { ok: false, error: 'invalid spawn request' };
    }
    const identity = exactIdentity(parsed.sessionId) ?? {
      sessionId: parsed.sessionId,
      generation: randomUUID(),
    };
    agentSessionIndex.prepareParent(identity);
    let credentialKeys: ReadonlySet<string>;
    try {
      credentialKeys = await readStoredOauthCredentialKeys();
    } catch {
      return { ok: false, error: 'model credentials unavailable' };
    }
    if (sessionWorktreeBusy(parsed.sessionId)) {
      return { ok: false, error: 'worktree operation in progress' };
    }
    const currentWorktree = sessionWorktree(parsed.sessionId);
    const currentRequest = currentWorktree ? { ...parsed, cwd: currentWorktree.path } : parsed;
    if (!persistedRootSpawn(currentRequest, event.sender.id)) {
      return { ok: false, error: 'conversation authority changed' };
    }
    return spawnBoundSession(identity, currentRequest, credentialKeys);
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_PROMPT,
    (
      _event,
      sessionId: unknown,
      text: unknown,
      images?: unknown,
      deliveryId?: unknown
    ): AgentActionResult => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (
        !identity ||
        !isValidMessageInput(sessionId, text, images) ||
        (deliveryId !== undefined && !isDeliveryId(deliveryId))
      ) {
        return { ok: false, error: 'invalid prompt or stale session generation' };
      }
      return promptSession(
        identity,
        text as string,
        images as { data: string; mimeType: string }[] | undefined,
        deliveryId
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_STEER,
    (
      _event,
      sessionId: unknown,
      text: unknown,
      images?: unknown,
      deliveryId?: unknown
    ): AgentActionResult => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (
        !identity ||
        !isValidMessageInput(sessionId, text, images) ||
        (deliveryId !== undefined && !isDeliveryId(deliveryId))
      ) {
        return { ok: false, error: 'invalid steer or stale session generation' };
      }
      return steerSession(
        identity,
        text as string,
        images as { data: string; mimeType: string }[] | undefined,
        deliveryId
      );
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_ABORT, (_event, sessionId: unknown): AgentActionResult => {
    const identity = exactIdentity(sessionId);
    return identity
      ? abortSession(identity)
      : { ok: false, error: 'invalid abort or stale session generation' };
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_ABORT_RETRY,
    (_event, sessionId: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      return identity
        ? abortRetrySession(identity)
        : { ok: false, error: 'invalid abort-retry or stale session generation' };
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_RETRY, (_event, sessionId: unknown): AgentActionResult => {
    const rejected = botControlError(sessionId);
    if (rejected) return rejected;
    const identity = exactIdentity(sessionId);
    return identity
      ? retrySession(identity)
      : { ok: false, error: 'invalid retry or stale session generation' };
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_RELEASE,
    async (event, sessionId: unknown): Promise<AgentActionResult> => {
      // 仅主窗口可释放；等 parent-ended 回流才返回（避免与后续 spawn 竞态）
      if (!isMainWebContents(event.sender.id)) return { ok: false, error: 'not authorized' };
      const identity = exactIdentity(sessionId);
      return identity
        ? await releaseParentSession(identity)
        : { ok: false, error: 'invalid release or stale session generation' };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SNAPSHOT,
    (_event, sessionId: unknown): AgentActionResult =>
      requestSnapshot(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined)
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_ASK_RESPOND,
    (_event, sessionId: unknown, requestId: unknown, answer: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      if (!identity || !isNonEmptyString(requestId) || !isNonEmptyString(answer)) {
        return { ok: false, error: 'invalid ask response or stale session generation' };
      }
      return respondAsk(identity, requestId, answer);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_HIRE_COWORKER,
    async (
      event,
      parentConversationId: unknown,
      name: unknown,
      agentType: unknown
    ): Promise<AgentActionResult> => {
      // 手动雇佣走 Main dispatch（与 Enso team.hire 同款守卫：reservation/容量/
      // name 去重/exact 握手）；渲染层只交 conversationId + 名字 + 类型。
      if (
        !isMainWebContents(event.sender.id) ||
        !isNonEmptyString(parentConversationId) ||
        !isNonEmptyString(name) ||
        (agentType !== undefined && !isNonEmptyString(agentType))
      ) {
        return { ok: false, error: 'invalid hire request' };
      }
      const service = getAgentDispatchService();
      if (!service) return { ok: false, error: 'Agent dispatcher is unavailable.' };
      const result = await service.hireCoworker(parentConversationId, name, agentType);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_DISMISS_COWORKER,
    (_event, parentSessionId: unknown, coworkerId: unknown, notify: unknown): AgentActionResult => {
      const parent = exactIdentity(parentSessionId);
      if (!parent || 'parent' in parent || !isNonEmptyString(coworkerId)) {
        return { ok: false, error: 'invalid dismiss or stale generation' };
      }
      // 降级链：typed child（sessions 索引）→ 工具直雇 coworker（parent.coworkers 映射）
      // → 都查不到则 not-found，渲染层据此本地移除重启后无实体的死 tab。
      const child = exactIdentity(coworkerId);
      if (child && 'parent' in child) {
        return dismissChildSession(parent, child, notify === true);
      }
      if (agentSessionIndex.coworkerOf(parent, coworkerId)) {
        return dismissCoworkerSession(parent, coworkerId, notify === true);
      }
      return { ok: false, error: 'coworker not found' };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SET_MODEL,
    async (_event, sessionId: unknown, providerId: unknown, modelId: unknown) => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (!identity || 'parent' in identity) {
        return { ok: false, error: 'invalid session or stale generation' };
      }
      if (!isNonEmptyString(providerId) || !isNonEmptyString(modelId)) {
        return { ok: false, error: 'providerId and modelId are required' };
      }
      let credentialKeys: ReadonlySet<string>;
      try {
        credentialKeys = await readStoredOauthCredentialKeys();
      } catch {
        return { ok: false, error: 'model credentials unavailable' };
      }
      return setSessionModel(identity, providerId, modelId, credentialKeys);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SET_THINKING,
    (_event, sessionId: unknown, level: unknown): AgentActionResult => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (!identity || !THINKING_LEVELS.includes(level as ThinkingLevel)) {
        return { ok: false, error: 'invalid thinking level or stale generation' };
      }
      return setSessionThinking(identity, level as ThinkingLevel);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SET_REASONING,
    (_event, sessionId: unknown, enabled: unknown, level?: unknown): AgentActionResult => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (!identity || typeof enabled !== 'boolean') {
        return { ok: false, error: 'invalid reasoning input or stale generation' };
      }
      if (level !== undefined && !THINKING_LEVELS.includes(level as ThinkingLevel)) {
        return { ok: false, error: 'invalid thinking level' };
      }
      return setSessionReasoning(identity, enabled, level as ThinkingLevel | undefined);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_APPROVAL_RESPOND,
    (_event, sessionId: unknown, requestId: unknown, decision: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      if (
        !identity ||
        !isNonEmptyString(requestId) ||
        (decision !== 'allow' && decision !== 'allowSession' && decision !== 'deny')
      ) {
        return { ok: false, error: 'invalid approval response or stale generation' };
      }
      return respondApproval(identity, requestId, decision as ApprovalDecision);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SET_APPROVAL_MODE,
    async (_event, sessionId: unknown, mode: unknown): Promise<AgentActionResult> => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (!identity || !APPROVAL_MODES.includes(mode as ApprovalMode)) {
        return { ok: false, error: 'invalid approval mode or stale generation' };
      }
      return setSessionApprovalMode(
        identity,
        mode as ApprovalMode,
        await readStoredOauthCredentialKeys()
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SET_PLAN_MODE,
    (_event, sessionId: unknown, active: unknown): AgentActionResult => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      const command = identity && parseAgentCommand({ type: 'set-plan-mode', identity, active });
      if (!command) return { ok: false, error: 'invalid plan mode or stale generation' };
      return sendAgentCommand(command);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_PLAN_RESPOND,
    (_event, sessionId: unknown, response: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      const record =
        response && typeof response === 'object' ? (response as Record<string, unknown>) : null;
      const command =
        identity &&
        record &&
        parseAgentCommand({
          type: 'plan-respond',
          identity,
          planId: record.planId,
          action: record.action,
          ...(record.feedback !== undefined ? { feedback: record.feedback } : {}),
        });
      if (
        !command ||
        Object.keys(record ?? {}).some((key) => !['planId', 'action', 'feedback'].includes(key))
      )
        return { ok: false, error: 'invalid plan response or stale generation' };
      return sendAgentCommand(command);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_COMPACT,
    (_event, sessionId: unknown, instructions: unknown): AgentActionResult => {
      // 压缩不改执行与策略（忙碌时 worker 排队），桌面端对 bot 会话放行；手机 pair 仍拒绝
      const identity = exactIdentity(sessionId);
      if (
        !identity ||
        (instructions !== undefined &&
          (typeof instructions !== 'string' || instructions.trim().length === 0))
      ) {
        return { ok: false, error: 'invalid compact request or stale generation' };
      }
      return compactSession(identity, instructions as string | undefined);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_REWIND,
    (_event, sessionId: unknown, entryId: unknown, restoreFiles: unknown): AgentActionResult => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      if (
        !identity ||
        typeof entryId !== 'string' ||
        !entryId.trim() ||
        (restoreFiles !== undefined && typeof restoreFiles !== 'boolean')
      ) {
        return { ok: false, error: 'invalid rewind or stale generation' };
      }
      return rewindSession(identity, entryId, restoreFiles);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_FORK,
    (
      event,
      sessionId: unknown,
      targetConversationId: unknown,
      anchor: unknown
    ): AgentActionResult => {
      const rejected = botControlError(sessionId);
      if (rejected) return rejected;
      const identity = exactIdentity(sessionId);
      const record = asRecord(anchor);
      const entryId = typeof record?.entryId === 'string' ? record.entryId : undefined;
      const userIndexFromEnd =
        typeof record?.userIndexFromEnd === 'number' ? record.userIndexFromEnd : undefined;
      if (
        !isMainWebContents(event.sender.id) ||
        !identity ||
        'parent' in identity ||
        typeof targetConversationId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(targetConversationId) ||
        (entryId
          ? userIndexFromEnd !== undefined
          : userIndexFromEnd === undefined || userIndexFromEnd < 0)
      ) {
        return { ok: false, error: 'invalid fork or stale generation' };
      }
      const source = sourceAuthority?.conversation(identity.sessionId);
      const target = sourceAuthority?.conversation(targetConversationId);
      if (
        !source ||
        source.lifecycle === 'ended' ||
        !target ||
        target.kind !== 'root' ||
        target.lifecycle !== 'draft' ||
        target.sessionFile ||
        target.projectId !== source.projectId ||
        target.forkedFrom?.conversationId !== identity.sessionId ||
        pendingWorktreeForks.has(targetConversationId)
      ) {
        return { ok: false, error: 'invalid fork target authority' };
      }
      try {
        shareSessionWorktree(identity.sessionId, targetConversationId);
        pendingWorktreeForks.set(targetConversationId, {
          identity,
          worktree: sessionWorktree(targetConversationId),
        });
        const result = forkSession(
          identity,
          targetConversationId,
          entryId ? { entryId } : { userIndexFromEnd: userIndexFromEnd as number }
        );
        if (!result.ok) discardForkWorktree(targetConversationId);
        return result;
      } catch (error) {
        if (pendingWorktreeForks.has(targetConversationId))
          discardForkWorktree(targetConversationId);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  // 系统通知抑制依据：renderer 上报当前正在查看的会话（null = 没在看任何会话）
  ipcMain.on(IPC_CHANNELS.NOTIFICATION_ACTIVE_SESSION, (event, sessionId: unknown) => {
    if (!isMainWebContents(event.sender.id)) return;
    setViewedSession(isNonEmptyString(sessionId) ? sessionId : null);
    // 正在查看的会话不参与 worker 侧闲置回收，否则 release 后 ChatView 会立刻 resume 形成拉锯
    setPinnedSessions('viewed', isNonEmptyString(sessionId) ? [sessionId] : []);
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_TASK_STOP,
    (_event, sessionId: unknown, taskId: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      if (!identity || !isNonEmptyString(taskId)) {
        return { ok: false, error: 'invalid task stop or stale generation' };
      }
      return stopBackgroundTask(identity, taskId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_TOOL_BACKGROUND,
    (_event, sessionId: unknown, toolCallId: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      if (!identity || !isNonEmptyString(toolCallId) || toolCallId.length > 512) {
        return { ok: false, error: 'invalid tool background request or stale generation' };
      }
      return backgroundForegroundTool(identity, toolCallId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_WORKFLOW_STOP,
    (_event, sessionId: unknown, runId: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      if (!identity || !isNonEmptyString(runId) || runId.length > 80) {
        return { ok: false, error: 'invalid workflow stop or stale generation' };
      }
      return stopWorkflow(identity, runId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SUBAGENT_STOP,
    (_event, sessionId: unknown, agentId: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      if (!identity || !isNonEmptyString(agentId)) {
        return { ok: false, error: 'invalid subagent stop or stale generation' };
      }
      return stopSubagent(identity, agentId);
    }
  );

  ipcMain.handle(IPC_CHANNELS.FILES_SEARCH, (_event, root: unknown, query: unknown) => {
    if (!isNonEmptyString(root) || typeof query !== 'string') return [];
    return searchFiles(root, query);
  });

  ipcMain.handle(IPC_CHANNELS.FILES_READ, (_event, filePath: unknown): string | null => {
    if (!isNonEmptyString(filePath)) return null;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile() || stat.size > 2_000_000) return null;
      return readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSIONS_SCAN_EXTERNAL, (_event, projectPath: unknown) => {
    if (!isNonEmptyString(projectPath)) return [];
    return listExternalSessions(projectPath);
  });

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_READ_EXTERNAL,
    (_event, sourceId: unknown, sessionPath: unknown) => {
      if (!isNonEmptyString(sourceId) || !isNonEmptyString(sessionPath)) return [];
      return readExternalSession(sourceId, sessionPath);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_IMPORT_EXTERNAL,
    (_event, sourceId: unknown, sessionPath: unknown, projectPath: unknown) => {
      if (
        !isNonEmptyString(sourceId) ||
        !isNonEmptyString(sessionPath) ||
        !isNonEmptyString(projectPath)
      ) {
        return null;
      }
      const sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions');
      return importExternalSession(sourceId, sessionPath, projectPath, sessionDir);
    }
  );
}

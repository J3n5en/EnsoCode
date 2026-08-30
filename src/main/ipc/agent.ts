import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ChildSessionIdentity, SessionIdentity } from '@shared/builtinAgents';
import { IPC_CHANNELS } from '@shared/types';
import type {
  AgentActionResult,
  AgentSpawnRequest,
  ApprovalDecision,
  ApprovalMode,
  ChildHistoryResult,
  RendererAgentEvent,
  ThinkingLevel,
} from '@shared/types/agent';
import {
  APPROVAL_MODES,
  parseConversationAuthorityRequest,
  parseCreateConversationAuthorityRequest,
  parseUpdateConversationSelectionRequest,
  THINKING_LEVELS,
} from '@shared/types/agent';
import {
  parseAgentDispatchRequest,
  parseParentModelSelectionRequest,
  parseParentSourceBindingRequest,
} from '@shared/types/mentions';
import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import { EnsoSafeJournal } from '../../agent/ensoSafeJournal';
import { ActiveConversationRegistry } from '../services/activeConversationRegistry';
import { AgentDispatchService } from '../services/agentDispatchService';
import {
  abortRetrySession,
  abortSession,
  releaseParentSession,
  agentTypeRegistrySnapshot,
  appendSessionCustomEntry,
  dismissChildSession,
  dismissCoworkerSession,
  promptChildSession,
  promptSession,
  requestSnapshot,
  resolveAgentTypeSpawnConfig,
  resolveModelSelection,
  respondApproval,
  respondAsk,
  resumeCoworkerSession,
  rewindSession,
  setAgentEventListener,
  setSessionApprovalMode,
  setSessionModel,
  setSessionReasoning,
  setSessionThinking,
  spawnChildSession,
  spawnSession,
  steerSession,
  stopBackgroundTask,
} from '../services/agentHost';
import { sessionWorktree } from './worktree';
import { searchFiles } from '../services/fileSearch';
import { maybeNotify } from '../services/notifications';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import { forwardAgentEvent, setPairAgentBridge } from '../services/pairHost';
import {
  importExternalSession,
  listExternalSessions,
  readExternalSession,
} from '../services/sessionImport';
import { SourceAuthorityRegistry } from '../services/sourceAuthorityRegistry';
import { isMainWebContents } from '../windows/MainWindow';
import { agentSessionIndex, capabilityGateway, handleCapabilityInvoke } from './capabilities';
import { readSettings } from './settings';

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
let sourceBindings: ActiveConversationRegistry | null = null;
let sourceAuthority: SourceAuthorityRegistry | null = null;

export function getAgentDispatchService(): AgentDispatchService | null {
  return dispatchService;
}

export function getSourceAuthorityRegistry(): SourceAuthorityRegistry | null {
  return sourceAuthority;
}

function broadcastAgentEvent(event: RendererAgentEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.AGENT_EVENT, event);
    }
  }
  maybeNotify(event);
  // 手机第二屏：按订阅过滤后加密下发（host 在 main，不依赖窗口焦点）
  forwardAgentEvent(event);
}

function exactIdentity(sessionId: unknown): SessionIdentity | ChildSessionIdentity | undefined {
  return isNonEmptyString(sessionId) ? agentSessionIndex.currentIdentity(sessionId) : undefined;
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
  return sessionWorktree(request.sessionId)?.path === request.cwd;
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
      !APPROVAL_MODES.includes(request.approvalMode as ApprovalMode))
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
function readChildHistory(conversationId: string): ChildHistoryResult {
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
  return { ok: true, projection: EnsoSafeJournal.restore(resolved) };
}

/**
 * 手机第二屏只持有裸 sessionId，而会话命令已收紧为 exact identity。身份解析与 spawn
 * 准入是策略，留在本文件（与渲染层走同一套 exactIdentity / persistedRootSpawn 守卫）；
 * pairHost 只做传输。解析不出身份就丢弃命令，不降级成按 sessionId 盲发。
 */
function wirePairAgentBridge(): void {
  const identityOf = (sessionId: unknown) => {
    const identity = exactIdentity(sessionId);
    return identity && !('parent' in identity) ? identity : undefined;
  };
  setPairAgentBridge({
    prompt: (sessionId, text, images) => {
      const identity = identityOf(sessionId);
      if (identity) promptSession(identity, text, images);
    },
    steer: (sessionId, text, images) => {
      const identity = identityOf(sessionId);
      if (identity) steerSession(identity, text, images);
    },
    abort: (sessionId) => {
      const identity = identityOf(sessionId);
      if (identity) abortSession(identity);
    },
    respondApproval: (sessionId, requestId, decision) => {
      const identity = identityOf(sessionId);
      if (identity) respondApproval(identity, requestId, decision);
    },
    respondAsk: (sessionId, requestId, answer) => {
      const identity = identityOf(sessionId);
      if (identity) respondAsk(identity, requestId, answer);
    },
    spawn: async (request) => {
      const identity = identityOf(request.sessionId) ?? {
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
      return spawnSession(identity, request, credentialKeys);
    },
  });
}

export function registerAgentHandlers(): void {
  wirePairAgentBridge();
  const agentDataDir = path.join(app.getPath('userData'), 'agent');
  sourceAuthority = new SourceAuthorityRegistry({
    registryFile: path.join(agentDataDir, 'source-registry.json'),
    safeSessionRoot: path.join(agentDataDir, 'sessions'),
    legacySettings: readSettings,
    onChanged: (projection) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.SOURCE_AUTHORITY_CHANGED, projection);
        }
      }
    },
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
      resolveModel: resolveModelSelection,
      resolveAgentType: resolveAgentTypeSpawnConfig,
      spawnParent: spawnSession,
      spawnChild: spawnChildSession,
      promptChild: promptChildSession,
      appendCustomEntry: appendSessionCustomEntry,
      dismissChild: dismissChildSession,
      resumeCoworker: resumeCoworkerSession,
    },
    registerCapabilityInvocation: (context) => capabilityGateway.registerInvocation(context),
    terminateGeneration: (child) => capabilityGateway.terminateGeneration(child),
  });

  setAgentEventListener((workerEvent) => {
    dispatchService?.observe(workerEvent);
    if (workerEvent.type === 'parent-ready') {
      sourceAuthority?.markReady(
        workerEvent.identity.sessionId,
        workerEvent.sessionFile,
        workerEvent.model
      );
      sourceBindings?.invalidateBindingsForConversation(workerEvent.identity.sessionId);
    }
    if (workerEvent.type === 'capability-invoke') {
      handleCapabilityInvoke(workerEvent);
      return;
    }
    if (workerEvent.type === 'child-ready') {
      const { proof: _proof, ...rendererEvent } = workerEvent;
      broadcastAgentEvent(rendererEvent);
      return;
    }
    broadcastAgentEvent(workerEvent);
  });

  ipcMain.handle(IPC_CHANNELS.SOURCE_AUTHORITY_READ, () => sourceAuthority!.projection());

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
    if (result.accepted)
      sourceBindings!.selectConversation(event.sender.id, result.value.conversationId);
    return result;
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
    if (result.accepted) sourceBindings!.invalidateConversation(parsed.conversationId);
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
          !resolveModelSelection(parsed.selection.providerId, parsed.selection.modelId, keys).ok
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
  ipcMain.handle(IPC_CHANNELS.AGENT_CHILD_HISTORY_READ, (_event, request: unknown) => {
    const conversationId = asRecord(request)?.conversationId;
    if (!isNonEmptyString(conversationId)) {
      return { ok: false, code: 'not-found', error: 'conversationId is required' };
    }
    return readChildHistory(conversationId);
  });

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
        keys
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
    const parsed = parseSpawnRequest(request);
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
    return spawnSession(identity, parsed, credentialKeys);
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_PROMPT,
    (_event, sessionId: unknown, text: unknown, images?: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      if (!identity || !isValidMessageInput(sessionId, text, images)) {
        return { ok: false, error: 'invalid prompt or stale session generation' };
      }
      return promptSession(
        identity,
        text as string,
        images as { data: string; mimeType: string }[] | undefined
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_STEER,
    (_event, sessionId: unknown, text: unknown, images?: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      if (!identity || !isValidMessageInput(sessionId, text, images)) {
        return { ok: false, error: 'invalid steer or stale session generation' };
      }
      return steerSession(
        identity,
        text as string,
        images as { data: string; mimeType: string }[] | undefined
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

  ipcMain.handle(IPC_CHANNELS.AGENT_RELEASE, (event, sessionId: unknown): AgentActionResult => {
    // 仅主窗口可释放；释放后 worker 侧会话销毁，jsonl 留盘，可携新 cwd resume
    if (!isMainWebContents(event.sender.id)) return { ok: false, error: 'not authorized' };
    const identity = exactIdentity(sessionId);
    return identity
      ? releaseParentSession(identity)
      : { ok: false, error: 'invalid release or stale session generation' };
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SNAPSHOT, (): AgentActionResult => requestSnapshot());

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
    (_event, sessionId: unknown, mode: unknown): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      if (!identity || !APPROVAL_MODES.includes(mode as ApprovalMode)) {
        return { ok: false, error: 'invalid approval mode or stale generation' };
      }
      return setSessionApprovalMode(identity, mode as ApprovalMode);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_REWIND,
    (
      _event,
      sessionId: unknown,
      userIndexFromEnd: unknown,
      restoreFiles: unknown
    ): AgentActionResult => {
      const identity = exactIdentity(sessionId);
      if (
        !identity ||
        typeof userIndexFromEnd !== 'number' ||
        userIndexFromEnd < 0 ||
        (restoreFiles !== undefined && typeof restoreFiles !== 'boolean')
      ) {
        return { ok: false, error: 'invalid rewind or stale generation' };
      }
      return rewindSession(identity, userIndexFromEnd, restoreFiles as boolean | undefined);
    }
  );

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

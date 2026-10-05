import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentTypeKey,
  type AgentTypeRegistrySnapshot,
  buildAgentTypeRegistrySnapshot,
  type ChildSessionIdentity,
  ENSO_AGENT_TYPE_KEY,
  ENSO_LOCKED_PROFILE,
  isReservedAgentTypeName,
  type SessionIdentity,
  visibleMemberAgentTypes,
} from '@shared/builtinAgents';
import type { CapabilityExecutionEnvelope } from '@shared/capabilities/types';
import {
  type ChildProfileToolOptions,
  childProfileShell,
  childProfileToolIds,
  WORKSPACE_WRITE_TOOL_ID,
} from '@shared/childProfileTools';
import { resolveCompactStrategy } from '@shared/compactStrategy';
import {
  type DefaultModelRef,
  type ModelCredentialContext,
  modelUsability,
} from '@shared/defaultModel';
import { normalizeMaxActiveCoworkers } from '@shared/maxActiveCoworkers';
import { mcpTimeoutsForSpawn } from '@shared/mcpTimeout';
import { pickModelCapabilityOverrides } from '@shared/modelCatalog';
import { eligibleOauthPoolAccountKeys, isOauthAccountPool } from '@shared/oauthAccountPool';
import { ensureAccountProvider } from '@shared/piAccounts';
import { proxyEnvPatchFromEnv } from '@shared/proxy';
import { parseSmartCompactMode } from '@shared/smartCompactMode';
import {
  projectDisabledBuiltinTools,
  projectTrustedCode,
  resolveDisabledBuiltinTools,
  resolveEditMode,
} from '@shared/types';
import type {
  AgentCommand,
  AgentRemoteConfig,
  AgentSessionCustomEntry,
  AgentSpawnRequest,
  AgentTypeSpawnConfig,
  AgentWorkerEvent,
  ApprovalDecision,
  ApprovalMode,
  AttachedImage,
  McpServerSpawnConfig,
  ModelRef,
  ResolvedAgentTypeSpawnConfig,
  SessionReloadResult,
  SpawnModelConfig,
  SubagentModelOption,
  ThinkingLevel,
  TitleSummaryInput,
  VirtualClassifierCredentials,
  VirtualSpawnClassifier,
} from '@shared/types/agent';
import { parseAgentWorkerEvent } from '@shared/types/agent';
import type { SubagentModelEntry } from '@shared/types/assets';
import {
  type AgentTypeEntry,
  BUILTIN_AGENT_TYPES,
  DEFAULT_PRESET_ID,
  type McpServerEntry,
  type Preset,
  type SkillEntry,
} from '@shared/types/assets';
import { persistedSettingsState } from '@shared/types/builtinTools';
import {
  MODEL_REASONING_OVERRIDES,
  MODEL_THINKING_LEVEL_OVERRIDES,
  type ModelEntry,
  type ModelProvider,
  type ModelReasoningOverride,
  type ModelThinkingLevelOverride,
} from '@shared/types/llm';
import type { AgentDispatchTask } from '@shared/types/mentions';
import { parseDisabledWorkflowPresets } from '@shared/types/workflow';
import {
  canBeVirtualMember,
  classifierProviderFor,
  directMemberRef,
  findVirtualModel,
  isVirtualRef,
  parseVirtualModels,
  VIRTUAL_PROVIDER_ID,
  type VirtualClassifierConfig,
  type VirtualModelEntry,
} from '@shared/virtualModels';
import { parseWindowsLocalShell } from '@shared/windowsLocalShell';
import { app, type UtilityProcess, utilityProcess } from 'electron';
import { ENSO_SYSTEM_PROMPT } from '../../agent/ensoPrompt';
import agentWorkerPath from '../../agent/index?modulePath';
import { readSettings } from '../ipc/settings';
import { agentCommandDispatch } from './agentCommandDispatch';
import { type MemberAgentType, memberSpawnDescription } from './bots/botAgentType';
import type { ResolvedPlugins } from './claudePlugins';
import { isComputerPlatformSupported } from './computer/support';
import { resolveGlobalInstruction } from './instructionStore';
import { getMcpOAuthStore } from './mcpOAuthStore';
import { getMcpToolCatalog } from './mcpToolCatalog';
import { OAUTH_POOL_EXHAUSTED } from './oauthAccountPool';
import { getOauthQuotaCoordinator, getRuntime as getOauthRuntime } from './oauthProviders';
import { PendingReloadRegistry } from './pendingReloads';
import { enabledPlugins, type RuntimeAgentType, withPluginAgentTypes } from './pluginRuntime';
import { killAndWaitExit } from './processExit';
import { bundledRtkPath } from './rtkBinary';
import { pickSubagentModelRefs } from './subagentModels';
import { readStoredSystemPrompt } from './systemPromptStore';
import { workspaceCommandBlocked } from './workspaceCommandGate';
import { WorkspaceLockRequests } from './workspaceLockRequests';

export interface ResolvedModelSelection {
  ref: ModelRef;
  runtimeRef: ModelRef;
  config: SpawnModelConfig;
}

export type ModelSelectionResult =
  | { ok: true; selection: ResolvedModelSelection }
  | { ok: false; error: string };

export type AgentTypeResolution =
  | {
      ok: true;
      config: ResolvedAgentTypeSpawnConfig;
      expectedModel: ModelRef;
      expectedToolIds: readonly string[];
      allowsModelOverride?: boolean;
    }
  | { ok: false; error: string };

/** 管理 agent worker（utilityProcess）的生命周期与命令下发。故障域 A：一个 worker 装全部会话。 */
let worker: UtilityProcess | null = null;

/**
 * worker 每次请求都向 Main 选号。账号成员、启用状态、模型目录和真实 OAuth 存储实时核验，失败原因只影响该账号的有限窗口。
 *
 * Every worker request selects through Main. Membership, enabled state, catalog and stored OAuth credentials are checked live; evidence blocks only that account for a bounded window.
 */
export async function selectOauthPoolAccount(
  event: Extract<AgentWorkerEvent, { type: 'oauth-pool-select' }>
): Promise<Extract<AgentCommand, { type: 'oauth-pool-result' }>> {
  try {
    const providers = providersFromSettings();
    const provider = providers.find((entry) => entry.id === event.settingsProviderId);
    if (!provider || !isOauthAccountPool(provider)) throw new Error(OAUTH_POOL_EXHAUSTED);
    const runtime = await getOauthRuntime();
    const loggedIn = new Set(
      (await runtime.listCredentials())
        .filter((entry) => entry.type === 'oauth')
        .map((entry) => entry.providerId)
    );
    const eligible = eligibleOauthPoolAccountKeys(
      provider,
      event.modelId,
      providers,
      loggedIn
    ).filter((key) => {
      if (event.excludedAccountKeys?.includes(key)) return false;
      ensureAccountProvider(runtime, key);
      return runtime.getModel(key, event.modelId) !== undefined;
    });
    const quota = getOauthQuotaCoordinator();
    quota.reconcileKeys(loggedIn);
    const failed = await quota.validateFailure(provider.id, event.failed);
    const selected = await quota.select(
      provider.id,
      provider.oauthAccountPool?.accountKeys ?? [],
      eligible,
      failed
    );
    const { accountKey } = selected;
    const selectionReceipt = accountKey
      ? await quota.issueSelectionReceipt(provider.id, accountKey)
      : undefined;
    if (selected.warning) console.warn(`[OAuthQuota] ${selected.warning}`);
    if (accountKey) {
      // 查额度期间配置或登录态可能变化；返回 worker 前再次按权威记录核验，禁止发给已停用成员。
      //
      // Configuration/credentials may change while querying usage; validate authoritative records again before allowing the worker to use the selected account.
      const latestKeys = new Set(
        (await runtime.listCredentials())
          .filter((entry) => entry.type === 'oauth')
          .map((entry) => entry.providerId)
      );
      const receiptStillCurrent =
        selectionReceipt &&
        (await quota.validateFailure(provider.id, {
          accountKey,
          reason: 'login-invalid',
          selectionReceipt,
        }));
      const latestProviders = providersFromSettings();
      const latestProvider = latestProviders.find((entry) => entry.id === event.settingsProviderId);
      quota.reconcileKeys(latestKeys);
      if (
        !receiptStillCurrent ||
        !latestProvider ||
        !eligibleOauthPoolAccountKeys(
          latestProvider,
          event.modelId,
          latestProviders,
          latestKeys
        ).includes(accountKey) ||
        !runtime.getModel(accountKey, event.modelId)
      ) {
        return {
          type: 'oauth-pool-result',
          requestId: event.requestId,
          error:
            'OAuth pool membership changed while checking quota. Retry with the current configuration.',
        };
      }
    }
    return accountKey
      ? { type: 'oauth-pool-result', requestId: event.requestId, accountKey, selectionReceipt }
      : {
          type: 'oauth-pool-result',
          requestId: event.requestId,
          error: selected.error ?? OAUTH_POOL_EXHAUSTED,
        };
  } catch (error) {
    return {
      type: 'oauth-pool-result',
      requestId: event.requestId,
      error: error instanceof Error ? error.message : OAUTH_POOL_EXHAUSTED,
    };
  }
}
/** worker 已过 'spawn'：在此之前 postMessage 不保证送达（含已 fork 未 spawn 的窗口） */
let workerReady = false;
let onEvent: ((event: AgentWorkerEvent | { type: 'worker-exited' }) => void) | null = null;
/** worker 就绪前到达的快照请求，spawn 后补发。true = 全量，string = 单会话。 */
let snapshotPending: false | true | string = false;
/** worker 已 fork 未 spawn 窗口内到达的命令：postMessage 不保证送达，spawn 后按序补发 */
let commandsPending: AgentCommand[] = [];
/** worker 曾启动后退出：spawn 时可按需重建（首次启动前不行，要等 env/PATH 探测） */
let workerExited = false;
/** 不可闲置回收的会话，按来源（桌面查看 / 手机订阅）分桶；worker 重启后需重发并集 */
const pinnedBySource = new Map<string, readonly string[]>();
let lastPinnedKey = '';

function pushPinnedSessions(force = false): void {
  const sessionIds = [...new Set([...pinnedBySource.values()].flat())].sort();
  const key = sessionIds.join('\n');
  if (!force && key === lastPinnedKey) return;
  lastPinnedKey = key;
  if (worker && workerReady)
    worker.postMessage({ type: 'pin-sessions', sessionIds } satisfies AgentCommand);
}

/** 替换某一来源的 pinned 会话集；并集变化才下发 worker。 */
export function setPinnedSessions(source: 'viewed' | 'pair', sessionIds: readonly string[]): void {
  pinnedBySource.set(source, sessionIds);
  pushPinnedSessions();
}

export function setAgentEventListener(
  listener: (event: AgentWorkerEvent | { type: 'worker-exited' }) => void
): void {
  onEvent = listener;
}

/** worker 数据根（ENSO_AGENT_DATA_DIR）；worker 在其下读 workflows/ 等 Main 写入的内容。 */
export function agentDataDir(): string {
  return path.join(app.getPath('userData'), 'agent');
}

export function customWorkflowPresetDir(): string {
  return path.join(agentDataDir(), 'workflows');
}

export function startAgentWorker(): void {
  if (worker) return;
  const child = utilityProcess.fork(agentWorkerPath, [], {
    serviceName: 'enso-agent-worker',
    env: {
      ...process.env,
      ENSO_AGENT_DATA_DIR: agentDataDir(),
      PI_CODING_AGENT_DIR: path.join(app.getPath('userData'), 'agent', 'pi-agent'),
      ENSO_RTK_PATH: bundledRtkPath({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        platform: process.platform,
        arch: process.arch,
      }),
    },
  });
  worker = child;
  workerExited = false;

  child.once('spawn', () => {
    workerReady = true;
    // fork 前 ProxyConfig 的 set-proxy-env 因 worker 不存在被丢；spawn 后按 main 当前 env 补发一次
    child.postMessage({
      type: 'set-proxy-env',
      env: proxyEnvPatchFromEnv(process.env),
    } satisfies AgentCommand);
    pushMcpWarmup();
    pushPinnedSessions(true);
    if (snapshotPending !== false) {
      const command: AgentCommand =
        snapshotPending === true
          ? { type: 'snapshot' }
          : { type: 'snapshot', sessionId: snapshotPending };
      snapshotPending = false;
      child.postMessage(command);
    }
    const queued = commandsPending;
    commandsPending = [];
    for (const command of queued) child.postMessage(command);
    pushApprovalReviewer();
    pushMaxActiveCoworkers();
    pushDisabledWorkflowPresets();
  });
  child.on('message', (raw) => {
    const event = parseAgentWorkerEvent(raw);
    if (event) {
      if (event.type === 'oauth-pool-select') {
        void selectOauthPoolAccount(event).then((result) => {
          if (worker === child) child.postMessage(result);
        });
        return;
      }
      resolveReleaseWaiters(event);
      // 手动重读结果只回给发起 invoke 的等待者，不进普通事件流（renderer 的通用
      // snapshot 分支会顺手改 started / 清 asks，手动刷新不能有这些副作用）
      if (pendingReloads.settle(event) || workspaceLocks.settle(event)) return;
      if (settleCompletion(event) || settleChoice(event)) return;
      onEvent?.(event);
    }
  });
  child.on('exit', () => {
    if (worker === child) {
      worker = null;
      workerReady = false;
      workerExited = true;
    }
    pendingReloads.failAll('agent worker exited');
    workspaceLocks.failAll('agent worker exited');
    for (const [id, p] of pendingCompletions) {
      pendingCompletions.delete(id);
      p.reject(new Error('agent worker exited'));
    }
    for (const [id, p] of pendingChoices) {
      pendingChoices.delete(id);
      p.reject(new Error('agent worker exited'));
    }
    onEvent?.({ type: 'worker-exited' });
  });
}

export function stopAgentWorker(): void {
  workspaceLocks.failAll('agent worker stopped');
  worker?.kill();
  worker = null;
  workerReady = false;
  snapshotPending = false;
  commandsPending = [];
  workerExited = false;
}

export function agentWorkerAlive(): boolean {
  return worker !== null;
}

/**
 * 应用退出时 Electron 不给 utility 进程发 SIGTERM，worker 的收尾（中止会话→pi 杀 detached
 * bash 进程组、断开 MCP）跑不到，命令会成孤儿进程。退出前主动发信号并等它自行退出。
 */
export function stopAgentWorkerForQuit(timeoutMs: number): Promise<void> {
  const child = worker;
  if (!child) return Promise.resolve();
  return killAndWaitExit(child, timeoutMs);
}

/**
 * 向存活 worker 重新下发 MCP server（带最新 OAuth 凭据）。给 serverId 时只下发该条目，
 * 且不过 enabled/preset 过滤——授权的 server 可能被禁用或只被某 agentType 引用。
 * 返回是否真的下发了。
 */
export function pushMcpWarmup(serverId?: string): boolean {
  if (!worker || !workerReady) return false;
  const servers = serverId ? mcpServerById(serverId) : enabledMcpServers();
  if (servers.length === 0) return false;
  worker.postMessage({ type: 'warm-mcp', servers } satisfies AgentCommand);
  return true;
}

export function isAgentWorkerRunning(): boolean {
  return worker !== null;
}

let workspaceBusy: (id: string) => boolean = () => false;

const workspaceLocks = new WorkspaceLockRequests(sendAgentCommand);
const workspaceWorkers = new Map<string, UtilityProcess | null>();

export async function freezeWorkspace(
  requestId: string,
  conversationIds: string[]
): Promise<{ ok: boolean; error?: string; needsThaw?: boolean }> {
  const expectedWorker = worker;
  if (!worker) {
    if (commandsPending.some((command) => workspaceCommandBlocked(command, workspaceBusy)))
      return { ok: false, error: 'A workspace command is pending.' };
    workspaceWorkers.set(requestId, null);
    return { ok: true };
  }
  const result = await workspaceLocks.request({
    type: 'lock-workspace',
    requestId,
    conversationIds,
  });
  if (!result.ok && worker === expectedWorker) {
    const cleanup = await workspaceLocks.request({
      type: 'unlock-workspace',
      requestId,
      conversationIds,
    });
    if (!cleanup.ok && worker === expectedWorker) {
      workspaceWorkers.set(requestId, expectedWorker);
      return { ...result, needsThaw: true };
    }
  }
  if (result.ok) workspaceWorkers.set(requestId, expectedWorker);
  return result;
}

export async function thawWorkspace(
  requestId: string,
  conversationIds: string[],
  branch?: string
): Promise<{ ok: boolean; error?: string }> {
  const expectedWorker = workspaceWorkers.get(requestId);
  if (!worker || expectedWorker !== worker) {
    workspaceWorkers.delete(requestId);
    return { ok: true };
  }
  const result = await workspaceLocks.request({
    type: 'unlock-workspace',
    requestId,
    conversationIds,
    ...(branch ? { branch } : {}),
  });
  if (result.ok || worker !== expectedWorker) workspaceWorkers.delete(requestId);
  return worker !== expectedWorker ? { ok: true } : result;
}

export function setWorkspaceBusyResolver(resolver: (id: string) => boolean): void {
  workspaceBusy = resolver;
}

export function sendAgentCommand(command: AgentCommand): { ok: boolean; error?: string } {
  if (workspaceCommandBlocked(command, workspaceBusy))
    return { ok: false, error: 'Workspace operation in progress.' };
  const action = agentCommandDispatch({
    hasWorker: worker !== null,
    workerReady,
    workerExited,
  });
  if (action === 'restart-then-queue') startAgentWorker();
  if (action === 'post' && worker) {
    worker.postMessage(command);
    return { ok: true };
  }
  commandsPending.push(command);
  return { ok: true };
}

let memberAgentTypes: () => readonly MemberAgentType[] = () => [];

/** Bot 模块注入在册成员（关闭 Bot 模式时返回空）；每次构造注册表/下发 worker 时现取 */
export function setMemberAgentTypeSource(source: () => readonly MemberAgentType[]): void {
  memberAgentTypes = source;
}

export function agentTypeRegistrySnapshot(): AgentTypeRegistrySnapshot {
  const state = readSettingsState();
  const disabledBuiltinAgentTypes = Array.isArray(state?.disabledBuiltinAgentTypes)
    ? state.disabledBuiltinAgentTypes.filter((name): name is string => typeof name === 'string')
    : [];
  const customAgentTypes = withPluginAgentTypes(
    Array.isArray(state?.agentTypes) ? state.agentTypes.filter(isAgentTypeEntry) : [],
    state
  );
  return buildAgentTypeRegistrySnapshot({
    revision: settingsRevision(state),
    disabledBuiltinAgentTypes,
    customAgentTypes,
    members: memberAgentTypes(),
  });
}

/**
 * 解析模型引用并组装下发配置。虚拟模型只在 `allowVirtual` 的场景（会话主模型）下发为虚拟配置；
 * 其他场景（标题、代审、子代理固定模型…）落到虚拟引用时取其快模型（无则主模型）。
 */
export function resolveModelSelection(
  providerId: string,
  modelId: string,
  authenticatedAccountKeys: ReadonlySet<string>,
  options?: { allowVirtual?: boolean }
): ModelSelectionResult {
  if (isVirtualRef({ providerId })) {
    const entry = findVirtualModel(virtualModelsFromSettings(), { providerId, modelId });
    if (!entry) return { ok: false, error: 'Model is unavailable: model-missing' };
    if (!entry.enabled) return { ok: false, error: 'Model is unavailable: model-disabled' };
    if (!options?.allowVirtual) {
      const direct = directMemberRef(entry);
      const resolved = resolvePhysicalModelSelection(
        direct.providerId,
        direct.modelId,
        authenticatedAccountKeys
      );
      return resolved.ok || direct === entry.primary
        ? resolved
        : resolvePhysicalModelSelection(
            entry.primary.providerId,
            entry.primary.modelId,
            authenticatedAccountKeys
          );
    }
    return resolveVirtualModelSelection(entry, authenticatedAccountKeys);
  }
  return resolvePhysicalModelSelection(providerId, modelId, authenticatedAccountKeys);
}

function resolveVirtualModelSelection(
  entry: VirtualModelEntry,
  authenticatedAccountKeys: ReadonlySet<string>
): ModelSelectionResult {
  const member = (ref: DefaultModelRef): SpawnModelConfig | undefined => {
    const provider = providersFromSettings().find((item) => item.id === ref.providerId);
    if (!provider || !canBeVirtualMember(provider)) return undefined;
    const resolved = resolvePhysicalModelSelection(
      ref.providerId,
      ref.modelId,
      authenticatedAccountKeys
    );
    return resolved.ok ? resolved.selection.config : undefined;
  };
  const primary = member(entry.primary);
  if (!primary) return { ok: false, error: 'Model is unavailable: virtual primary model' };
  const fast = entry.fast ? member(entry.fast) : undefined;
  const fallbacks = entry.fallbacks
    .map(member)
    .filter((config): config is SpawnModelConfig => config !== undefined);
  // 分类器只在有快模型可分档时下发；解析失败静默不分类（路由回到主模型）
  const classifier =
    fast && entry.classifier
      ? resolveVirtualClassifier(entry.classifier, authenticatedAccountKeys)
      : undefined;
  const config: SpawnModelConfig = {
    ...primary,
    modelId: entry.id,
    settingsProviderId: VIRTUAL_PROVIDER_ID,
    virtual: {
      name: entry.name,
      primary,
      ...(fast ? { fast } : {}),
      fallbacks,
      ...(classifier ? { classifier } : {}),
    },
  };
  return {
    ok: true,
    selection: {
      ref: { providerId: VIRTUAL_PROVIDER_ID, modelId: entry.id },
      runtimeRef: { providerId: VIRTUAL_PROVIDER_ID, modelId: entry.id },
      config,
    },
  };
}

export function resolveVirtualClassifier(
  classifier: VirtualClassifierConfig,
  authenticatedAccountKeys: ReadonlySet<string>
): VirtualSpawnClassifier | undefined {
  if (classifier.source === 'judge') {
    const resolved = resolvePhysicalModelSelection(
      classifier.model.providerId,
      classifier.model.modelId,
      authenticatedAccountKeys
    );
    return resolved.ok
      ? { source: 'judge', timeoutMs: classifier.timeoutMs, model: resolved.selection.config }
      : undefined;
  }
  const provider = providersFromSettings().find((item) => item.id === classifier.model.providerId);
  if (!provider?.enabled) return undefined;
  const piProvider = classifierProviderFor(provider);
  if (!piProvider) return undefined;
  if (provider.oauthAccountKey) {
    if (!authenticatedAccountKeys.has(provider.oauthAccountKey)) return undefined;
  } else if (!provider.apiKey) {
    return undefined;
  }
  return {
    source: 'pi-classifier',
    timeoutMs: classifier.timeoutMs,
    classifier: {
      provider: piProvider,
      modelId: classifier.model.modelId,
      ...(provider.oauthAccountKey ? {} : { apiKey: provider.apiKey }),
    },
  };
}

function resolvePhysicalModelSelection(
  providerId: string,
  modelId: string,
  authenticatedAccountKeys: ReadonlySet<string>
): ModelSelectionResult {
  const providers = providersFromSettings();
  const credentials: ModelCredentialContext = {
    oauthCredentials: { status: 'ready', authenticatedAccountKeys },
  };
  const reason = modelUsability({ providerId, modelId }, providers, credentials);
  if (reason !== 'usable') {
    return { ok: false, error: `Model is unavailable: ${reason}` };
  }
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) return { ok: false, error: 'Model provider is unavailable.' };
  const config = spawnModelConfig(provider, modelId);
  return {
    ok: true,
    selection: {
      ref: { providerId, modelId },
      runtimeRef: { providerId: config.oauthAccountKey ?? config.api, modelId: config.modelId },
      config,
    },
  };
}

const parentToolProfiles = new Map<string, ChildProfileToolOptions>();

export interface AgentTypeProfileContext {
  parentSessionId?: string;
  projectId?: string;
  remote?: boolean;
}

/** 记下父会话 spawn 时下发给 worker 的工具档。事后改设置不能拿来做 proof。 */
export function rememberParentToolProfile(
  sessionId: string,
  profile: ChildProfileToolOptions
): void {
  parentToolProfiles.set(sessionId, profile);
}

export function forgetParentToolProfile(sessionId: string): void {
  parentToolProfiles.delete(sessionId);
}

export function expectedAgentTypeToolIds(
  tools: AgentTypeEntry['tools'],
  options?: ChildProfileToolOptions & AgentTypeProfileContext
): readonly string[] {
  const remembered = options?.parentSessionId
    ? parentToolProfiles.get(options.parentSessionId)
    : undefined;
  return childProfileToolIds(tools, remembered ?? options);
}

export function resolveAgentTypeSpawnConfig(
  typeKey: AgentTypeKey,
  parentModel: ResolvedModelSelection,
  authenticatedAccountKeys: ReadonlySet<string>,
  context?: AgentTypeProfileContext
): AgentTypeResolution {
  const snapshot = agentTypeRegistrySnapshot();
  const candidate = snapshot.candidates.find((entry) => entry.typeKey === typeKey);
  if (!candidate) return { ok: false, error: 'Agent type is unavailable.' };

  if (typeKey === ENSO_AGENT_TYPE_KEY) {
    return {
      ok: true,
      config: {
        typeKey,
        displayName: 'Enso',
        description: candidate.description,
        spawnSpecId: randomUUID(),
        systemPrompt: ENSO_SYSTEM_PROMPT,
        model: parentModel.config,
        tools: 'enso-locked',
        skillPaths: [],
        skillBindingIds: [],
        mcpServers: [],
        mcpBindingIds: [],
        systemPromptHash: createHash('sha256').update(ENSO_SYSTEM_PROMPT).digest('hex'),
        lockedProfileId: ENSO_LOCKED_PROFILE.profileId,
      },
      expectedModel: parentModel.ref,
      expectedToolIds: ENSO_LOCKED_PROFILE.toolIds,
      allowsModelOverride: false,
    };
  }

  const state = readSettingsState();
  let definition: Omit<AgentTypeEntry, 'id'> | RuntimeAgentType | undefined;
  if (typeKey.startsWith('builtin:')) {
    const name = typeKey.slice('builtin:'.length);
    definition = BUILTIN_AGENT_TYPES.find((entry) => entry.name === name);
  } else if (typeKey.startsWith('bot:')) {
    definition = memberAgentTypes().find((entry) => entry.typeKey === typeKey);
  } else {
    const id = typeKey.slice('custom:'.length);
    definition = withPluginAgentTypes(
      Array.isArray(state?.agentTypes) ? state.agentTypes.filter(isAgentTypeEntry) : [],
      state
    ).find((entry) => entry.id === id);
  }
  if (!definition || isReservedAgentTypeName(definition.name)) {
    return { ok: false, error: 'Agent type definition is invalid.' };
  }

  let selectedModel = parentModel;
  if (definition.providerId || definition.modelId) {
    if (!definition.providerId || !definition.modelId) {
      return { ok: false, error: 'Agent type model binding is incomplete.' };
    }
    const resolved = resolveModelSelection(
      definition.providerId,
      definition.modelId,
      authenticatedAccountKeys
    );
    if (!resolved.ok) return { ok: false, error: resolved.error };
    selectedModel = resolved.selection;
  }

  const resources = resolveAgentTypeResources(definition);
  if (!resources.ok) return resources;
  const disabledTools = resolveDisabledBuiltinTools(state?.disabledBuiltinTools, {
    disabledBuiltinTools: projectDisabledBuiltinTools(state?.projects, context?.projectId),
  });
  const liveProfile: ChildProfileToolOptions = {
    editMode: resolveEditMode(state?.editMode, state?.hashlineEditEnabled),
    shell: childProfileShell({
      platform: process.platform,
      remote: context?.remote === true,
      preference: state?.windowsLocalShell,
    }),
    exploreFold: state?.exploreFoldEnabled === true,
    isolatedSandbox: !disabledTools.includes('isolated_sandbox'),
    workspaceWrite: !disabledTools.includes(WORKSPACE_WRITE_TOOL_ID),
  };
  const expectedToolIds = expectedAgentTypeToolIds(definition.tools, {
    ...liveProfile,
    ...(context?.parentSessionId ? { parentSessionId: context.parentSessionId } : {}),
  });
  return {
    ok: true,
    config: {
      typeKey,
      displayName: candidate.displayName,
      description: candidate.description,
      spawnSpecId: randomUUID(),
      systemPrompt: definition.systemPrompt,
      model: selectedModel.config,
      tools: definition.tools,
      allowedToolIds: expectedToolIds,
      skillPaths: resources.skillPaths,
      skillBindingIds: resources.skillPaths.map(() => randomUUID()),
      mcpServers: resources.mcpServers,
      mcpBindingIds: resources.mcpServers.map(() => randomUUID()),
      systemPromptHash: createHash('sha256').update(definition.systemPrompt).digest('hex'),
    },
    expectedModel: selectedModel.ref,
    expectedToolIds,
    allowsModelOverride:
      (definition.modelMode ??
        (definition.providerId && definition.modelId
          ? 'fixed'
          : typeKey.startsWith('builtin:')
            ? 'agent_pick'
            : 'follow')) === 'agent_pick' &&
      configuredSubagentModels(authenticatedAccountKeys).length > 0,
  };
}

export function spawnSession(
  identity: SessionIdentity,
  request: AgentSpawnRequest,
  authenticatedAccountKeys: ReadonlySet<string>,
  /** 由 main 从项目权威派生(渲染层不可伪造):ssh 项目的会话工具走远端执行 */
  remote?: AgentRemoteConfig,
  /** 由 main 从会话权威派生，渲染层不可伪造 */
  projectId?: string,
  options?: {
    rolePrompt?: string;
    extraDisabledTools?: readonly string[];
    omitDispatchTools?: boolean;
    /** Bot 会话：人设、指令与技能/MCP 选择全由 Main 按成员档案组装，替代预设与插件资源 */
    bot?: {
      systemPrompt: string;
      instruction: { path: string; content: string };
      skillIds: string[];
      mcpServerIds: string[];
      /** 群聊成员会话：worker 挂 group_tasks */
      groupTasks?: boolean;
      /** 私聊 / 群聊成员会话（非委派）：worker 挂 routine_propose */
      routines?: boolean;
      /** 写成员同工作区写协调 */
      writeLock?: { label: string; ancestors: string[] };
    };
  }
): { ok: boolean; error?: string } {
  if (request.resumeFile && !existsSync(request.resumeFile)) {
    return { ok: false, error: '会话文件已丢失，无法恢复历史' };
  }
  const resolved = resolveModelSelection(
    request.providerId,
    request.modelId,
    authenticatedAccountKeys,
    { allowVirtual: true }
  );
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const reviewer = resolveApprovalReviewer(authenticatedAccountKeys);
  if (!reviewer.ok) {
    if (request.approvalMode === 'assistant') return { ok: false, error: reviewer.error };
  }
  if (request.approvalMode === 'assistant' && (!reviewer.ok || !reviewer.selection)) {
    return { ok: false, error: 'Select an assistant approval model in Settings first.' };
  }
  const approvalReviewerConfig = reviewer.ok ? reviewer.selection?.config : undefined;
  const bot = options?.bot;
  const preset: Preset | undefined = bot
    ? { id: 'bot', name: 'bot', skillIds: bot.skillIds, mcpServerIds: bot.mcpServerIds }
    : resolvePreset(request.presetId);
  const systemPrompt = bot
    ? { ok: true as const, content: bot.systemPrompt }
    : resolvePresetSystemPrompt(preset);
  if (!systemPrompt.ok) {
    return { ok: false, error: '自定义系统提示词正文读取失败，请重新保存或恢复默认。' };
  }
  const instruction = bot
    ? bot.instruction
    : resolveGlobalInstruction(preset ? { instructionId: preset.instructionId } : undefined);
  const state = readSettingsState();
  // Claude 插件：按各自开关现读安装目录，不受预设影响
  const plugins = enabledPlugins(state);
  const skillPaths = [...enabledSkillPaths(preset), ...(bot ? [] : plugins.skillPaths)];
  const mcpServers = enabledMcpServers(preset);
  const mcpNames = new Set(mcpServers.map((server) => server.name));
  for (const server of bot ? [] : plugins.mcpServers) {
    if (!mcpNames.has(server.name)) mcpServers.push(server);
    mcpNames.add(server.name);
  }
  // hooks 在本机起进程，远程会话的 cwd 不在本机
  const pluginHooks = remote ? [] : plugins.hooks;
  const subagentModels = options?.omitDispatchTools
    ? []
    : configuredSubagentModels(authenticatedAccountKeys);
  const agentTypes = options?.omitDispatchTools
    ? []
    : configuredAgentTypes(authenticatedAccountKeys, subagentModels.length > 0, plugins);
  const disabledTools = resolveDisabledBuiltinTools(state?.disabledBuiltinTools, {
    disabledBuiltinTools: projectDisabledBuiltinTools(state?.projects, projectId),
  });
  for (const id of options?.extraDisabledTools ?? []) {
    if (!disabledTools.includes(id)) disabledTools.push(id);
  }
  // 当前平台不能操作桌面时不下发 computer，避免模型反复调用必失败的工具
  if (!isComputerPlatformSupported() && !disabledTools.includes('computer')) {
    disabledTools.push('computer');
  }
  const loadHarnessAssets = state?.loadHarnessAssets === true;
  const trustedProjectCode = projectTrustedCode(state?.projects, projectId);
  const windowsLocalShell = parseWindowsLocalShell(state?.windowsLocalShell);
  const exploreFoldEnabled = state?.exploreFoldEnabled === true;
  const editMode = resolveEditMode(state?.editMode, state?.hashlineEditEnabled);
  const compactStrategy = resolveCompactStrategy(
    state?.compactStrategy,
    state?.smartCompactEnabled
  );
  const smartCompactEnabled = compactStrategy === 'smart';
  const smartCompactRef = asModelRef(state?.smartCompactModel);
  const smartCompactSummary =
    compactStrategy !== 'standard' && smartCompactRef
      ? resolveModelSelection(
          smartCompactRef.providerId,
          smartCompactRef.modelId,
          authenticatedAccountKeys
        )
      : undefined;
  const smartCompactSummaryModel = smartCompactSummary?.ok
    ? smartCompactSummary.selection.config
    : undefined;
  const smartCompactMode = parseSmartCompactMode(state?.smartCompactMode) ?? undefined;
  // 记忆存储语言下发给 worker：memory_search 的描述据此告诉模型该用哪种语言查
  const memoryLanguage = typeof state?.memoryLanguage === 'string' ? state.memoryLanguage : 'en';
  // worker 崩溃/退出后不自动拉起的话，所有会话都只能靠重启 app 恢复；在 spawn 入口按需重建
  if (!worker && workerExited) startAgentWorker();
  const sent = sendAgentCommand({
    type: 'spawn-parent',
    identity,
    cwd: request.cwd,
    model: resolved.selection.config,
    ...(request.resumeFile ? { resumeFile: request.resumeFile } : {}),
    ...(request.reasoningEnabled ? { reasoningEnabled: true } : {}),
    ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
    ...(preset || request.loadLocalSkills === false ? { loadLocalSkills: false } : {}),
    ...(loadHarnessAssets ? { loadHarnessAssets: true } : {}),
    ...(trustedProjectCode.length > 0 ? { trustedProjectCode } : {}),
    ...(windowsLocalShell !== 'auto' ? { windowsLocalShell } : {}),
    rtkEnabled: state?.rtkEnabled !== false,
    ...(exploreFoldEnabled ? { exploreFoldEnabled: true } : {}),
    editMode,
    ...(compactStrategy !== 'standard' ? { compactStrategy } : {}),
    ...(smartCompactEnabled ? { smartCompactEnabled: true } : {}),
    ...(smartCompactSummaryModel ? { smartCompactSummaryModel } : {}),
    ...(smartCompactMode ? { smartCompactMode } : {}),
    ...(disabledTools.includes('memory') ? {} : { memoryLanguage }),
    ...(skillPaths.length > 0 ? { skillPaths } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(plugins.commands.length > 0 ? { pluginCommands: plugins.commands } : {}),
    ...(pluginHooks.length > 0 ? { pluginHooks } : {}),
    ...(request.approvalMode ? { approvalMode: request.approvalMode } : {}),
    ...(request.planMode !== undefined ? { planMode: request.planMode } : {}),
    ...(approvalReviewerConfig ? { approvalReviewer: approvalReviewerConfig } : {}),
    ...(agentTypes.length > 0 ? { agentTypes } : {}),
    ...(subagentModels.length > 0 ? { subagentModels } : {}),
    ...(disabledTools.length > 0 ? { disabledTools } : {}),
    ...(instruction ? { instruction } : {}),
    ...(remote ? { remote } : {}),
    ...(options?.rolePrompt ? { rolePrompt: options.rolePrompt } : {}),
    ...(systemPrompt.content ? { systemPrompt: systemPrompt.content } : {}),
    ...(options?.bot ? { botMode: true } : {}),
    ...(options?.bot?.groupTasks ? { botGroupTasks: true } : {}),
    ...(options?.bot?.routines ? { botRoutines: true } : {}),
    ...(options?.bot?.writeLock ? { botWriteLock: options.bot.writeLock } : {}),
    ...(options?.bot || state?.protectedActionsInCode === true ? { protectedActions: true } : {}),
  });
  if (sent.ok) {
    rememberParentToolProfile(identity.sessionId, {
      editMode,
      shell: childProfileShell({
        platform: process.platform,
        remote: remote !== undefined,
        preference: windowsLocalShell,
      }),
      exploreFold: exploreFoldEnabled,
      isolatedSandbox: !disabledTools.includes('isolated_sandbox'),
      workspaceWrite: !disabledTools.includes(WORKSPACE_WRITE_TOOL_ID),
    });
  }
  return sent;
}

export function resolvePresetSystemPrompt(
  preset?: Pick<Preset, 'systemPromptId'>
): { ok: true; content?: string } | { ok: false } {
  if (!preset?.systemPromptId) return { ok: true };
  const result = readStoredSystemPrompt(preset.systemPromptId);
  return result.ok ? { ok: true, content: result.content } : { ok: false };
}

/**
 * 已启动会话就地换模型。不做这件事的后果见 issue #30：选择器显示新模型、
 * 请求却仍打旧 provider，且该会话后续所有 @Agent 派发被永久拒绝。
 */
export function setSessionModel(
  identity: SessionIdentity,
  providerId: string,
  modelId: string,
  authenticatedAccountKeys: ReadonlySet<string>
): { ok: boolean; error?: string } {
  const resolved = resolveModelSelection(providerId, modelId, authenticatedAccountKeys, {
    allowVirtual: true,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return sendAgentCommand({ type: 'set-model', identity, model: resolved.selection.config });
}

export function spawnChildSession(
  identity: ChildSessionIdentity,
  cwd: string,
  config: ResolvedAgentTypeSpawnConfig,
  resumeFile?: string
): { ok: boolean; error?: string } {
  if (resumeFile && !existsSync(resumeFile)) {
    return { ok: false, error: 'coworker 会话文件已丢失，无法恢复' };
  }
  return sendAgentCommand({
    type: 'spawn-child',
    identity,
    cwd,
    config,
    ...(resumeFile ? { resumeFile } : {}),
  });
}

export function promptChildSession(
  identity: ChildSessionIdentity,
  requestId: string,
  task: AgentDispatchTask
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'prompt-child', identity, requestId, task });
}

export function dismissChildSession(
  parent: SessionIdentity,
  child: ChildSessionIdentity,
  notify = false
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'dismiss-child',
    parent,
    child,
    ...(notify ? { notify: true } : {}),
  });
}

/** 重启后恢复 worker 直雇 coworker：name/agentType/resumeFile 由 Main 从自读持久化取 */
export function resumeCoworkerSession(
  parent: SessionIdentity,
  coworkerId: string,
  name: string,
  agentType: string | undefined,
  resumeFile: string
): { ok: boolean; error?: string } {
  if (!existsSync(resumeFile)) {
    return { ok: false, error: 'coworker 会话文件已丢失，无法恢复' };
  }
  return sendAgentCommand({
    type: 'resume-coworker',
    parent,
    coworkerId,
    name,
    ...(agentType ? { agentType } : {}),
    resumeFile,
  });
}

/** 解雇 worker 直雇 coworker（双形状过渡：无 ChildSessionIdentity，按裸 id + exact 父代下发） */
export function dismissCoworkerSession(
  parent: SessionIdentity,
  coworkerId: string,
  notify = false
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'dismiss-coworker',
    parent,
    coworkerId,
    ...(notify ? { notify: true } : {}),
  });
}

export function appendSessionCustomEntry(
  identity: SessionIdentity,
  entry: AgentSessionCustomEntry
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'append-session-custom-entry',
    identity: { sessionId: identity.sessionId, generation: identity.generation },
    entry,
  });
}

export function sendBrowserResultToSession(
  identity: SessionIdentity | ChildSessionIdentity,
  requestId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: string }
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'browser-result', identity, requestId, ...outcome });
}

export function sendMemoryResultToSession(
  identity: SessionIdentity | ChildSessionIdentity,
  requestId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: string }
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'memory-result', identity, requestId, ...outcome });
}

export function sendDelegationResultToSession(
  identity: SessionIdentity,
  requestId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: string }
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'delegation-result', identity, requestId, ...outcome });
}

export function sendComputerResultToSession(
  identity: SessionIdentity | ChildSessionIdentity,
  requestId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: string }
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'computer-result', identity, requestId, ...outcome });
}

export function sendCapabilityResultToSession(
  child: ChildSessionIdentity,
  turnId: string,
  requestId: string,
  envelope: CapabilityExecutionEnvelope
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'capability-result', child, turnId, requestId, envelope });
}

export function setSessionThinking(
  identity: SessionIdentity,
  level: ThinkingLevel
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'set-thinking', identity, level });
}

export function setSessionReasoning(
  identity: SessionIdentity,
  enabled: boolean,
  level?: ThinkingLevel
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'set-reasoning',
    identity,
    enabled,
    ...(level ? { level } : {}),
  });
}

export function promptSession(
  identity: SessionIdentity,
  text: string,
  images?: AttachedImage[],
  deliveryId?: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'prompt',
    identity,
    text,
    ...(images?.length ? { images } : {}),
    ...(deliveryId ? { deliveryId } : {}),
  });
}

export function steerSession(
  identity: SessionIdentity,
  text: string,
  images?: AttachedImage[],
  deliveryId?: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'steer',
    identity,
    text,
    ...(images?.length ? { images } : {}),
    ...(deliveryId ? { deliveryId } : {}),
  });
}

const pendingCompletions = new Map<
  string,
  { resolve: (text: string) => void; reject: (error: Error) => void }
>();

function settleCompletion(event: AgentWorkerEvent): boolean {
  if (event.type !== 'text-completed' && event.type !== 'text-failed') return false;
  const p = pendingCompletions.get(event.requestId);
  if (!p) return true;
  pendingCompletions.delete(event.requestId);
  if (event.type === 'text-completed') p.resolve(event.text);
  else p.reject(new Error(event.error));
  return true;
}

/** 后台任务（记忆蒸馏）用：worker 不在线时保留任务而不是白跑一次失败 */
export function isAgentWorkerReady(): boolean {
  return Boolean(worker && workerReady);
}

/**
 * 通用一次性文本补全（记忆蒸馏用）：只在 worker 在线时下发，结果按 requestId 回流；
 * worker 不在 / 退出 / 超时都以 reject 收尾，调用方自己决定重试。
 */
export function completeText(input: {
  requestId?: string;
  systemPrompt: string;
  userText: string;
  candidates: SpawnModelConfig[];
  timeoutMs: number;
  maxTokens?: number;
  stream?: boolean;
  reasoning?: ThinkingLevel | 'off';
}): Promise<string> {
  if (!worker || !workerReady) return Promise.reject(new Error('Agent worker is not running.'));
  const requestId = input.requestId?.trim() || randomUUID();
  const { requestId: _requestId, stream, reasoning, ...rest } = input;
  return new Promise<string>((resolve, reject) => {
    // 每个候选各自 timeoutMs，整体再留一点余量做兑底
    const timer = setTimeout(
      () => {
        pendingCompletions.delete(requestId);
        reject(new Error('completion timed out'));
      },
      rest.timeoutMs * rest.candidates.length + 5_000
    );
    pendingCompletions.set(requestId, {
      resolve: (text) => {
        clearTimeout(timer);
        resolve(text);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    const posted = sendAgentCommand({
      type: 'complete-text',
      requestId,
      ...rest,
      ...(stream ? { stream: true as const } : {}),
      ...(reasoning ? { reasoning } : {}),
    });
    if (!posted.ok) {
      pendingCompletions.get(requestId)?.reject(new Error(posted.error ?? 'post failed'));
      pendingCompletions.delete(requestId);
    }
  });
}

const pendingChoices = new Map<
  string,
  { resolve: (probabilities: Record<string, number>) => void; reject: (error: Error) => void }
>();

function settleChoice(event: AgentWorkerEvent): boolean {
  if (event.type !== 'choice-classified' && event.type !== 'choice-failed') return false;
  const p = pendingChoices.get(event.requestId);
  if (!p) return true;
  pendingChoices.delete(event.requestId);
  if (event.type === 'choice-classified') p.resolve(event.probabilities);
  else p.reject(new Error(event.error));
  return true;
}

/**
 * 一次性 pi 分类器 choice 问题（群聊智能选人）：worker 跑 runtime.classify，按 requestId 回流概率。
 * signal 中止时先拒绝等待者再通知 worker 停止；worker 不在 / 退出 / 超时都 reject。
 */
export function classifyChoice(
  input: {
    classifier: VirtualClassifierCredentials;
    state: Record<string, unknown>;
    instructions: string;
    criteria: Record<string, string>;
    timeoutMs: number;
  },
  signal?: AbortSignal
): Promise<Record<string, number>> {
  if (!worker || !workerReady) return Promise.reject(new Error('Agent worker is not running.'));
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      pendingChoices.delete(requestId);
      cleanup();
      reject(new Error('classify timed out'));
    }, input.timeoutMs + 2_000);
    const onAbort = () => {
      if (!pendingChoices.delete(requestId)) return;
      cleanup();
      reject(new Error('aborted'));
      sendAgentCommand({ type: 'abort-classify-choice', requestId });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingChoices.set(requestId, {
      resolve: (probabilities) => {
        cleanup();
        resolve(probabilities);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });
    const posted = sendAgentCommand({ type: 'classify-choice', requestId, ...input });
    if (!posted.ok) {
      pendingChoices.get(requestId)?.reject(new Error(posted.error ?? 'post failed'));
      pendingChoices.delete(requestId);
    }
  });
}

/** 中止一次性补全：先拒绝 Main 侧等待者，再通知 worker 停推理 */
export function abortCompleteText(requestId: string): { ok: boolean; error?: string } {
  const id = requestId.trim();
  if (!id) return { ok: false, error: 'invalid request' };
  const pending = pendingCompletions.get(id);
  if (pending) {
    pendingCompletions.delete(id);
    pending.reject(new Error('aborted'));
  }
  return sendAgentCommand({ type: 'abort-complete-text', requestId: id });
}

/** 标题总结：一次性补全命令，不绑会话身份；worker 按序尝试 candidates，结果经 title-generated / title-failed 回流 */
export function summarizeConversationTitle(
  conversationId: string,
  input: TitleSummaryInput,
  candidates: SpawnModelConfig[]
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'summarize-title', conversationId, input, candidates });
}

export function abortSession(identity: SessionIdentity): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'abort', identity });
}

const RELOAD_TIMEOUT_MS = 10_000;
const pendingReloads = new PendingReloadRegistry({ timeoutMs: RELOAD_TIMEOUT_MS });

/**
 * 手动重读活会话：只在 worker 真正在线时下发，结果按 requestId 回流。
 * worker 未就绪 / 已退出时不入队等待——「已入队」不是「已读到」，直接返回失败让调用方
 * 走离线 safe journal 路径或提示用户。
 */
export function reloadSession(sessionId: string): Promise<SessionReloadResult> {
  if (!worker || !workerReady) {
    return Promise.resolve({ ok: false, error: 'Agent worker is not running.' });
  }
  const requestId = randomUUID();
  const pending = pendingReloads.wait(requestId);
  worker.postMessage({ type: 'reload-session', requestId, sessionId } satisfies AgentCommand);
  return pending;
}

/** release 等待者：sessionId → resolve。parent-ended/worker-exited 到达时唤醒 */
const releaseWaiters = new Map<string, (() => void)[]>();

function resolveReleaseWaiters(event: AgentWorkerEvent): void {
  if (event.type !== 'parent-ended' && event.type !== 'parent-rejected') return;
  const waiters = releaseWaiters.get(event.identity.sessionId);
  if (!waiters) return;
  releaseWaiters.delete(event.identity.sessionId);
  for (const resolve of waiters) resolve();
}

/**
 * 释放父会话（销毁 worker 侧会话树，jsonl 留盘），之后可携新 cwd resume。
 * 必须等到 parent-ended 回流才返回：否则后续 spawn 会和 release 竞态，
 * 老会话还在 map 里被同 generation 短路复用，新 cwd 永远不生效（CDP 实测踩到）。
 */
export function releaseParentSession(
  identity: SessionIdentity
): Promise<{ ok: boolean; error?: string }> {
  const posted = sendAgentCommand({ type: 'release-parent', identity });
  if (!posted.ok) return Promise.resolve(posted);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 超时兕底：不永久挂起调用方；调用方拿到失败后不会继续建 worktree
      const waiters = releaseWaiters.get(identity.sessionId);
      if (waiters) {
        releaseWaiters.set(
          identity.sessionId,
          waiters.filter((w) => w !== done)
        );
      }
      resolve({ ok: false, error: 'release timed out' });
    }, 8000);
    const done = () => {
      clearTimeout(timer);
      resolve({ ok: true });
    };
    releaseWaiters.set(identity.sessionId, [
      ...(releaseWaiters.get(identity.sessionId) ?? []),
      done,
    ]);
  });
}

/** 取消自动重试倒计时（立即落终态失败，不中断正在流式输出的轮） */
export function abortRetrySession(identity: SessionIdentity): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'abort-retry', identity });
}

/** 终态失败后手动续跑：不新增 user 消息，从当前上下文 continue */
export function retrySession(identity: SessionIdentity): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'retry', identity });
}

export function respondApproval(
  identity: SessionIdentity,
  requestId: string,
  decision: ApprovalDecision
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'approval-respond', identity, requestId, decision });
}

export function respondAsk(
  identity: SessionIdentity,
  requestId: string,
  answer: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'ask-respond', identity, requestId, answer });
}

export function compactSession(
  identity: SessionIdentity,
  instructions?: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'compact',
    identity,
    ...(instructions ? { instructions } : {}),
  });
}

export function rewindSession(
  identity: SessionIdentity,
  anchor: string | number,
  restoreFiles?: boolean
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'rewind',
    identity,
    ...(typeof anchor === 'string' ? { entryId: anchor } : { userIndexFromEnd: anchor }),
    ...(restoreFiles ? { restoreFiles } : {}),
  });
}

export function forkSession(
  identity: SessionIdentity,
  targetConversationId: string,
  anchor: { entryId: string } | { userIndexFromEnd: number }
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'fork',
    identity,
    targetConversationId,
    ...('entryId' in anchor
      ? { entryId: anchor.entryId }
      : { userIndexFromEnd: anchor.userIndexFromEnd }),
  });
}

export function stopBackgroundTask(
  identity: SessionIdentity,
  taskId: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'task-stop', identity, taskId });
}

export function backgroundForegroundTool(
  identity: SessionIdentity,
  toolCallId: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'tool-background', identity, toolCallId });
}

export function stopWorkflow(
  identity: SessionIdentity,
  runId: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'workflow-stop', identity, runId });
}

export function stopSubagent(
  identity: SessionIdentity,
  agentId: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'subagent-stop', identity, agentId });
}

export function setSessionApprovalMode(
  identity: SessionIdentity,
  mode: ApprovalMode,
  authenticatedAccountKeys: ReadonlySet<string> = new Set()
): { ok: boolean; error?: string } {
  if (mode === 'assistant') {
    const reviewer = resolveApprovalReviewer(authenticatedAccountKeys);
    if (!reviewer.ok) return reviewer;
    if (!reviewer.selection) {
      return { ok: false, error: 'Select an assistant approval model in Settings first.' };
    }
    pushApprovalReviewer(authenticatedAccountKeys);
  }
  return sendAgentCommand({ type: 'set-approval-mode', identity, mode });
}

export function requestSnapshot(sessionId?: string): { ok: boolean; error?: string } {
  // renderer rehydrate 时就会要快照，而打包版 worker 要等 hydrateShellPath 才 fork；
  // 已 fork 未 spawn 的窗口里 postMessage 也不保证送达。直接拒绝或直发都会让
  // 请求丢失（调用方 void 掉返回值，无重试），会话消息接不回来。
  // 挂起等 spawn 后补发。注意：此处 ok:true 语义是「已入队」而非「已送达」。
  if (!worker || !workerReady) {
    if (!sessionId) snapshotPending = true;
    else if (snapshotPending === false) snapshotPending = sessionId;
    else if (snapshotPending !== sessionId) snapshotPending = true;
    return { ok: true };
  }
  return sendAgentCommand(sessionId ? { type: 'snapshot', sessionId } : { type: 'snapshot' });
}

export function configuredAgentTypes(
  authenticatedAccountKeys: ReadonlySet<string>,
  hasSubagentModels = false,
  plugins?: ResolvedPlugins
): AgentTypeSpawnConfig[] {
  const state = readSettingsState();
  const disabled = new Set(
    Array.isArray(state?.disabledBuiltinAgentTypes)
      ? state.disabledBuiltinAgentTypes.filter((name): name is string => typeof name === 'string')
      : []
  );
  const custom = withPluginAgentTypes(
    Array.isArray(state?.agentTypes) ? state.agentTypes.filter(isAgentTypeEntry) : [],
    state,
    plugins
  );
  // 与 registry 同口径（trim + 小写）：同名 custom 覆盖 builtin
  const customNames = new Set(custom.map((entry) => entry.name.trim().toLowerCase()));
  const builtins = BUILTIN_AGENT_TYPES.filter(
    (type) => !disabled.has(type.name) && !customNames.has(type.name)
  ).map((type) => {
    // 只有配置了允许主 agent 选择的模型时，'agent_pick' 才生效；否则优雅回退到跟随会话（allowModelOverride = false）
    const effectiveMode =
      (type.modelMode ?? 'agent_pick') === 'agent_pick' && hasSubagentModels
        ? 'agent_pick'
        : 'follow';
    return {
      name: type.name,
      description: type.description,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
      ...(type.writeScope ? { writeScope: [...type.writeScope] } : {}),
      allowModelOverride: effectiveMode === 'agent_pick',
    };
  });
  const customs = custom.map((entry): AgentTypeSpawnConfig => {
    const resources = resolveAgentTypeResources(entry);
    const mode = entry.modelMode ?? (entry.providerId && entry.modelId ? 'fixed' : 'follow');
    const effectiveMode = mode === 'agent_pick' && !hasSubagentModels ? 'follow' : mode;
    const bound =
      effectiveMode === 'fixed' && entry.providerId && entry.modelId
        ? resolveModelSelection(entry.providerId, entry.modelId, authenticatedAccountKeys)
        : null;
    return {
      name: entry.name,
      description: entry.description,
      systemPrompt: entry.systemPrompt,
      tools: entry.tools,
      ...(entry.writeScope ? { writeScope: [...entry.writeScope] } : {}),
      allowModelOverride: effectiveMode === 'agent_pick',
      ...(resources.ok && resources.skillPaths.length > 0
        ? { skillPaths: [...resources.skillPaths] }
        : {}),
      ...(resources.ok && resources.mcpServers.length > 0
        ? { mcpServers: [...resources.mcpServers] }
        : {}),
      ...(bound?.ok ? { model: bound.selection.config } : {}),
      // 非法值不透传（与 pickSubagentModelRefs 同口径）
      ...(MODEL_REASONING_OVERRIDES.includes(entry.reasoning as ModelReasoningOverride)
        ? { reasoning: entry.reasoning }
        : {}),
      ...(MODEL_THINKING_LEVEL_OVERRIDES.includes(entry.thinkingLevel as ModelThinkingLevelOverride)
        ? { thinkingLevel: entry.thinkingLevel }
        : {}),
    };
  });
  const members = visibleMemberAgentTypes(memberAgentTypes(), custom).map(
    (entry): AgentTypeSpawnConfig => {
      const resources = resolveAgentTypeResources(entry);
      const bound =
        entry.providerId && entry.modelId
          ? resolveModelSelection(entry.providerId, entry.modelId, authenticatedAccountKeys)
          : null;
      return {
        name: entry.typeKey,
        description: memberSpawnDescription(entry),
        systemPrompt: entry.systemPrompt,
        tools: entry.tools,
        allowModelOverride: false,
        ...(resources.ok && resources.skillPaths.length > 0
          ? { skillPaths: [...resources.skillPaths] }
          : {}),
        ...(resources.ok && resources.mcpServers.length > 0
          ? { mcpServers: [...resources.mcpServers] }
          : {}),
        ...(bound?.ok ? { model: bound.selection.config } : {}),
        ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
        ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
      };
    }
  );
  return [...builtins, ...customs, ...members];
}

/** 设置页「允许子代理指定模型」列表 → 解析凭证后随 spawn-parent 下发（开关关闭/不可用静默跳过） */
function configuredSubagentModels(
  authenticatedAccountKeys: ReadonlySet<string>
): SubagentModelOption[] {
  const state = readSettingsState();
  if (state?.subagentModelsEnabled !== true) return [];
  const entries = Array.isArray(state.subagentModels)
    ? state.subagentModels.filter(isSubagentModelEntry)
    : [];
  const options: SubagentModelOption[] = [];
  for (const ref of pickSubagentModelRefs(entries, providersFromSettings())) {
    const resolved = resolveModelSelection(ref.providerId, ref.modelId, authenticatedAccountKeys);
    if (resolved.ok) {
      options.push({
        name: ref.name,
        // 条目级推理覆盖赢过模型行覆盖；缺省保留行级/跟随语义
        config: {
          ...resolved.selection.config,
          ...(ref.reasoning ? { reasoning: ref.reasoning } : {}),
          ...(ref.thinkingLevel ? { thinkingLevel: ref.thinkingLevel } : {}),
        },
        ...(ref.description ? { description: ref.description } : {}),
      });
    }
  }
  return options;
}

export function resolveSubagentModelSelection(
  name: string,
  authenticatedAccountKeys: ReadonlySet<string>
): { ok: true; selection: ResolvedModelSelection } | { ok: false; error: string } {
  const selected = configuredSubagentModels(authenticatedAccountKeys).find(
    (entry) => entry.name === name
  );
  if (!selected) return { ok: false, error: `Subagent model is unavailable: ${name}` };
  return {
    ok: true,
    selection: {
      ref: {
        providerId: selected.config.settingsProviderId,
        modelId: selected.config.modelId,
      },
      runtimeRef: {
        providerId: selected.config.oauthAccountKey ?? selected.config.settingsProviderId,
        modelId: selected.config.modelId,
      },
      config: selected.config,
    },
  };
}

function isSubagentModelEntry(value: unknown): value is SubagentModelEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<SubagentModelEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.providerId === 'string' &&
    typeof entry.modelId === 'string' &&
    typeof entry.description === 'string'
  );
}

function resolveAgentTypeResources(
  definition: Pick<RuntimeAgentType, 'skillIds' | 'mcpServerIds' | 'pluginSkillPaths'>
):
  | { ok: true; skillPaths: readonly string[]; mcpServers: readonly McpServerSpawnConfig[] }
  | { ok: false; error: string } {
  const state = readSettingsState();
  const skills = Array.isArray(state?.skills) ? state.skills.filter(isSkillEntry) : [];
  const servers = Array.isArray(state?.mcpServers) ? state.mcpServers.filter(isMcpServerEntry) : [];
  const skillPaths = (definition.skillIds ?? []).map(
    (id) => skills.find((skill) => skill.id === id)?.path
  );
  if (skillPaths.some((entry) => !entry)) {
    return { ok: false, error: 'Agent type references an unavailable skill.' };
  }
  const mcpEntries = (definition.mcpServerIds ?? []).map((id) =>
    servers.find((server) => server.id === id)
  );
  if (mcpEntries.some((entry) => !entry)) {
    return { ok: false, error: 'Agent type references an unavailable MCP server.' };
  }
  return {
    ok: true,
    skillPaths: [...(skillPaths as string[]), ...(definition.pluginSkillPaths ?? [])],
    mcpServers: mcpEntries.map((entry) => toMcpSpawnConfig(entry!)),
  };
}

function resolvePreset(presetId?: string): Preset | undefined {
  if (!presetId || presetId === DEFAULT_PRESET_ID) return undefined;
  const state = readSettingsState();
  const presets = Array.isArray(state?.presets) ? (state.presets as Preset[]) : [];
  return presets.find((preset) => preset?.id === presetId);
}

function enabledSkillPaths(preset?: Preset): string[] {
  const state = readSettingsState();
  const skills = Array.isArray(state?.skills) ? state.skills.filter(isSkillEntry) : [];
  const picked = preset
    ? skills.filter((skill) => preset.skillIds.includes(skill.id))
    : skills.filter((skill) => skill.enabled !== false);
  return picked.map((skill) => skill.path);
}

function enabledMcpServers(preset?: Preset): McpServerSpawnConfig[] {
  const state = readSettingsState();
  const servers = Array.isArray(state?.mcpServers) ? state.mcpServers.filter(isMcpServerEntry) : [];
  const picked = preset
    ? servers.filter((server) => preset.mcpServerIds.includes(server.id))
    : servers.filter((server) => server.enabled !== false);
  return picked.map((server) => toSessionMcpConfig(server));
}

function mcpServerById(serverId: string): McpServerSpawnConfig[] {
  const state = readSettingsState();
  const servers = Array.isArray(state?.mcpServers) ? state.mcpServers.filter(isMcpServerEntry) : [];
  const entry = servers.find((server) => server.id === serverId);
  return entry ? [toMcpSpawnConfig(entry)] : [];
}

function toMcpSpawnConfig(server: McpServerEntry): McpServerSpawnConfig {
  const oauth = server.transport === 'stdio' ? undefined : getMcpOAuthStore().tokens(server.id);
  return {
    ...(server.id ? { id: server.id } : {}),
    name: server.name,
    ...(server.description?.trim() ? { description: server.description.trim() } : {}),
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(oauth ? { oauth } : {}),
    ...mcpTimeoutsForSpawn(server),
  };
}

/** 会话级配置才带 loadMode：typed profile 与定向预热始终直接连接 */
export function toSessionMcpConfig(
  server: McpServerEntry,
  catalog = getMcpToolCatalog()
): McpServerSpawnConfig {
  const config = toMcpSpawnConfig(server);
  if (server.loadMode !== 'deferred') return config;
  const toolNames = catalog.names(server);
  return { ...config, loadMode: 'deferred', ...(toolNames ? { toolNames } : {}) };
}

function asModelRef(value: unknown): DefaultModelRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { providerId?: unknown; modelId?: unknown };
  return typeof candidate.providerId === 'string' &&
    candidate.providerId.trim() &&
    typeof candidate.modelId === 'string' &&
    candidate.modelId.trim()
    ? { providerId: candidate.providerId, modelId: candidate.modelId }
    : null;
}

export function resolveApprovalReviewer(
  authenticatedAccountKeys: ReadonlySet<string>
): ModelSelectionResult | { ok: true; selection: null } {
  const ref = asModelRef(readSettingsState()?.approvalReviewer);
  if (!ref) return { ok: true, selection: null };
  return resolveModelSelection(ref.providerId, ref.modelId, authenticatedAccountKeys);
}

export function pushApprovalReviewer(authenticatedAccountKeys?: ReadonlySet<string>): void {
  if (!worker || !workerReady) return;
  const keys = authenticatedAccountKeys ?? new Set<string>();
  const resolved = resolveApprovalReviewer(keys);
  const model = resolved.ok ? resolved.selection?.config : undefined;
  worker.postMessage({
    type: 'set-approval-reviewer',
    ...(model ? { model } : {}),
  } satisfies AgentCommand);
}

export function pushMaxActiveCoworkers(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-max-active-coworkers',
    limit: normalizeMaxActiveCoworkers(readSettingsState()?.maxActiveCoworkers),
  } satisfies AgentCommand);
}

export function pushDisabledWorkflowPresets(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-disabled-workflow-presets',
    ids: parseDisabledWorkflowPresets(readSettingsState()?.disabledWorkflowPresets),
  } satisfies AgentCommand);
}

export function readSettingsState(): Record<string, unknown> | undefined {
  return persistedSettingsState(readSettings()?.['enso-settings']);
}

function virtualModelsFromSettings(): VirtualModelEntry[] {
  return parseVirtualModels(readSettingsState()?.virtualModels);
}

function providersFromSettings(): ModelProvider[] {
  const providers = readSettingsState()?.providers;
  return Array.isArray(providers)
    ? providers.filter(
        (provider): provider is ModelProvider =>
          Boolean(provider) &&
          typeof provider === 'object' &&
          typeof (provider as ModelProvider).id === 'string'
      )
    : [];
}

export function modelRefForSpawnConfig(config: SpawnModelConfig): ModelRef {
  if (
    'settingsProviderId' in config &&
    typeof config.settingsProviderId === 'string' &&
    config.settingsProviderId
  ) {
    return { providerId: config.settingsProviderId, modelId: config.modelId };
  }
  throw new Error('Spawn model is missing its settings provider identity.');
}

function spawnModelConfig(
  provider: ModelProvider,
  modelId: string
): SpawnModelConfig & { settingsProviderId: string } {
  if (provider.oauthAccountPool !== undefined && !isOauthAccountPool(provider))
    throw new Error('Invalid ChatGPT OAuth pool configuration.');
  const entry = provider.models.find((model: ModelEntry) => model.id === modelId);
  return {
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelId,
    settingsProviderId: provider.id,
    ...(provider.oauthAccountKey ? { oauthAccountKey: provider.oauthAccountKey } : {}),
    ...(isOauthAccountPool(provider) ? { oauthAccountPool: provider.oauthAccountPool } : {}),
    ...(!provider.oauthAccountKey ? pickModelCapabilityOverrides(entry) : {}),
  };
}

function isAgentTypeEntry(value: unknown): value is AgentTypeEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<AgentTypeEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.description === 'string' &&
    typeof entry.systemPrompt === 'string' &&
    (entry.tools === 'all' || entry.tools === 'readonly') &&
    (entry.writeScope === undefined ||
      (Array.isArray(entry.writeScope) &&
        entry.writeScope.every((glob) => typeof glob === 'string' && glob.trim() !== '')))
  );
}

function isSkillEntry(value: unknown): value is SkillEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<SkillEntry>;
  return typeof entry.id === 'string' && typeof entry.path === 'string';
}

function isMcpServerEntry(value: unknown): value is McpServerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<McpServerEntry>;
  return (
    // 空 id 会让状态落到 serverName 键上，同名 server 互相覆盖
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.name === 'string' &&
    (entry.transport === 'stdio' || entry.transport === 'http' || entry.transport === 'sse')
  );
}

function settingsRevision(state: Record<string, unknown> | undefined): number {
  const serialized = JSON.stringify({
    disabledBuiltinAgentTypes: state?.disabledBuiltinAgentTypes ?? [],
    agentTypes: state?.agentTypes ?? [],
  });
  let hash = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = (hash * 31 + serialized.charCodeAt(index)) >>> 0;
  }
  return hash;
}

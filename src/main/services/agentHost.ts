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
} from '@shared/builtinAgents';
import type { CapabilityExecutionEnvelope } from '@shared/capabilities/types';
import {
  type DefaultModelRef,
  type ModelCredentialContext,
  modelUsability,
} from '@shared/defaultModel';
import { mcpTimeoutsForSpawn } from '@shared/mcpTimeout';
import { pickModelCapabilityOverrides } from '@shared/modelCatalog';
import { proxyEnvPatchFromEnv } from '@shared/proxy';
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
  SpawnModelConfig,
  SubagentModelOption,
  ThinkingLevel,
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
import type { ModelEntry, ModelProvider } from '@shared/types/llm';
import type { AgentDispatchTask } from '@shared/types/mentions';
import { parseWindowsLocalShell } from '@shared/windowsLocalShell';
import { app, type UtilityProcess, utilityProcess } from 'electron';
import { ENSO_SYSTEM_PROMPT } from '../../agent/ensoPrompt';
import agentWorkerPath from '../../agent/index?modulePath';
import { readSettings } from '../ipc/settings';
import { agentCommandDispatch } from './agentCommandDispatch';
import { resolveGlobalInstruction } from './instructionStore';
import { getMcpOAuthStore } from './mcpOAuthStore';
import { pickSubagentModelRefs } from './subagentModels';
import { titleModelCandidates } from './titleSummary';

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
    }
  | { ok: false; error: string };

/** 管理 agent worker（utilityProcess）的生命周期与命令下发。故障域 A：一个 worker 装全部会话。 */
let worker: UtilityProcess | null = null;
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

export function startAgentWorker(): void {
  if (worker) return;
  const child = utilityProcess.fork(agentWorkerPath, [], {
    serviceName: 'enso-agent-worker',
    env: {
      ...process.env,
      ENSO_AGENT_DATA_DIR: path.join(app.getPath('userData'), 'agent'),
      PI_CODING_AGENT_DIR: path.join(app.getPath('userData'), 'agent', 'pi-agent'),
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
  });
  child.on('message', (raw) => {
    const event = parseAgentWorkerEvent(raw);
    if (event) {
      resolveReleaseWaiters(event);
      resolveMemoryPipelineWaiters(event);
      onEvent?.(event);
    }
  });
  child.on('exit', () => {
    if (worker === child) {
      worker = null;
      workerReady = false;
      workerExited = true;
    }
    onEvent?.({ type: 'worker-exited' });
  });
}

export function stopAgentWorker(): void {
  worker?.kill();
  worker = null;
  workerReady = false;
  snapshotPending = false;
  commandsPending = [];
  workerExited = false;
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

export function sendAgentCommand(command: AgentCommand): { ok: boolean; error?: string } {
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

export function agentTypeRegistrySnapshot(): AgentTypeRegistrySnapshot {
  const state = readSettingsState();
  const disabledBuiltinAgentTypes = Array.isArray(state?.disabledBuiltinAgentTypes)
    ? state.disabledBuiltinAgentTypes.filter((name): name is string => typeof name === 'string')
    : [];
  const customAgentTypes = Array.isArray(state?.agentTypes)
    ? state.agentTypes.filter(isAgentTypeEntry)
    : [];
  return buildAgentTypeRegistrySnapshot({
    revision: settingsRevision(state),
    disabledBuiltinAgentTypes,
    customAgentTypes,
  });
}

export function resolveModelSelection(
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

export function resolveAgentTypeSpawnConfig(
  typeKey: AgentTypeKey,
  parentModel: ResolvedModelSelection,
  authenticatedAccountKeys: ReadonlySet<string>
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
    };
  }

  const state = readSettingsState();
  let definition: Omit<AgentTypeEntry, 'id'> | AgentTypeEntry | undefined;
  if (typeKey.startsWith('builtin:')) {
    const name = typeKey.slice('builtin:'.length);
    definition = BUILTIN_AGENT_TYPES.find((entry) => entry.name === name);
  } else {
    const id = typeKey.slice('custom:'.length);
    definition = Array.isArray(state?.agentTypes)
      ? state.agentTypes.filter(isAgentTypeEntry).find((entry) => entry.id === id)
      : undefined;
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
      skillPaths: resources.skillPaths,
      skillBindingIds: resources.skillPaths.map(() => randomUUID()),
      mcpServers: resources.mcpServers,
      mcpBindingIds: resources.mcpServers.map(() => randomUUID()),
      systemPromptHash: createHash('sha256').update(definition.systemPrompt).digest('hex'),
    },
    expectedModel: selectedModel.ref,
    expectedToolIds:
      definition.tools === 'readonly'
        ? ['read', 'grep', 'find', 'ls', 'message_main_agent', 'message_coworker']
        : [
            'read',
            'grep',
            'find',
            'ls',
            'bash',
            'edit',
            'write',
            'message_main_agent',
            'message_coworker',
          ],
  };
}

export function spawnSession(
  identity: SessionIdentity,
  request: AgentSpawnRequest,
  authenticatedAccountKeys: ReadonlySet<string>,
  /** 由 main 从项目权威派生(渲染层不可伪造):ssh 项目的会话工具走远端执行 */
  remote?: AgentRemoteConfig
): { ok: boolean; error?: string } {
  if (request.resumeFile && !existsSync(request.resumeFile)) {
    return { ok: false, error: '会话文件已丢失，无法恢复历史' };
  }
  const resolved = resolveModelSelection(
    request.providerId,
    request.modelId,
    authenticatedAccountKeys
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
  const preset = resolvePreset(request.presetId);
  const instruction = resolveGlobalInstruction(
    preset ? { instructionId: preset.instructionId } : undefined
  );
  const skillPaths = enabledSkillPaths(preset);
  const mcpServers = enabledMcpServers(preset);
  const subagentModels = configuredSubagentModels(authenticatedAccountKeys);
  const agentTypes = configuredAgentTypes(authenticatedAccountKeys, subagentModels.length > 0);
  const state = readSettingsState();
  const disabledTools = Array.isArray(state?.disabledBuiltinTools)
    ? state.disabledBuiltinTools.filter((id): id is string => typeof id === 'string')
    : [];
  const loadHarnessAssets = state?.loadHarnessAssets === true;
  const windowsLocalShell = parseWindowsLocalShell(state?.windowsLocalShell);
  const exploreFoldEnabled = state?.exploreFoldEnabled === true;
  const localMemoryEnabled = state?.localMemoryEnabled !== false;
  const phase2Ref = titleModelCandidates(state ?? undefined, {
    providerId: request.providerId,
    modelId: request.modelId,
  })[0];
  const phase2Resolved =
    phase2Ref &&
    (phase2Ref.providerId !== request.providerId || phase2Ref.modelId !== request.modelId)
      ? resolveModelSelection(phase2Ref.providerId, phase2Ref.modelId, authenticatedAccountKeys)
      : undefined;
  const memoryPhase2Model = phase2Resolved?.ok ? phase2Resolved.selection.config : undefined;
  // worker 崩溃/退出后不自动拉起的话，所有会话都只能靠重启 app 恢复；在 spawn 入口按需重建
  if (!worker && workerExited) startAgentWorker();
  return sendAgentCommand({
    type: 'spawn-parent',
    identity,
    cwd: request.cwd,
    model: resolved.selection.config,
    ...(request.resumeFile ? { resumeFile: request.resumeFile } : {}),
    ...(request.reasoningEnabled ? { reasoningEnabled: true } : {}),
    ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
    ...(preset || request.loadLocalSkills === false ? { loadLocalSkills: false } : {}),
    ...(loadHarnessAssets ? { loadHarnessAssets: true } : {}),
    ...(windowsLocalShell !== 'auto' ? { windowsLocalShell } : {}),
    ...(exploreFoldEnabled ? { exploreFoldEnabled: true } : {}),
    ...(localMemoryEnabled ? {} : { localMemoryEnabled: false }),
    ...(skillPaths.length > 0 ? { skillPaths } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(request.approvalMode ? { approvalMode: request.approvalMode } : {}),
    ...(approvalReviewerConfig ? { approvalReviewer: approvalReviewerConfig } : {}),
    ...(memoryPhase2Model ? { memoryPhase2Model } : {}),
    ...(agentTypes.length > 0 ? { agentTypes } : {}),
    ...(subagentModels.length > 0 ? { subagentModels } : {}),
    ...(disabledTools.length > 0 ? { disabledTools } : {}),
    ...(instruction ? { instruction } : {}),
    ...(remote ? { remote } : {}),
  });
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
  const resolved = resolveModelSelection(providerId, modelId, authenticatedAccountKeys);
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
  images?: AttachedImage[]
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'prompt',
    identity,
    text,
    ...(images?.length ? { images } : {}),
  });
}

export function steerSession(
  identity: SessionIdentity,
  text: string,
  images?: AttachedImage[]
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'steer',
    identity,
    text,
    ...(images?.length ? { images } : {}),
  });
}

/** 标题总结：一次性补全命令，不绑会话身份；结果经 title-generated 事件回流 */
export function summarizeConversationTitle(
  conversationId: string,
  text: string,
  model: SpawnModelConfig
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'summarize-title', conversationId, text, model });
}

const memoryPipelineWaiters = new Map<
  string,
  (event: Extract<AgentWorkerEvent, { type: 'memory-pipeline-done' }>) => void
>();

function resolveMemoryPipelineWaiters(event: AgentWorkerEvent): void {
  if (event.type !== 'memory-pipeline-done') return;
  const resolve = memoryPipelineWaiters.get(event.requestId);
  if (!resolve) return;
  memoryPipelineWaiters.delete(event.requestId);
  resolve(event);
}

export function requestMemoryPipeline(opts: {
  requestId: string;
  cwd: string;
  currentThreadId?: string;
  model: SpawnModelConfig;
  phase2Model?: SpawnModelConfig;
}): Promise<{ ok: boolean; error?: string; stage1Claimed?: number; phase2Ran?: boolean }> {
  if (!worker) startAgentWorker();
  const posted = sendAgentCommand({
    type: 'run-memory-pipeline',
    requestId: opts.requestId,
    cwd: opts.cwd,
    ...(opts.currentThreadId ? { currentThreadId: opts.currentThreadId } : {}),
    model: opts.model,
    ...(opts.phase2Model ? { phase2Model: opts.phase2Model } : {}),
  });
  if (!posted.ok)
    return Promise.resolve({ ok: false, error: posted.error ?? 'worker unavailable' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      memoryPipelineWaiters.delete(opts.requestId);
      resolve({ ok: false, error: 'Memory merge timed out.' });
    }, 200_000);
    memoryPipelineWaiters.set(opts.requestId, (event) => {
      clearTimeout(timer);
      resolve(
        event.ok
          ? { ok: true, stage1Claimed: event.stage1Claimed, phase2Ran: event.phase2Ran }
          : { ok: false, error: event.error ?? 'Memory merge failed.' }
      );
    });
  });
}

export function abortSession(identity: SessionIdentity): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'abort', identity });
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
  userIndexFromEnd: number,
  restoreFiles?: boolean
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'rewind',
    identity,
    userIndexFromEnd,
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

function configuredAgentTypes(
  authenticatedAccountKeys: ReadonlySet<string>,
  hasSubagentModels = false
): AgentTypeSpawnConfig[] {
  const state = readSettingsState();
  const disabled = new Set(
    Array.isArray(state?.disabledBuiltinAgentTypes)
      ? state.disabledBuiltinAgentTypes.filter((name): name is string => typeof name === 'string')
      : []
  );
  const custom = Array.isArray(state?.agentTypes) ? state.agentTypes.filter(isAgentTypeEntry) : [];
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
    };
  });
  return [...builtins, ...customs];
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
  definition: Pick<AgentTypeEntry, 'skillIds' | 'mcpServerIds'>
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
    skillPaths: skillPaths as string[],
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
  return picked.map(toMcpSpawnConfig);
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
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(oauth ? { oauth } : {}),
    ...mcpTimeoutsForSpawn(server),
  };
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

export function readSettingsState(): Record<string, unknown> | undefined {
  const settings = readSettings();
  return (settings?.['enso-settings'] as { state?: Record<string, unknown> } | undefined)?.state;
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
  const entry = provider.models.find((model: ModelEntry) => model.id === modelId);
  return {
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelId,
    settingsProviderId: provider.id,
    ...(provider.oauthAccountKey ? { oauthAccountKey: provider.oauthAccountKey } : {}),
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

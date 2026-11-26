import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { agentWorkerPath, app, resourcesPath, utilityProcess, type WorkerProcess } from '@platform';
import { describeAgentWorkerExit } from '@shared/agentWorkerExit';
import { APP_LOGGING_ENV, isAppLoggingEnabled } from '@shared/appLogFile';
import {
  type ApprovalAllowThreshold,
  DEFAULT_APPROVAL_ALLOW_THRESHOLD,
  parseApprovalAllowThreshold,
} from '@shared/approvalReviewRecord';
import { normalizeAutoRetryLimit } from '@shared/autoRetry';
import {
  type AgentTypeKey,
  type AgentTypeRegistrySnapshot,
  buildAgentTypeRegistrySnapshot,
  type ChildSessionIdentity,
  isReservedAgentTypeName,
  type SessionIdentity,
  visibleMemberAgentTypes,
} from '@shared/builtinAgents';
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
import { ELEVATE_ASKPASS_ENV } from '@shared/elevation';
import { presetOverlay } from '@shared/extensionPlugins/preset';
import { PLUGIN_INJECT_WIRE_MAX_CHARS } from '@shared/extensionPlugins/protocol';
import {
  parseRestartCheckpoint,
  RESTART_CHECKPOINT_ENV,
  RESTART_CHECKPOINT_FILE,
  type RestartCheckpoint,
} from '@shared/gracefulRestart';
import { resolveImageGenerationConfig } from '@shared/imageGeneration';
import { normalizeMaxActiveCoworkers } from '@shared/maxActiveCoworkers';
import { mcpHeaders } from '@shared/mcpConfig';
import { mcpTimeoutsForSpawn } from '@shared/mcpTimeout';
import { pickModelCapabilityOverrides } from '@shared/modelCatalog';
import { materializeProviders } from '@shared/modelDirectory';
import { eligibleOauthPoolAccountKeys, isOauthAccountPool } from '@shared/oauthAccountPool';
import { ensureAccountProvider } from '@shared/piAccounts';
import { parsePrivacyMaskSettings } from '@shared/privacyMask/settings';
import { isClassifierOnlyProvider } from '@shared/providerCatalog';
import { parseProviderHeaders } from '@shared/providers/providerHeaders';
import { providerKeyFor } from '@shared/providers/providerKey';
import { parseProviderProxy } from '@shared/providers/providerProxy';
import { proxyEnvPatchFromEnv } from '@shared/proxy';
import { reminderReviveDelay } from '@shared/reminders';
import { appUserImageDirs } from '@shared/secretary/imageView';
import {
  SECRETARY_ALWAYS_ENABLED_TOOLS,
  SECRETARY_FORCED_DISABLED_TOOLS,
} from '@shared/secretary/tools';
import { resolveShellLimits, type ShellLimits } from '@shared/shellLimits';
import { parseSmartCompactMode } from '@shared/smartCompactMode';
import {
  type AgentCommand,
  type AgentRemoteConfig,
  type AgentSessionCustomEntry,
  type AgentSpawnRequest,
  type AgentTypeSpawnConfig,
  type AgentWorkerEvent,
  type ApprovalDecision,
  type ApprovalMode,
  type AttachedImage,
  type McpOAuthRefreshResult,
  type McpServerSpawnConfig,
  type ModelRef,
  parseAgentCommand,
  parseAgentWorkerEvent,
  type ResolvedAgentTypeSpawnConfig,
  type RestartReplyProgress,
  type SessionReloadResult,
  type SpawnModelConfig,
  type SubagentModelOption,
  type ThinkingLevel,
  type TitleSummaryInput,
  type VirtualClassifierCredentials,
  type VirtualSpawnClassifier,
  type WorkerCustomProvider,
  type WorkerExitedEvent,
  type WorkerSwappedEvent,
} from '@shared/types/agent';
import { THINKING_LEVELS } from '@shared/types/agentConstants';
import {
  type AgentTypeEntry,
  BUILTIN_AGENT_TYPES,
  DEFAULT_PRESET_ID,
  type McpServerEntry,
  type Preset,
  type SkillEntry,
  type SubagentModelEntry,
} from '@shared/types/assets';
import {
  persistedSettingsState,
  projectDisabledBuiltinTools,
  resolveDisabledBuiltinTools,
} from '@shared/types/builtinTools';
import { resolveEditMode } from '@shared/types/editMode';
import type { RestartBlocker, RestartWaitReason } from '@shared/types/ipc';
import {
  MODEL_REASONING_OVERRIDES,
  MODEL_THINKING_LEVEL_OVERRIDES,
  type ModelEntry,
  type ModelProvider,
  type ModelReasoningOverride,
  type ModelThinkingLevelOverride,
} from '@shared/types/llm';
import type { AgentDispatchTask } from '@shared/types/mentions';
import { projectTrustedCode } from '@shared/types/project';
import type { SecretaryToolDescriptor } from '@shared/types/secretary';
import { parseDisabledWorkflowPresets } from '@shared/types/workflow';
import {
  canBeVirtualMember,
  classifierBaseUrlFor,
  classifierProviderFor,
  directMemberRef,
  findVirtualModel,
  isVirtualRef,
  parseVirtualModels,
  VIRTUAL_PROVIDER_ID,
  type VirtualClassifierConfig,
  type VirtualModelEntry,
} from '@shared/virtualModels';
import { parseWebSearchChain, type WebSearchChainEntry } from '@shared/webSearchChain';
import { parseWindowsLocalShell } from '@shared/windowsLocalShell';
import { MCP_SERVER_REGISTRY_DIR, sweepOrphanMcpServers } from '../../agent/mcpStdio';
import { readSettings } from '../ipc/settings';
import { agentCommandDispatch } from './agentCommandDispatch';
import {
  QUIT_REPLY_IDLE_MS,
  QUIT_REPLY_WAIT_CAP_MS,
  QUIT_REPLY_WAIT_FLOOR_MS,
  QUIT_TOOL_WAIT_LIMIT_MS,
  replyWaitDeadline,
} from './agentQuitLimits';
import {
  AGENT_WORKER_SERVICE_NAME,
  appendAgentWorkerExitLog,
  createOutputTail,
  isAgentWorkerGone,
  takeAgentWorkerCrash,
} from './agentWorkerExit';
import { backgroundTaskStates } from './backgroundTaskTracker';
import { type MemberAgentType, memberSpawnDescription } from './bots/botAgentType';
import { BuiltinToolScopes, sessionDisabledTools, withoutKeepEnabled } from './builtinToolScopes';
import { isComputerPlatformSupported } from './computer/support';
import { DCG_VERSION, dcgRoot, installedDcgPath } from './dcgBinary';
import { activeDcgExemptRules } from './dcgRuleMemory';
import { ensureElevationServer } from './elevation';
import {
  getExtensionPlugins,
  setPluginMcpBridge,
  setPluginSessionBridge,
} from './extensionPlugins';
import { PluginAgentRuns } from './extensionPlugins/agentRuns';
import type {
  PluginInjectDeliveryDecision,
  PluginInjectPrepareInput,
} from './extensionPlugins/injectTrust';
import { PluginMcpRequests } from './extensionPlugins/mcpRequests';
import {
  type GracefulRestartRequest,
  GracefulWorkerRestart,
  type RestartSettingsSnapshot,
} from './gracefulWorkerRestart';
import { resolveGlobalInstruction } from './instructionStore';
import { refreshMcpOAuthAccess } from './mcpOAuthRefresh';
import { getMcpOAuthStore } from './mcpOAuthStore';
import { getMcpToolCatalog } from './mcpToolCatalog';
import { getModelDirectorySnapshot, onModelDirectoryChanged } from './modelDirectory';
import { OAUTH_POOL_EXHAUSTED } from './oauthAccountPool';
import {
  getOauthQuotaCoordinator,
  getRuntime as getOauthRuntime,
  readStoredOauthCredentialKeys,
} from './oauthProviders';
import { PendingReloadRegistry } from './pendingReloads';
import {
  type NativePluginAgentDef,
  type RuntimeAgentType,
  withPluginAgentTypes,
} from './pluginRuntime';
import { recordPrivacyMaskLedger } from './privacyMask';
import { killAndWaitExit } from './processExit';
import {
  buildRestartManifest,
  type RestartExitReason,
  restartManifestPath,
  writeRestartManifest,
} from './restartManifest';
import { bundledRtkPath } from './rtkBinary';
import { readAllSessionReminders } from './sessionReminders';
import { pickSubagentModelRefs, type SubagentModelRef } from './subagentModels';
import { readStoredSystemPrompt } from './systemPromptStore';
import { titleModelCandidates } from './titleSummary';
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
let worker: WorkerProcess | null = null;

/**
 * worker 每次请求都向 Main 选号。账号成员、启用状态、模型目录和真实 OAuth 存储实时核验，失败原因只影响该账号的有限窗口。
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
let onEvent: ((event: AgentWorkerEvent | WorkerExitedEvent | WorkerSwappedEvent) => void) | null =
  null;
/** worker 就绪前到达的快照请求，spawn 后补发。true = 全量，string = 单会话。 */
let snapshotPending: false | true | string = false;
/** worker 已 fork 未 spawn 窗口内到达的命令：postMessage 不保证送达，spawn 后按序补发 */
let commandsPending: AgentCommand[] = [];
/** worker 曾启动后退出：spawn 时可按需重建（首次启动前不行，要等 env/PATH 探测） */
let workerExited = false;
/**
 * 应用退出已停掉 worker：之后到达的命令不再拉起新 worker。否则新 worker 会认回刚交出的后台命令，
 * 随应用退出又停掉，交接清单就此用掉，新版本里任务凭空消失（2026-11-23 更新重启现场）
 */
let quitStopped = false;
/** worker 意外退出后为挂着的提醒拉起它：提醒定时器在 worker 里，没有 worker 就没人到点叫醒 */
let reminderRevive: ReturnType<typeof setTimeout> | undefined;
const gracefulRestart = new GracefulWorkerRestart<WorkerProcess>();
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
  listener: (event: AgentWorkerEvent | WorkerExitedEvent | WorkerSwappedEvent) => void
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

/** worker 没来得及收尾的 stdio MCP server（被强杀、随应用被直接结束）：按 worker 的登记清扫 */
function sweepMcpServers(exitedWorker?: number): void {
  try {
    sweepOrphanMcpServers(path.join(agentDataDir(), MCP_SERVER_REGISTRY_DIR), exitedWorker);
  } catch (error) {
    console.error('[agent] sweep MCP servers failed:', error);
  }
}

export function startAgentWorker(options: { restartCheckpointFile?: string } = {}): void {
  if (worker || quitStopped) return;
  clearTimeout(reminderRevive);
  reminderRevive = undefined;
  sweepMcpServers();
  const askpass = ensureElevationServer();
  const child = utilityProcess.fork(agentWorkerPath, [], {
    serviceName: AGENT_WORKER_SERVICE_NAME,
    stdio: 'pipe',
    env: {
      ...process.env,
      ...(askpass ? { [ELEVATE_ASKPASS_ENV]: askpass } : {}),
      ...(options.restartCheckpointFile
        ? { [RESTART_CHECKPOINT_ENV]: options.restartCheckpointFile }
        : {}),
      [APP_LOGGING_ENV]: isAppLoggingEnabled() ? '1' : '0',
      ENSO_AGENT_DATA_DIR: agentDataDir(),
      // 编码会话的 image_view 白名单：应用存放用户图片的目录（bot-chats/<chatId>/media）
      ENSO_USER_IMAGE_DIRS: appUserImageDirs(app.getPath('userData')).join(path.delimiter),
      PI_CODING_AGENT_DIR: path.join(app.getPath('userData'), 'agent', 'pi-agent'),
      ENSO_MODELS_DEV_CACHE: path.join(app.getPath('userData'), 'models-dev-cache.json'),
      ENSO_RTK_PATH: bundledRtkPath({
        packaged: app.isPackaged,
        resourcesPath,
        appPath: app.getAppPath(),
        platform: process.platform,
        arch: process.arch,
      }),
    },
  });
  worker = child;
  workerExited = false;
  let childPid: number | undefined;
  const output = captureWorkerOutput(child);

  child.once('spawn', () => {
    childPid = child.pid;
    workerReady = true;
    // fork 前 ProxyConfig 的 set-proxy-env 因 worker 不存在被丢；spawn 后按 main 当前 env 补发一次
    child.postMessage({
      type: 'set-proxy-env',
      env: proxyEnvPatchFromEnv(process.env),
    } satisfies AgentCommand);
    // 先于积压的 spawn 命令送达：新会话的工具描述按设置生成
    pushShellLimits();
    pushImageGenerationConfig();
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
    pushAutoRetryLimit();
    pushLongCacheRetention();
    pushPrivacyMasking();
    pushDisabledWorkflowPresets();
    pushModelDirectory();
    pushWebSearchConfig();
  });
  child.on('message', (raw) => {
    // worker 构造完（认回的后台任务都已报过）才发 ready：Main 的任务表从这里起算全量
    if ((raw as { type?: unknown } | null)?.type === 'ready') {
      if (worker === child) backgroundTaskStates.markReported();
      return;
    }
    const event = parseAgentWorkerEvent(raw);
    if (event) {
      if (event.type === 'privacy-mask-ledger') {
        recordPrivacyMaskLedger(event.record);
        return;
      }
      if (event.type === 'oauth-pool-select') {
        void selectOauthPoolAccount(event).then((result) => {
          if (worker === child) child.postMessage(result);
        });
        return;
      }
      if (event.type === 'mcp-oauth-refresh') {
        const { requestId } = event;
        void refreshMcpOAuthAccess(event.serverId, event.rejected)
          .catch(
            (error: unknown): McpOAuthRefreshResult => ({
              ok: false,
              unauthorized: false,
              error: error instanceof Error ? error.message : String(error),
            })
          )
          .then((result) => {
            if (worker === child) {
              child.postMessage({
                type: 'mcp-oauth-refresh-result',
                requestId,
                result,
              } satisfies AgentCommand);
            }
          });
        return;
      }
      if (event.type === 'graceful-restart-deferred') {
        if (worker === child) {
          lastRestartDeferred = event.sessions;
          quitCheckpoint?.observe(event.sessions);
        }
        // 回复在写时每秒都会带新的出 token 时刻重报一次：原因变了才打日志
        const summary = event.sessions
          .map((s) => `${s.identity.sessionId.slice(0, 8)}=${s.reason}`)
          .join(', ');
        if (summary !== lastDeferredLog) {
          lastDeferredLog = summary;
          console.log(`[agent] graceful restart deferred: ${summary}`);
        }
        return;
      }
      if (event.type === 'graceful-restart-ready') {
        // 断点已落盘：之后的命令排队交给下一代，旧进程退出后由 exit 分支换代；
        // 退出 / 安装更新时不换代，写好恢复清单后放行退出
        if (worker === child && gracefulRestart.ready(child, event.checkpoint)) {
          workerReady = false;
          // 子代理 Run 按断点续跑：Main 要知道哪些子会话停在了安全点
          onEvent?.(event);
          if (gracefulRestart.quitting && quitCheckpoint) {
            const checkpoint = parseRestartCheckpoint(event.checkpoint);
            if (checkpoint) {
              const result = writeQuitManifest(
                quitCheckpoint,
                checkpoint,
                gracefulRestart.snapshot()
              );
              appendAgentWorkerExitLog(
                agentDataDir(),
                `[graceful-restart] ${quitCheckpoint.reason}: 到安全点，${
                  result === 'written'
                    ? `恢复清单 ${quitCheckpoint.resumable.size} 个会话：${describeCheckpoint(checkpoint, quitCheckpoint.resumable)}`
                    : `不写恢复清单（${result}）：${describeCheckpoint(checkpoint, quitCheckpoint.resumable)}`
                }`
              );
            }
            quitCheckpoint.settle('checkpointed');
          } else void killAndWaitExit(child, 5_000);
        }
        return;
      }
      if (event.type === 'background-tasks-detached') {
        if (worker === child) {
          console.log(`[agent] ${event.detached} background task(s) detached for restart`);
          detachAck?.();
        }
        return;
      }
      gracefulRestart.observe(event);
      resolveReleaseWaiters(event);
      // 手动重读结果只回给发起 invoke 的等待者，不进普通事件流（renderer 的通用
      // snapshot 分支会顺手改 started / 清 asks，手动刷新不能有这些副作用）
      if (
        pendingReloads.settle(event) ||
        workspaceLocks.settle(event) ||
        pluginMcp.settle(event) ||
        pluginAgents.settle(event)
      )
        return;
      if (settleCompletion(event) || settleChoice(event)) return;
      onEvent?.(event);
    }
  });
  child.on('exit', (code: unknown) => {
    const current = worker === child;
    const swap = current ? gracefulRestart.exited(child) : { swap: false as const };
    if (current) lastRestartDeferred = null;
    // 等安全点时 worker 先没了：不必再等超时
    if (worker === child) quitCheckpoint?.settle('skipped');
    if (worker === child) detachAck?.();
    if (worker === child) {
      worker = null;
      workerReady = false;
      workerExited = true;
      if (!swap.swap) parentInstanceIds.clear();
    }
    const dataDir = agentDataDir();
    sweepMcpServers(childPid);
    const crash = takeAgentWorkerCrash(dataDir, childPid);
    // 换代、主动停掉（已不是当前 worker）、退出应用 / 安装更新时终止，都是预期退出；崩溃一律算异常
    const expectedStop = swap.swap || !current || quitStopped;
    const normal = !crash && (code === 0 || expectedStop);
    const reason = swap.swap
      ? ' (graceful restart)'
      : expectedStop && code !== 0
        ? ' (expected stop)'
        : '';
    const detail = `${describeAgentWorkerExit(code, crash)}${reason}`;
    (normal ? console.info : console.error)(
      `[agent] worker exited pid=${childPid ?? '?'} ${detail}`
    );
    appendAgentWorkerExitLog(
      dataDir,
      `exit pid=${childPid ?? '?'} ${detail}${crash?.stack ? `\n${crash.stack}` : ''}`
    );
    void output.settled().then((tail) => {
      if (!tail) return;
      const mark = normal ? ' (normal exit)' : '';
      appendAgentWorkerExitLog(dataDir, `output tail pid=${childPid ?? '?'}${mark}\n${tail}`);
    });
    pendingReloads.failAll('agent worker exited');
    workspaceLocks.failAll('agent worker exited');
    pluginMcp.failAll('agent worker exited');
    pluginAgents.failAll('agent worker exited');
    for (const [id, p] of pendingCompletions) {
      pendingCompletions.delete(id);
      p.reject(new Error('agent worker exited'));
    }
    for (const [id, p] of pendingChoices) {
      pendingChoices.delete(id);
      p.reject(new Error('agent worker exited'));
    }
    // 会话树随 worker 进程一起销毁，release 已达成；不唤醒就只能等到 8 秒超时报失败
    resolveAllReleaseWaiters();
    if (swap.swap) {
      // 优雅重启：会话不算失败，下一代按断点重建并接着跑；先重发 spawn，再发换代期间排队的命令
      commandsPending = [...swap.replay, ...commandsPending];
      startAgentWorker({ restartCheckpointFile: path.join(dataDir, RESTART_CHECKPOINT_FILE) });
      // 子会话不随 spawn 重发：由 Main 的子代理服务按断点在父会话就绪后重开续跑
      onEvent?.({ type: 'worker-swapped' });
      return;
    }
    // 超时退出时 worker 收尾落的断点先写成清单：订阅者收到退出事件时就知道哪些会话重启后接着跑
    if (current && quitCheckpoint) writePendingLateManifest(quitCheckpoint);
    onEvent?.({ type: 'worker-exited', detail });
    if (current && !quitStopped) scheduleReminderRevive();
  });
}

function scheduleReminderRevive(): void {
  const dueAts = Object.values(readAllSessionReminders(path.join(agentDataDir(), 'sessions')))
    .flat()
    .map((item) => item.dueAt);
  const delay = reminderReviveDelay(dueAts, Date.now());
  if (delay === undefined) return;
  clearTimeout(reminderRevive);
  reminderRevive = setTimeout(() => {
    reminderRevive = undefined;
    if (!worker && workerExited && !quitStopped) startAgentWorker();
  }, delay);
  reminderRevive.unref?.();
}

/** worker 输出必须持续读走（否则管道写满会卡住 worker）；保留尾部供退出时落日志，dev 照常转到终端 */
function captureWorkerOutput(child: WorkerProcess): { settled(): Promise<string> } {
  const tail = createOutputTail(16 * 1024);
  const streams = [child.stdout, child.stderr].filter((stream): stream is NodeJS.ReadableStream =>
    Boolean(stream)
  );
  const ended = streams.map(
    (stream, index) =>
      new Promise<void>((resolve) => {
        stream.on('data', (chunk: Buffer | string) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          tail.push(buffer);
          if (!app.isPackaged) (index === 0 ? process.stdout : process.stderr).write(buffer);
        });
        stream.once('end', () => resolve());
        stream.once('close', () => resolve());
        stream.once('error', () => resolve());
      })
  );
  return {
    // exit 与管道收尾先后不定：最多再等 1s 让遗言读完
    settled: () =>
      Promise.race([
        Promise.all(ended),
        new Promise<void>((resolve) => setTimeout(resolve, 1000).unref()),
      ]).then(() => tail.text().trim()),
  };
}

/** child-process-gone 能区分 crashed / oom / killed，和 exit 先后不定，单独落同一份日志 */
export function recordAgentWorkerGone(details: {
  type: string;
  name?: string;
  reason: string;
  exitCode: number;
}): void {
  if (!isAgentWorkerGone(details)) return;
  appendAgentWorkerExitLog(
    agentDataDir(),
    `gone reason=${details.reason} ${describeAgentWorkerExit(details.exitCode, null)}`
  );
}

export function stopAgentWorker(): void {
  gracefulRestart.reset();
  keepBackgroundOnQuit = false;
  quitStopped = false;
  workspaceLocks.failAll('agent worker stopped');
  pluginMcp.failAll('agent worker stopped');
  pluginAgents.failAll('agent worker stopped');
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
 * 菜单「重启」：请当前 worker 在安全点落断点后换一个新进程，会话从断点接着跑。
 * 窗口不动；重启进行中再请求不会叠第二个进程。
 */
export function requestGracefulWorkerRestart(): GracefulRestartRequest {
  const current = worker && workerReady ? worker : null;
  const result = gracefulRestart.request(current);
  if (result === 'requested')
    current?.postMessage({ type: 'graceful-restart' } satisfies AgentCommand);
  return result;
}

/**
 * 让 worker 按 Main 当前 env 重新 fork（env 是 fork 时的快照）。尚未启动或已退出时
 * 不处理：首次启动 / 下一条命令触发的重建自然带上新 env。
 */
export async function restartAgentWorker(timeoutMs = 5_000): Promise<boolean> {
  const child = worker;
  if (!child) return false;
  await killAndWaitExit(child, timeoutMs);
  if (worker === child) stopAgentWorker();
  if (!worker) startAgentWorker();
  return true;
}

/**
 * 应用退出时 Electron 不给 utility 进程发 SIGTERM，worker 的收尾（中止会话→pi 杀 detached
 * bash 进程组、断开 MCP）跑不到，命令会成孤儿进程。退出前主动发信号并等它自行退出。
 * 等安全点超时的话，worker 收尾（中止命令）时可能才落断点：退出后据此补写恢复清单。
 * keepBackgroundTasks：终止前先让 worker 把能脱离的后台命令交出去（detached 进程组本就独立存活，
 * 不再被收尾 stopAll 杀掉）。GUI 场景由 prepareAgentWorkerForQuit 的同名选项置位；
 * headless 一次性 run 没有「下一代」，但 eval / verifier 需要 agent 起的服务活到进程退出之后，
 * 由调用方逐次显式传，不沾染共享的 keepBackgroundOnQuit。
 */
export async function stopAgentWorkerForQuit(
  timeoutMs: number,
  options: { keepBackgroundTasks?: boolean } = {}
): Promise<void> {
  quitStopped = true;
  const child = worker;
  const pending = quitCheckpoint;
  // 清会话前留一份设置：补写清单时要配上（worker 退出时写，没等到退出就在这里补写）
  if (pending?.timedOut && !pending.manifestWritten) pending.late = gracefulRestart.snapshot();
  // 退出应用时不再换代
  gracefulRestart.reset();
  if (child) {
    // 应用会重新打开：先让 worker 把能脱离的后台命令交出去、写好恢复清单，再终止它
    if (keepBackgroundOnQuit || options.keepBackgroundTasks)
      await detachBackgroundTasks(child, DETACH_ACK_TIMEOUT_MS);
    await killAndWaitExit(child, timeoutMs);
  }
  if (pending) writePendingLateManifest(pending);
}

function writePendingLateManifest(pending: QuitCheckpoint): void {
  const late = pending.late;
  if (!late) return;
  pending.late = undefined;
  writeLateQuitManifest(pending, late);
}

/** 这个会话写进了本次退出的恢复清单：新实例按清单恢复，worker 退出不算它失败 */
export function resumesAfterQuit(sessionId: string): boolean {
  return quitCheckpoint?.resumable.has(sessionId) ?? false;
}

/** 等 worker 交出后台命令的上限；超时照常终止（没交出去的随 worker 收尾停掉） */
export const DETACH_ACK_TIMEOUT_MS = 2_000;
let keepBackgroundOnQuit = false;
let detachAck: (() => void) | null = null;

function detachBackgroundTasks(child: WorkerProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      detachAck = null;
      appendAgentWorkerExitLog(
        agentDataDir(),
        `[graceful-restart] worker 没在 ${timeoutMs}ms 内交出后台命令，照常终止`
      );
      resolve();
    }, timeoutMs);
    timer.unref?.();
    detachAck = () => {
      clearTimeout(timer);
      detachAck = null;
      resolve();
    };
    child.postMessage({ type: 'detach-background-tasks' } satisfies AgentCommand);
  });
}

export {
  QUIT_REPLY_IDLE_MS,
  QUIT_REPLY_WAIT_CAP_MS,
  QUIT_REPLY_WAIT_FLOOR_MS,
  QUIT_TOOL_WAIT_LIMIT_MS,
} from './agentQuitLimits';
export type QuitCheckpointResult = 'skipped' | 'checkpointed' | 'timeout';

type DeferredSessions = Extract<
  AgentWorkerEvent,
  { type: 'graceful-restart-deferred' }
>['sessions'];

/** 等安全点结束时一次模型请求的结局：写完 / 保底后停止出 token / 到了上限 / 用户强制退出 */
type ReplyOutcome = 'done' | 'idle' | 'cap' | 'forced';

const REPLY_OUTCOME_LABEL: Record<ReplyOutcome, string> = {
  done: '写完',
  idle: '空闲中止',
  cap: '总上限中止',
  forced: '强制退出',
};

interface ReplyTrack {
  sessionId: string;
  progress: RestartReplyProgress;
  endedAt?: number;
}

interface QuitCheckpoint {
  reason: RestartExitReason;
  requestedAt: number;
  promise: Promise<QuitCheckpointResult>;
  timedOut: boolean;
  manifestWritten: boolean;
  /** 写进恢复清单的会话 */
  resumable: ReadonlySet<string>;
  /** 超时退出、还没补写清单时留的会话设置 */
  late?: RestartSettingsSnapshot;
  /** worker 最近一次推迟时报告有工具在跑 */
  toolsRunning: boolean;
  /** 已告诉弹层在等什么（工具 / 脱离不了的转后台命令 / 回复）；还没报过推迟时为 null */
  waitReason: RestartWaitReason | null;
  /** 最近一次告诉弹层的会话级原因；和 waitReason 一起按内容去重 */
  blockers: RestartBlocker[];
  /** worker 最近一次报告的推迟：超时时据此记下每个会话在干什么 */
  lastDeferred: DeferredSessions | null;
  /** 等安全点期间见过的每次模型请求（会话 + 请求发出时刻），结束时逐个记进退出日志 */
  replies: Map<string, ReplyTrack>;
  waitingForTools: Array<(reason: RestartWaitReason, blockers: RestartBlocker[]) => void>;
  observe(sessions: DeferredSessions): void;
  settle(result: QuitCheckpointResult): void;
  /** 用户不等了：按超时收尾；已经有结果返回 false */
  force(): boolean;
}

let quitCheckpoint: QuitCheckpoint | null = null;
/** 本代 worker 最近一次报告的推迟：换代重启已在等时加入的退出没有新事件，据此知道有没有工具在跑 */
let lastRestartDeferred: DeferredSessions | null = null;
let lastDeferredLog = '';

/**
 * 应用退出 / 安装更新：先请 worker 停到安全点、写好断点，Main 再把恢复清单落到 dataDir，
 * 冷启动据此续跑。没有正在跑的会话、也没有在跑的后台命令时直接放行；同一次退出只发一次请求，再调用拿同一个结果。
 * 有工具在跑就等它结束（上限 QUIT_TOOL_WAIT_LIMIT_MS），没有时等这一轮回复写完：保底 QUIT_REPLY_WAIT_FLOOR_MS，
 * 之后还在出 token 就顺延、停止超过 QUIT_REPLY_IDLE_MS 或到 QUIT_REPLY_WAIT_CAP_MS 为止（到点 worker 收尾中止回复并记成续跑点）；onWaitingForTools 在 worker 报告推迟时回调在等什么，以及每个会话挡住的原因，原因或挡住的会话变了再回调（已在等则立即回调）。
 */
export function prepareAgentWorkerForQuit(options: {
  reason: RestartExitReason;
  /** 有根回合在跑，或回合已结束但还有后台命令在跑（ipc/sessionIndex.needsQuitCheckpoint） */
  hasRunningSessions: () => boolean;
  onWaitingForTools?: (reason: RestartWaitReason, blockers: RestartBlocker[]) => void;
  /** 应用会重新打开：能脱离的转后台命令留给下一代认回，不等它们结束 */
  keepBackgroundTasks?: boolean;
}): Promise<QuitCheckpointResult> {
  if (options.keepBackgroundTasks) keepBackgroundOnQuit = true;
  if (quitCheckpoint) {
    if (options.onWaitingForTools) {
      quitCheckpoint.waitingForTools.push(options.onWaitingForTools);
      if (quitCheckpoint.waitReason)
        options.onWaitingForTools(quitCheckpoint.waitReason, quitCheckpoint.blockers);
    }
    return quitCheckpoint.promise;
  }
  const current = worker && workerReady ? worker : null;
  if (!current || !options.hasRunningSessions()) return Promise.resolve('skipped');
  const outcome = gracefulRestart.requestQuit(current);
  if (outcome === 'no-session' || outcome === 'busy') return Promise.resolve('skipped');
  if (outcome === 'requested')
    current.postMessage(
      (options.keepBackgroundTasks
        ? { type: 'graceful-restart', keepBackgroundTasks: true }
        : { type: 'graceful-restart' }) satisfies AgentCommand
    );
  const requestedAt = Date.now();
  const { promise, resolve } = Promise.withResolvers<QuitCheckpointResult>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let quietSince = requestedAt;
  const finish = (result: QuitCheckpointResult, outcome: ReplyOutcome = 'done') => {
    clearTimeout(timer);
    settled = true;
    // 撤销的退出（安装更新失败）不算结局
    if (result !== 'skipped') logReplyOutcomes(state, outcome);
    resolve(result);
  };
  const timeOut = (why: string, outcome: ReplyOutcome) => {
    state.timedOut = true;
    const message = `[graceful-restart] ${options.reason}: worker 等安全点 ${Date.now() - requestedAt}ms 超时（${why}），中止在跑的命令照常退出；会话状态：${describeDeferred(state.lastDeferred)}`;
    console.warn(message);
    appendAgentWorkerExitLog(agentDataDir(), message);
    finish('timeout', outcome);
  };
  // 有工具在跑等到总上限；没有时按回复出 token 的情况：保底、之后空闲阈值内还在出就顺延、最多到回复上限
  const arm = () => {
    clearTimeout(timer);
    const limit = requestedAt + QUIT_TOOL_WAIT_LIMIT_MS;
    const reply = state.toolsRunning ? null : replyWaitDeadline(quietSince, lastOutputAt(state));
    const deadline = reply ? Math.min(limit, reply.at) : limit;
    timer = setTimeout(
      () =>
        state.toolsRunning
          ? timeOut(`工具跑了超过上限 ${QUIT_TOOL_WAIT_LIMIT_MS}ms`, 'cap')
          : !reply || reply.at >= limit
            ? timeOut(`等安全点到了总上限 ${QUIT_TOOL_WAIT_LIMIT_MS}ms`, 'cap')
            : reply.end === 'cap'
              ? timeOut(
                  `没有工具在跑，回复一直在写，到了回复等待上限 ${QUIT_REPLY_WAIT_CAP_MS}ms`,
                  'cap'
                )
              : timeOut(
                  `没有工具在跑，保底 ${QUIT_REPLY_WAIT_FLOOR_MS}ms 已过，回复停止出 token 超过 ${QUIT_REPLY_IDLE_MS}ms 或还没出 token`,
                  'idle'
                ),
      Math.max(0, deadline - Date.now())
    );
    timer.unref?.();
  };
  const state: QuitCheckpoint = {
    reason: options.reason,
    requestedAt,
    promise,
    timedOut: false,
    manifestWritten: false,
    resumable: new Set(),
    toolsRunning: false,
    waitReason: null,
    blockers: [],
    lastDeferred: null,
    replies: new Map(),
    waitingForTools: options.onWaitingForTools ? [options.onWaitingForTools] : [],
    observe(sessions) {
      if (settled) return;
      state.lastDeferred = sessions;
      trackReplies(state.replies, sessions);
      const running = sessions.some((session) => session.toolsInFlight.length > 0);
      const waitReason: RestartWaitReason | null = running
        ? sessions.some((session) => (session.undetachableTasks?.length ?? 0) > 0)
          ? 'background-not-detachable'
          : 'tool'
        : sessions.length > 0
          ? sessions.every((session) => session.reason === 'session-starting')
            ? 'tool'
            : 'reply'
          : null;
      const blockers = sessions.map(deferKind);
      if (
        waitReason &&
        (waitReason !== state.waitReason || !sameBlockers(blockers, state.blockers))
      ) {
        state.waitReason = waitReason;
        state.blockers = blockers;
        for (const notify of state.waitingForTools) notify(waitReason, blockers);
      }
      if (running !== state.toolsRunning) {
        state.toolsRunning = running;
        if (!running) quietSince = Date.now();
      }
      // 新出的 token 会把截止时刻往后推
      arm();
    },
    settle: (result) => finish(result),
    force() {
      if (settled) return false;
      state.timedOut = true;
      const message = `[graceful-restart] ${options.reason}: 用户强制退出，等安全点 ${Date.now() - requestedAt}ms 后不再等，中止在跑的命令照常退出`;
      console.warn(message);
      appendAgentWorkerExitLog(agentDataDir(), message);
      finish('timeout', 'forced');
      return true;
    },
  };
  quitCheckpoint = state;
  arm();
  if (outcome === 'joined' && lastRestartDeferred) state.observe(lastRestartDeferred);
  return promise;
}

/**
 * 等待弹层上点「强制退出」：不再等安全点，立刻结束等待、走超时收尾——stopAgentWorkerForQuit
 * 终止 worker 时它落的断点照样写成恢复清单，落不了只记日志。没有在等的退出返回 false。
 */
export function forceAgentWorkerQuit(): boolean {
  return quitCheckpoint?.force() ?? false;
}

/**
 * 退出没有发生（安装更新失败）：撤掉恢复清单；worker 若已落断点就让它退出，按断点换代接着跑，
 * 否则把还在等的请求改回普通换代。
 */
export function cancelAgentQuitCheckpoint(): void {
  const pending = quitCheckpoint;
  quitCheckpoint = null;
  keepBackgroundOnQuit = false;
  if (!pending) return;
  pending.settle('skipped');
  rmSync(restartManifestPath(agentDataDir()), { force: true });
  if (gracefulRestart.cancelQuit() && worker) void killAndWaitExit(worker, 5_000);
}

function writeQuitManifest(
  pending: QuitCheckpoint,
  checkpoint: RestartCheckpoint,
  settings: RestartSettingsSnapshot
): 'written' | 'empty' | 'failed' {
  try {
    const manifest = buildRestartManifest({
      reason: pending.reason,
      checkpoint,
      settingsOf: settings.settingsOf,
    });
    pending.manifestWritten = writeRestartManifest(agentDataDir(), manifest, settings.secrets);
    if (pending.manifestWritten)
      pending.resumable = new Set(manifest.sessions.map((entry) => entry.sessionId));
    return pending.manifestWritten ? 'written' : 'empty';
  } catch (error) {
    console.error('[graceful-restart] 写恢复清单失败，冷启动不续跑:', error);
    return 'failed';
  }
}

/** 超时退出后 worker 收尾时落的断点：能用就返回断点，不能用返回原因 */
function lateQuitCheckpoint(pending: QuitCheckpoint): RestartCheckpoint | string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(agentDataDir(), RESTART_CHECKPOINT_FILE), 'utf8'));
  } catch {
    return 'worker 退出前没落断点（没到安全点）';
  }
  const checkpoint = parseRestartCheckpoint(raw);
  if (!checkpoint) return '断点格式不对';
  if (checkpoint.writtenAt < pending.requestedAt) return '断点是这次退出之前留下的';
  const busy = checkpoint.sessions.filter((entry) => entry.toolsInFlight.length > 0);
  if (busy.length > 0)
    return `断点里还有工具在跑（${busy.map((entry) => `${entry.sessionId.slice(0, 8)}=${entry.toolsInFlight.join(',')}`).join(' ')}）`;
  if (checkpoint.sessions.length === 0) return '断点里没有会话';
  return checkpoint;
}

/** 超时退出：worker 收尾时落的断点能用就照样写清单，冷启动据此续跑；不能用就记下原因 */
function writeLateQuitManifest(pending: QuitCheckpoint, settings: RestartSettingsSnapshot): void {
  const checkpoint = lateQuitCheckpoint(pending);
  const result =
    typeof checkpoint === 'string' ? checkpoint : writeQuitManifest(pending, checkpoint, settings);
  const message =
    result === 'written' && typeof checkpoint !== 'string'
      ? `按 worker 收尾时落的断点写了恢复清单（${checkpoint.sessions.length} 个会话）：${describeCheckpoint(checkpoint, pending.resumable)}`
      : `不写恢复清单：${
          result === 'empty'
            ? '断点里的会话都不是可续跑的普通根会话'
            : result === 'failed'
              ? '写清单出错'
              : result
        }`;
  const line = `[graceful-restart] ${pending.reason}: 超时退出，${message}`;
  console.warn(line);
  appendAgentWorkerExitLog(agentDataDir(), line);
}

/**
 * 等待期间最近一次有输出的时刻：在写的回复按最近出 token，刚写完的按写完那刻
 * （写完到回合收口、落断点还有一小段，不能因为不再出 token 就立刻按空闲中止）
 */
function lastOutputAt(state: QuitCheckpoint): number | undefined {
  let latest: number | undefined;
  for (const track of state.replies.values()) {
    const at = track.endedAt ?? track.progress.lastOutputMs;
    if (at !== undefined && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

/** 按会话 + 请求发出时刻记下见过的模型请求；不再报告在写的那次算写完 */
function trackReplies(replies: Map<string, ReplyTrack>, sessions: DeferredSessions): void {
  const now = Date.now();
  const seen = new Set<string>();
  for (const session of sessions) {
    if (!session.reply) continue;
    const key = `${session.identity.sessionId}@${session.reply.requestStartMs}`;
    seen.add(key);
    replies.set(key, { sessionId: session.identity.sessionId, progress: session.reply });
  }
  for (const [key, track] of replies) if (!seen.has(key)) track.endedAt ??= now;
}

/** 等安全点结束：每次见过的模型请求记一行（发出 / 首 token / 最后出字 / 等了多久 / 怎么结束的） */
function logReplyOutcomes(state: QuitCheckpoint, outcome: ReplyOutcome): void {
  const now = Date.now();
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  for (const track of state.replies.values()) {
    const { requestStartMs, firstTokenMs, lastOutputMs } = track.progress;
    const end = track.endedAt ?? now;
    const line = `[graceful-restart] ${state.reason}: 会话 ${track.sessionId.slice(0, 8)} 回复：请求发出 ${new Date(requestStartMs).toISOString()}，首 token ${
      firstTokenMs === undefined ? '无' : `+${seconds(firstTokenMs - requestStartMs)}`
    }，最后出字 ${
      lastOutputMs === undefined ? '无' : `+${seconds(lastOutputMs - requestStartMs)}`
    }，等了 ${seconds(end - Math.max(state.requestedAt, requestStartMs))}，结果：${
      REPLY_OUTCOME_LABEL[track.endedAt === undefined ? outcome : 'done']
    }`;
    console.log(line);
    appendAgentWorkerExitLog(agentDataDir(), line);
  }
}

function deferKind(session: DeferredSessions[number]): RestartBlocker {
  const sessionId = session.identity.sessionId;
  if (session.reason === 'session-starting') return { sessionId, kind: 'starting' };
  const tools = [...new Set(session.toolNames ?? [])];
  if (tools.length > 0) return { sessionId, kind: 'tool', tools };
  if (session.toolsInFlight.length > 0) return { sessionId, kind: 'background' };
  if (session.reply) return { sessionId, kind: 'reply' };
  return { sessionId, kind: 'turn' };
}

function sameBlockers(left: readonly RestartBlocker[], right: readonly RestartBlocker[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deferredSessionLabel(sessionId: string): string {
  const splitAt = sessionId.indexOf('::');
  if (splitAt === -1) return sessionId.slice(0, 8);
  return `${sessionId.slice(splitAt + 2, splitAt + 10)}(子会话)`;
}

/** 退出时每个没到安全点的会话在干什么（worker 最近一次推迟报告） */
function describeDeferred(sessions: DeferredSessions | null): string {
  if (!sessions?.length) return 'worker 没报告推迟（可能卡在会话打开或 worker 无响应）';
  return sessions
    .map((session) => {
      const blocker = deferKind(session);
      const what =
        blocker.kind === 'starting'
          ? '正在打开会话'
          : blocker.kind === 'tool'
            ? `工具在跑(${blocker.tools?.join(',')})`
            : blocker.kind === 'background'
              ? `转后台命令在跑(${session.toolsInFlight.join(',')})`
              : blocker.kind === 'reply'
                ? '回复在写'
                : '回合收尾中';
      return `${deferredSessionLabel(session.identity.sessionId)}=${what}`;
    })
    .join(' ');
}

/** 断点里每个会话的处理结果：清单里的按下一步续跑或等用户，清单外的（Bot、子会话等）不续跑 */
function describeCheckpoint(checkpoint: RestartCheckpoint, resumable: ReadonlySet<string>): string {
  return checkpoint.sessions
    .map(
      (entry) =>
        `${deferredSessionLabel(entry.sessionId)}=${
          !resumable.has(entry.sessionId)
            ? '不进清单'
            : entry.nextStep === 'model-request'
              ? 'model-request（冷启动续跑）'
              : 'await-user（等用户）'
        }`
    )
    .join(' ');
}

/** 普通根会话 spawn 成功后记下原始请求（不含凭据），退出时写进恢复清单 */
export function rememberRestorableSpawn(
  identity: SessionIdentity,
  request: AgentSpawnRequest
): void {
  gracefulRestart.rememberRequest(identity, request);
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

/** 插件调宿主 MCP：用用户已启用的 MCP 配置（凭据随配置下发给 worker，不经插件） */
const pluginMcp = new PluginMcpRequests((command) => sendAgentCommand(command).ok);
/** 插件代理在发起会话所在的 worker 里跑，用该会话的模型与只读工具 */
const pluginAgents = new PluginAgentRuns((command) => sendAgentCommand(command).ok);
function pluginMcpServers(): McpServerSpawnConfig[] {
  const state = readSettingsState();
  const servers = Array.isArray(state?.mcpServers) ? state.mcpServers.filter(isMcpServerEntry) : [];
  return servers.filter((server) => server.enabled !== false).map(toMcpSpawnConfig);
}
setPluginMcpBridge({
  mcpTools: (_target, signal) => pluginMcp.list(pluginMcpServers(), signal),
  mcpCall: (_target, server, tool, args, signal) =>
    pluginMcp.call(pluginMcpServers(), server, tool, args, signal),
});
const workspaceWorkers = new Map<string, WorkerProcess | null>();

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
  // 与 worker 入口同一份校验：不合法的命令发过去只会被丢弃，这里当场报出命令类型
  if (!parseAgentCommand(command))
    return { ok: false, error: `invalid ${command.type} command: rejected by worker contract` };
  if (workspaceCommandBlocked(command, workspaceBusy))
    return { ok: false, error: 'Workspace operation in progress.' };
  gracefulRestart.record(command);
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
    Array.isArray(state?.agentTypes) ? state.agentTypes.filter(isAgentTypeEntry) : []
  );
  return buildAgentTypeRegistrySnapshot({
    revision: settingsRevision(state),
    disabledBuiltinAgentTypes,
    customAgentTypes,
    members: memberAgentTypes(),
  });
}

/**
 * 解析模型引用并组装下发配置。只有显式 `allowVirtual` 的调用方得到 `config.virtual`；
 * 今天是会话主模型（含跟随父会话、set-model、插件预设换模）、子代理目录和类型化 agent 的 fixed 绑定。
 * 其他场景（标题、代审、压缩摘要、btw…）落到虚拟引用时取其快模型（无则主模型）。
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
  const fast = entry.fast ? member(entry.fast) : undefined;
  const fallbacks = entry.fallbacks
    .map(member)
    .filter((config): config is SpawnModelConfig => config !== undefined);
  const primary = member(entry.primary) ?? fallbacks.shift() ?? fast;
  if (!primary) return { ok: false, error: '虚拟模型没有可用成员' };
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
  const credentials = classifierCredentialsFor(
    providersFromSettings().find((item) => item.id === classifier.model.providerId),
    classifier.model.modelId,
    authenticatedAccountKeys
  );
  return credentials
    ? { source: 'pi-classifier', timeoutMs: classifier.timeoutMs, classifier: credentials }
    : undefined;
}

function classifierCredentialsFor(
  provider: ModelProvider | undefined,
  modelId: string,
  authenticatedAccountKeys: ReadonlySet<string>
): VirtualClassifierCredentials | undefined {
  if (!provider?.enabled) return undefined;
  const piProvider = classifierProviderFor(provider);
  if (!piProvider) return undefined;
  const baseUrl = classifierBaseUrlFor(provider);
  if (provider.oauthAccountKey) {
    if (!authenticatedAccountKeys.has(provider.oauthAccountKey)) return undefined;
  } else if (!provider.apiKey) {
    return undefined;
  }
  // 坏代理不下发分类器：不能退回全局代理
  const proxy = provider.oauthAccountKey ? undefined : parseProviderProxy(provider.proxy);
  if (proxy === null) return undefined;
  return {
    provider: piProvider,
    modelId,
    ...(provider.oauthAccountKey ? {} : { apiKey: provider.apiKey }),
    ...(baseUrl ? { baseUrl } : {}),
    ...(proxy ? { proxy } : {}),
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
  if (!provider.oauthAccountKey && parseProviderProxy(provider.proxy) === null) {
    return { ok: false, error: 'Model provider proxy configuration is invalid.' };
  }
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
const builtinToolScopes = new BuiltinToolScopes();
/** 父会话最近一次 spawn-parent 带的实例号（见 spawnSession 的 options.instanceId）；worker 退出清空 */
const parentInstanceIds = new Map<string, string>();

/** 记下父会话这次 spawn-parent 带的实例号；不带号的 spawn 清掉旧号（worker 同样按最近一次 spawn 改绑） */
export function rememberParentInstance(sessionId: string, instanceId: string | undefined): void {
  if (instanceId) parentInstanceIds.set(sessionId, instanceId);
  else parentInstanceIds.delete(sessionId);
}

/** 发往父会话的 prompt / steer / retry 附上该会话当前的实例号；子会话与没登记号的会话不附 */
function instanceField(identity: SessionIdentity): { instanceId?: string } {
  if ('parent' in identity) return {};
  const instanceId = parentInstanceIds.get(identity.sessionId);
  return instanceId ? { instanceId } : {};
}

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
  builtinToolScopes.forget(sessionId);
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
      Array.isArray(state?.agentTypes) ? state.agentTypes.filter(isAgentTypeEntry) : []
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
      authenticatedAccountKeys,
      { allowVirtual: true }
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
      // 类型级推理预设透传（与 configuredAgentTypes 同口径：非法值不透传）。
      // 此前只在 coworker 直雇路径生效，typed-spawn 静默丢弃导致子会话回落 medium。
      ...(MODEL_REASONING_OVERRIDES.includes(definition.reasoning as ModelReasoningOverride)
        ? { reasoning: definition.reasoning as ModelReasoningOverride }
        : {}),
      ...(MODEL_THINKING_LEVEL_OVERRIDES.includes(
        definition.thinkingLevel as ModelThinkingLevelOverride
      )
        ? { thinkingLevel: definition.thinkingLevel as ModelThinkingLevelOverride }
        : {}),
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
    /** 复盘旁路：worker 把该会话最近一次请求的消息序列注入新会话（提示缓存命中） */
    forkFrom?: string;
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
      /** 群聊成员会话且讨论模式（实验性）开启：delegate 说明加讨论接力句 */
      discussMode?: boolean;
      /** 私聊 / 群聊成员会话（非委派）：worker 挂 routine_propose */
      routines?: boolean;
      /** 挂看板任务的委派会话：worker 挂 report_blocked */
      delegationTask?: boolean;
      /** 写成员同工作区写协调 */
      writeLock?: { label: string; ancestors: string[] };
    };
    /**
     * 秘书会话：人设由 Main 组装，插件只按勾选的 id 挂工具与技能，MCP / hooks / 命令、
     * 子代理类型与全局指令仍然不挂，工具白名单在 worker 里按名字执行
     */
    secretary?: {
      systemPrompt: string;
      pluginIds?: readonly string[];
      /** 勾选给秘书的全局 skill id */
      skillIds?: readonly string[];
      /** 秘书自有 skill 的目录（已按启用状态筛过），总是挂上 */
      skillDirs?: readonly string[];
      /** 秘书自造工具的描述符：worker 只按这些确切名字挂工具 */
      tools?: readonly SecretaryToolDescriptor[];
    };
    /**
     * Main 给这次 spawn 的实例号（目前只有 Bot 宿主传）：随 spawn-parent 下发，之后同会话的 prompt / steer /
     * retry 自动带上，worker 在 parent-rejected / parent-ended 里回显，调用方据此确定结束事件属于哪个实例
     */
    instanceId?: string;
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
  if (request.approvalMode === 'assistant' && (!reviewer.ok || !reviewer.source)) {
    return { ok: false, error: 'Select an assistant approval model in Settings first.' };
  }
  const approvalReviewerSource = reviewer.ok ? reviewer.source : null;
  const bot = options?.bot;
  const secretary = options?.secretary;
  // 秘书只挂勾选的插件；Bot 会话仍然整批关掉
  const extensionPlugins = bot ? null : getExtensionPlugins();
  /** 只有秘书会话按勾选圈定插件；undefined 表示普通会话照旧拿全部已启用插件 */
  const secretaryPluginIds = secretary ? (secretary.pluginIds ?? []) : undefined;
  const overlay = bot || secretary ? undefined : presetOverlay(request.presetId, resolvePreset);
  const overlayIds = overlay?.pluginPresetIds ?? [];
  const overlayResults = overlayIds.map((id) => extensionPlugins?.presetForSpawn(id));
  const overlayFailed = overlayResults.find((result): result is { ok: false; error: string } =>
    Boolean(result && !result.ok)
  );
  if (overlay?.required && (overlayFailed || overlayResults.some((result) => !result))) {
    return {
      ok: false,
      error: overlayFailed?.error ?? '插件预设不可用，请重新选择或恢复默认。',
    };
  }
  // 自建预设叠加的插件预设失效（插件停用/卸载）时退回只用自建预设
  const pluginKits = overlayResults.flatMap((result) => (result?.ok ? [result] : []));
  const mergedPluginKit = pluginKits.length > 0 ? mergePluginPresetKits(pluginKits) : undefined;
  const pluginInstruction = pluginKits.length > 0 ? mergePluginInstructions(pluginKits) : undefined;
  const pluginPreset =
    mergedPluginKit || pluginInstruction
      ? { ...mergedPluginKit, ...(pluginInstruction ? { instruction: pluginInstruction } : {}) }
      : undefined;
  const preset: Preset | undefined = secretary
    ? { id: 'secretary', name: 'secretary', skillIds: [], mcpServerIds: [] }
    : bot
      ? { id: 'bot', name: 'bot', skillIds: bot.skillIds, mcpServerIds: bot.mcpServerIds }
      : overlay?.preset;
  const ownKit = secretary
    ? { ok: true as const, systemPrompt: secretary.systemPrompt }
    : bot
      ? { ok: true as const, systemPrompt: bot.systemPrompt }
      : resolvePresetPromptKit(preset);
  if (!ownKit.ok) {
    return { ok: false, error: '自定义系统提示词正文读取失败，请重新保存或恢复默认。' };
  }
  const promptKit = mergePresetPromptKit(ownKit, pluginPreset);
  // 秘书不加载全局指令：那是给写代码的会话的
  const instruction = secretary
    ? undefined
    : bot
      ? bot.instruction
      : pluginPresetInstruction(pluginPreset?.instruction, () =>
          resolveGlobalInstruction(preset ? { instructionId: preset.instructionId } : undefined)
        );
  const state = readSettingsState();
  // Enso 插件：顺序在预设之后；Bot 会话不合并
  const activePluginPresets = pluginPreset ? overlayIds : [];
  // 无插件预设也要按 undefined 调一次：秘书按勾选 id 圈定 / 普通会话拿不受预设圈定的部分
  const pluginPresetScopes = activePluginPresets.length > 0 ? activePluginPresets : [undefined];
  const skillPaths = [
    ...enabledSkillPaths(preset),
    ...dedupePaths(
      pluginPresetScopes.flatMap(
        (id) => extensionPlugins?.skillPathsForSpawn(id, secretaryPluginIds) ?? []
      )
    ),
    ...secretarySkillPaths(secretary),
  ];
  // 秘书不挂插件的 MCP 与 workflow：插件进程与凭据不该为它拉起，workflow 也不在它的能力里
  const workflowPresetFiles = secretary
    ? []
    : dedupePaths(
        pluginPresetScopes.flatMap((id) => extensionPlugins?.workflowPathsForSpawn(id) ?? [])
      );
  const mcpServers = enabledMcpServers(preset);
  const mcpNames = new Set(mcpServers.map((server) => server.name));
  for (const server of secretary
    ? []
    : pluginPresetScopes.flatMap((id) => extensionPlugins?.mcpServersForSpawn(id) ?? [])) {
    if (!mcpNames.has(server.name)) mcpServers.push(server);
    mcpNames.add(server.name);
  }
  const pluginTools = extensionPlugins?.toolsForSpawn(secretaryPluginIds) ?? [];
  const subagentModels =
    options?.omitDispatchTools || secretary
      ? []
      : configuredSubagentModels(authenticatedAccountKeys);
  const agentTypes =
    options?.omitDispatchTools || secretary
      ? []
      : configuredAgentTypes(
          authenticatedAccountKeys,
          subagentModels.length > 0,
          // Enso 插件的子代理类型与其 skill / MCP 同口径：Bot 会话不合并
          bot
            ? []
            : mergePluginAgentTypes(
                pluginPresetScopes.map(
                  (id) => extensionPlugins?.agentTypesForSpawn({ activePresetId: id }) ?? []
                )
              )
        );
  // 当前平台不能操作桌面时禁用 computer，避免模型反复调用必失败的工具
  const extraDisabledTools = [
    ...(options?.extraDisabledTools ?? []),
    ...(secretary ? SECRETARY_FORCED_DISABLED_TOOLS : []),
  ];
  // 记忆是秘书的核心能力：全局"禁用内置工具"对秘书会话不生效
  const disabledTools = withoutKeepEnabled(
    sessionDisabledTools(state, projectId, extraDisabledTools, isComputerPlatformSupported()),
    secretary ? SECRETARY_ALWAYS_ENABLED_TOOLS : []
  );
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
  const presetApplied = applyPluginPresetOverrides({
    model: resolved.selection.config,
    thinkingLevel: request.thinkingLevel,
    approvalMode: request.approvalMode,
    disabledTools,
    preset: mergePluginPresetOverrides(pluginKits.map((kit) => readPluginPresetOverrides(kit))),
    resolveModel: (model) => {
      const next = resolveModelSelection(
        model.providerId,
        model.modelId,
        authenticatedAccountKeys,
        { allowVirtual: true }
      );
      return next.ok
        ? { ok: true as const, model: next.selection.config }
        : { ok: false as const, error: next.error };
    },
  });
  if (!presetApplied.ok) return { ok: false, error: presetApplied.error };
  const pluginEvents = extensionPlugins?.eventPlanForSpawn(secretaryPluginIds) ?? null;
  // worker 崩溃/退出后不自动拉起的话，所有会话都只能靠重启 app 恢复；在 spawn 入口按需重建
  if (!worker && workerExited) startAgentWorker();
  const dcgPath = state?.dcgEnabled === true ? installedDcgPath(dcgRoot()) : null;
  const dcgExemptRules = dcgPath ? activeDcgExemptRules(dcgRoot(), DCG_VERSION) : [];
  const sent = sendAgentCommand({
    type: 'spawn-parent',
    identity,
    cwd: request.cwd,
    model: presetApplied.model,
    ...(request.resumeFile ? { resumeFile: request.resumeFile } : {}),
    ...(request.reasoningEnabled ? { reasoningEnabled: true } : {}),
    ...(presetApplied.thinkingLevel ? { thinkingLevel: presetApplied.thinkingLevel } : {}),
    ...(preset || request.loadLocalSkills === false ? { loadLocalSkills: false } : {}),
    ...(loadHarnessAssets ? { loadHarnessAssets: true } : {}),
    ...(trustedProjectCode.length > 0 ? { trustedProjectCode } : {}),
    ...(windowsLocalShell !== 'auto' ? { windowsLocalShell } : {}),
    rtkEnabled: state?.rtkEnabled !== false,
    ...(dcgPath ? { dcgPath } : {}),
    ...(dcgExemptRules.length > 0 ? { dcgExemptRules } : {}),
    ...(exploreFoldEnabled ? { exploreFoldEnabled: true } : {}),
    editMode,
    ...(compactStrategy !== 'standard' ? { compactStrategy } : {}),
    ...(smartCompactEnabled ? { smartCompactEnabled: true } : {}),
    ...(smartCompactSummaryModel ? { smartCompactSummaryModel } : {}),
    ...(smartCompactMode ? { smartCompactMode } : {}),
    // 记忆可在会话中途打开，语言始终下发
    memoryLanguage,
    ...(skillPaths.length > 0 ? { skillPaths } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(pluginTools.length > 0 ? { pluginTools } : {}),
    ...(secretary?.tools?.length ? { secretaryTools: [...secretary.tools] } : {}),
    ...(workflowPresetFiles.length > 0 ? { workflowPresetFiles } : {}),
    ...(pluginEvents ? { pluginEvents } : {}),
    ...(presetApplied.approvalMode ? { approvalMode: presetApplied.approvalMode } : {}),
    ...(request.autoRejectApprovals === true ? { autoRejectApprovals: true } : {}),
    ...(request.askRelay ? { askRelay: request.askRelay } : {}),
    ...(request.planMode !== undefined ? { planMode: request.planMode } : {}),
    ...approvalReviewerSpawnFields(approvalReviewerSource),
    ...(agentTypes.length > 0 ? { agentTypes } : {}),
    ...(subagentModels.length > 0 ? { subagentModels } : {}),
    ...(presetApplied.disabledTools.length > 0
      ? { disabledTools: presetApplied.disabledTools }
      : {}),
    ...(instruction ? { instruction } : {}),
    ...(remote ? { remote } : {}),
    ...(options?.rolePrompt ? { rolePrompt: options.rolePrompt } : {}),
    ...(promptKit.systemPrompt ? { systemPrompt: promptKit.systemPrompt } : {}),
    // 预设/插件尾段在前，调用方（headless run 等宿主）注入的追加段在后
    ...([promptKit.systemPromptAppend, request.systemPromptAppend].filter(Boolean).length > 0
      ? {
          systemPromptAppend: [promptKit.systemPromptAppend, request.systemPromptAppend]
            .filter(Boolean)
            .join('\n\n'),
        }
      : {}),
    ...(promptKit.systemPromptBoost ? { systemPromptBoost: promptKit.systemPromptBoost } : {}),
    ...(promptKit.refusalRetryPrompt ? { refusalRetryPrompt: promptKit.refusalRetryPrompt } : {}),
    ...(options?.bot ? { botMode: true } : {}),
    ...(secretary ? { secretaryMode: true } : {}),
    ...(options?.bot?.groupTasks ? { botGroupTasks: true } : {}),
    ...(options?.bot?.groupTasks && options.bot.discussMode ? { botDiscussMode: true } : {}),
    ...(options?.bot?.routines ? { botRoutines: true } : {}),
    ...(options?.bot?.delegationTask ? { botDelegationTask: true } : {}),
    ...(options?.bot?.writeLock ? { botWriteLock: options.bot.writeLock } : {}),
    ...(options?.bot || state?.protectedActionsInCode === true ? { protectedActions: true } : {}),
    ...(options?.instanceId ? { instanceId: options.instanceId } : {}),
    ...(options?.forkFrom ? { forkFrom: options.forkFrom } : {}),
  });
  if (sent.ok) {
    builtinToolScopes.remember(
      identity,
      projectId,
      extraDisabledTools,
      presetApplied.disabledTools,
      secretary ? SECRETARY_ALWAYS_ENABLED_TOOLS : []
    );
    rememberParentInstance(identity.sessionId, options?.instanceId);
    rememberParentToolProfile(identity.sessionId, {
      editMode,
      shell: childProfileShell({
        platform: process.platform,
        remote: remote !== undefined,
        preference: windowsLocalShell,
      }),
      exploreFold: exploreFoldEnabled,
      isolatedSandbox: !presetApplied.disabledTools.includes('isolated_sandbox'),
      workspaceWrite: !presetApplied.disabledTools.includes(WORKSPACE_WRITE_TOOL_ID),
    });
  }
  return sent;
}

const APPROVAL_RANK: Record<ApprovalMode, number> = {
  supervised: 3,
  'auto-edits': 2,
  assistant: 1,
  full: 1,
};

export interface PluginPresetSpawnOverrides {
  model?: { providerId: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  approvalMode?: Extract<ApprovalMode, 'supervised' | 'auto-edits'>;
  disabledTools?: readonly string[];
}

/** 插件预设覆盖：模型以预设为准，思考档覆盖，审批取更严，禁用工具并入 */
/** 插件预设自带指令则替换全局指令，否则沿用全局指令 */
export function pluginPresetInstruction<T>(
  own: T | undefined,
  global: () => T | undefined
): T | undefined {
  return own ?? global();
}

/** spawn 前斜杠菜单要预览的插件 skill 路径，与 spawn 同口径：Enso 插件按生效的插件预设圈定 */
export function pluginSkillPathsForMenu(
  presetId: string | undefined,
  deps: {
    resolve: (id?: string) => Preset | undefined;
    extension: {
      presetForSpawn(id?: string): { ok: boolean } | undefined;
      skillPathsForSpawn(activePresetId?: string): string[];
    } | null;
  }
): string[] {
  const active = activePluginPresetsForMenu(presetId, deps.resolve, deps.extension);
  if (!deps.extension) return [];
  if (active.length === 0) return deps.extension.skillPathsForSpawn(undefined);
  return [...new Set(active.flatMap((id) => deps.extension!.skillPathsForSpawn(id)))];
}

function activePluginPresetsForMenu(
  presetId: string | undefined,
  resolve: (id?: string) => Preset | undefined,
  extension: { presetForSpawn(id?: string): { ok: boolean } | undefined } | null
): string[] {
  const { pluginPresetIds } = presetOverlay(presetId, resolve);
  return (pluginPresetIds ?? []).filter((id) => extension?.presetForSpawn(id)?.ok);
}

export function menuPluginSkillPaths(presetId: string | undefined): string[] {
  return pluginSkillPathsForMenu(presetId, {
    resolve: resolvePreset,
    extension: getExtensionPlugins(),
  });
}

/** 侧栏列 workflow 预设时的插件文件，与 spawn 同口径按生效的插件预设圈定 */
export function menuPluginWorkflowPaths(presetId: string | undefined): string[] {
  const extension = getExtensionPlugins();
  const active = activePluginPresetsForMenu(presetId, resolvePreset, extension);
  if (active.length === 0) return extension.workflowPathsForSpawn(undefined);
  return [...new Set(active.flatMap((id) => extension.workflowPathsForSpawn(id)))];
}

interface PresetPromptKit {
  systemPrompt?: string;
  systemPromptAppend?: string;
  systemPromptBoost?: string;
  refusalRetryPrompt?: string;
}

/** 尾段自建在前、插件在后拼接；角色/加强/推脱补发以插件为准 */
export function mergePresetPromptKit(
  own: PresetPromptKit,
  plugin?: PresetPromptKit
): PresetPromptKit {
  const pick = (key: keyof PresetPromptKit) => {
    const value = plugin?.[key] || own[key];
    return value ? { [key]: value } : {};
  };
  const tail = [own.systemPromptAppend, plugin?.systemPromptAppend].filter(Boolean).join('\n\n');
  return {
    ...pick('systemPrompt'),
    ...(tail ? { systemPromptAppend: tail } : {}),
    ...pick('systemPromptBoost'),
    ...pick('refusalRetryPrompt'),
  };
}

/** 多个插件预设的指令按勾选顺序拼接成一份；都没有则 undefined（沿用全局指令） */
function mergePluginInstructions(
  kits: readonly { instruction?: { path: string; content: string } }[]
): { path: string; content: string } | undefined {
  const present = kits.flatMap((kit) => (kit.instruction ? [kit.instruction] : []));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return {
    path: present.map((item) => item.path).join(' + '),
    content: present.map((item) => item.content).join('\n\n'),
  };
}

/** 路径并集去重，保持先出现顺序 */
function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/** 多个插件预设的子代理类型并集：同名（trim + 小写）后者覆盖前者，与勾选顺序一致 */
function mergePluginAgentTypes(
  groups: readonly (readonly NativePluginAgentDef[])[]
): NativePluginAgentDef[] {
  const ordered: NativePluginAgentDef[] = [];
  const indexByName = new Map<string, number>();
  for (const def of groups.flat()) {
    const key = def.name.trim().toLowerCase();
    const existing = indexByName.get(key);
    if (existing === undefined) {
      indexByName.set(key, ordered.length);
      ordered.push(def);
    } else {
      ordered[existing] = def;
    }
  }
  return ordered;
}

/** 多个插件预设的提示词合并：尾段按勾选顺序全部拼接；角色/加强/推脱补发后者覆盖前者 */
export function mergePluginPresetKits(
  kits: readonly Omit<PresetPromptKit, never>[]
): PresetPromptKit {
  const merged: PresetPromptKit = {};
  const tails: string[] = [];
  for (const kit of kits) {
    if (kit.systemPrompt) merged.systemPrompt = kit.systemPrompt;
    if (kit.systemPromptAppend) tails.push(kit.systemPromptAppend);
    if (kit.systemPromptBoost) merged.systemPromptBoost = kit.systemPromptBoost;
    if (kit.refusalRetryPrompt) merged.refusalRetryPrompt = kit.refusalRetryPrompt;
  }
  if (tails.length > 0) merged.systemPromptAppend = tails.join('\n\n');
  return merged;
}

/** 多个插件预设的单值覆盖合并：模型/思考档后者覆盖前者，审批取最严，禁用工具并集 */
export function mergePluginPresetOverrides(
  list: readonly (PluginPresetSpawnOverrides | undefined)[]
): PluginPresetSpawnOverrides | undefined {
  let merged: PluginPresetSpawnOverrides | undefined;
  for (const item of list) {
    if (!item) continue;
    const disabledTools = [
      ...new Set([...(merged?.disabledTools ?? []), ...(item.disabledTools ?? [])]),
    ];
    const approvalMode = stricterPresetApproval(merged?.approvalMode, item.approvalMode);
    merged = {
      ...(item.model ? { model: item.model } : merged?.model ? { model: merged.model } : {}),
      ...(item.thinkingLevel
        ? { thinkingLevel: item.thinkingLevel }
        : merged?.thinkingLevel
          ? { thinkingLevel: merged.thinkingLevel }
          : {}),
      ...(approvalMode ? { approvalMode } : {}),
      ...(disabledTools.length > 0 ? { disabledTools } : {}),
    };
  }
  return merged;
}

export function applyPluginPresetOverrides<T>(input: {
  model: T;
  thinkingLevel?: ThinkingLevel;
  approvalMode?: ApprovalMode;
  disabledTools: readonly string[];
  preset?: PluginPresetSpawnOverrides;
  resolveModel: (model: {
    providerId: string;
    modelId: string;
  }) => { ok: true; model: T } | { ok: false; error: string };
}):
  | {
      ok: true;
      model: T;
      thinkingLevel?: ThinkingLevel;
      approvalMode?: ApprovalMode;
      disabledTools: string[];
    }
  | { ok: false; error: string } {
  let model = input.model;
  if (input.preset?.model) {
    const resolved = input.resolveModel(input.preset.model);
    if (!resolved.ok) return resolved;
    model = resolved.model;
  }
  const approvalMode = stricterApprovalMode(input.approvalMode, input.preset?.approvalMode);
  const disabledTools = [...input.disabledTools];
  for (const id of input.preset?.disabledTools ?? []) {
    if (!disabledTools.includes(id)) disabledTools.push(id);
  }
  const thinkingLevel = input.preset?.thinkingLevel ?? input.thinkingLevel;
  return {
    ok: true,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(approvalMode ? { approvalMode } : {}),
    disabledTools,
  };
}

function stricterApprovalMode(
  current: ApprovalMode | undefined,
  preset: Extract<ApprovalMode, 'supervised' | 'auto-edits'> | undefined
): ApprovalMode | undefined {
  if (!preset) return current;
  if (!current) return preset;
  return APPROVAL_RANK[preset] > APPROVAL_RANK[current] ? preset : current;
}

/** 两个插件预设级审批（只可能是 supervised/auto-edits）取更严 */
function stricterPresetApproval(
  current: Extract<ApprovalMode, 'supervised' | 'auto-edits'> | undefined,
  next: Extract<ApprovalMode, 'supervised' | 'auto-edits'> | undefined
): Extract<ApprovalMode, 'supervised' | 'auto-edits'> | undefined {
  if (!next) return current;
  if (!current) return next;
  return APPROVAL_RANK[next] > APPROVAL_RANK[current] ? next : current;
}

function readPluginPresetOverrides(preset: object): PluginPresetSpawnOverrides | undefined {
  const value = preset as {
    model?: unknown;
    thinkingLevel?: unknown;
    approvalMode?: unknown;
    disabledTools?: unknown;
  };
  const modelRecord =
    value.model && typeof value.model === 'object' && !Array.isArray(value.model)
      ? (value.model as { providerId?: unknown; modelId?: unknown })
      : undefined;
  const model =
    modelRecord &&
    typeof modelRecord.providerId === 'string' &&
    typeof modelRecord.modelId === 'string'
      ? { providerId: modelRecord.providerId, modelId: modelRecord.modelId }
      : undefined;
  const thinkingLevel = (THINKING_LEVELS as readonly unknown[]).includes(value.thinkingLevel)
    ? (value.thinkingLevel as ThinkingLevel)
    : undefined;
  const approvalMode =
    value.approvalMode === 'supervised' || value.approvalMode === 'auto-edits'
      ? value.approvalMode
      : undefined;
  const disabledTools = Array.isArray(value.disabledTools)
    ? value.disabledTools.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : undefined;
  if (!model && !thinkingLevel && !approvalMode && !disabledTools?.length) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(approvalMode ? { approvalMode } : {}),
    ...(disabledTools?.length ? { disabledTools } : {}),
  };
}

function readPresetPrompt(id?: string): { ok: true; content?: string } | { ok: false } {
  if (!id) return { ok: true };
  const result = readStoredSystemPrompt(id);
  return result.ok ? { ok: true, content: result.content } : { ok: false };
}

export function resolvePresetPromptKit(preset?: Preset):
  | {
      ok: true;
      systemPrompt?: string;
      systemPromptAppend?: string;
      systemPromptBoost?: string;
      refusalRetryPrompt?: string;
    }
  | { ok: false } {
  if (!preset) return { ok: true };
  const role = readPresetPrompt(preset.systemPromptId);
  const tail = readPresetPrompt(preset.systemPromptTailId);
  const boost = readPresetPrompt(preset.boostPromptId);
  const retry = readPresetPrompt(preset.refusalRetryPromptId);
  if (!role.ok || !tail.ok || !boost.ok || !retry.ok) return { ok: false };
  return {
    ok: true,
    ...(role.content ? { systemPrompt: role.content } : {}),
    ...(tail.content ? { systemPromptAppend: tail.content } : {}),
    ...(boost.content ? { systemPromptBoost: boost.content } : {}),
    ...(preset.refusalRetry === true && retry.content ? { refusalRetryPrompt: retry.content } : {}),
  };
}

export function resolvePresetSystemPrompt(
  preset?: Pick<Preset, 'systemPromptId'>
): { ok: true; content?: string } | { ok: false } {
  const result = readPresetPrompt(preset?.systemPromptId);
  if (!result.ok) return { ok: false };
  return { ok: true, ...(result.content ? { content: result.content } : {}) };
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
  const sent = sendAgentCommand({ type: 'set-model', identity, model: resolved.selection.config });
  if (sent.ok) gracefulRestart.recordModel(identity, providerId, modelId);
  return sent;
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
  task: AgentDispatchTask,
  requestBudget = false
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'prompt-child',
    identity,
    requestId,
    task,
    ...(requestBudget ? { requestBudget: true } : {}),
  });
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

export function sendSecretaryResultToSession(
  identity: SessionIdentity,
  requestId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: string }
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'secretary-result', identity, requestId, ...outcome });
}

export function sendComputerResultToSession(
  identity: SessionIdentity | ChildSessionIdentity,
  requestId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: string }
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'computer-result', identity, requestId, ...outcome });
}

export function sendPluginToolResultToSession(
  identity: SessionIdentity,
  requestId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: string }
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'plugin-tool-result', identity, requestId, ...outcome });
}

export function sendPluginToolProgressToSession(
  identity: SessionIdentity,
  requestId: string,
  text: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'plugin-tool-progress', identity, requestId, text });
}

export function sendPluginInterceptResultToSession(
  identity: SessionIdentity,
  requestId: string,
  outcome: { ok: true; result?: unknown } | { ok: false; error: string }
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'plugin-intercept-result', identity, requestId, ...outcome });
}

export function registerPluginSessionBridge(
  lookup: (sessionId: string) => SessionIdentity | undefined,
  /** 投递前统一判定来源和不可信包裹 */
  prepare?: (sessionId: string, input: PluginInjectPrepareInput) => PluginInjectDeliveryDecision
): void {
  setPluginSessionBridge({
    inject(sessionId, message) {
      const {
        images,
        text: rawText,
        trusted: _trusted,
        requestedTrusted,
        permissions,
        source,
        sender,
        ...rest
      } = message;
      const decision = prepare?.(sessionId, {
        pluginId: message.pluginId,
        text: rawText,
        requestedTrusted,
        permissions,
        source,
        sender,
      });
      const text = decision?.text ?? rawText;
      if (text.length > PLUGIN_INJECT_WIRE_MAX_CHARS) return { ok: false, error: '注入文本过长' };
      const identity = lookup(sessionId);
      if (!identity) return { ok: false, error: '会话不在运行', notRunning: true };
      const sent = sendAgentCommand({
        type: 'plugin-inject',
        identity,
        ...rest,
        text,
        ...(decision?.origin ? { origin: decision.origin } : {}),
        ...(sender ? { sender } : {}),
        ...(typeof decision?.ownerConfirm === 'boolean'
          ? { ownerConfirm: decision.ownerConfirm }
          : {}),
        ...(images.length ? { images } : {}),
      });
      if (!sent.ok) return { ok: false, error: sent.error ?? '无法注入消息' };
      return {
        ok: true,
        ...(decision?.trustedIgnored ? { trustedIgnored: true } : {}),
        ...(decision?.trustedOverriddenByExternal ? { trustedOverriddenByExternal: true } : {}),
      };
    },
    abort(sessionId) {
      const identity = lookup(sessionId);
      if (!identity) return { ok: false, error: '会话不在运行' };
      const sent = abortSession(identity);
      return sent.ok ? { ok: true } : { ok: false, error: sent.error ?? '无法中止会话' };
    },
    agentRun(sessionId, input, onEvent) {
      const identity = lookup(sessionId);
      if (!identity) return { ok: false, error: '会话不在运行', notRunning: true };
      return pluginAgents.start(identity, input, onEvent);
    },
    async resolveModel(choice) {
      const keys = await readStoredOauthCredentialKeys();
      if (choice === 'title') {
        // 标题模型 → 全局默认；都不可用就跟随会话
        for (const ref of titleModelCandidates(readSettingsState())) {
          const resolved = resolveModelSelection(ref.providerId, ref.modelId, keys);
          if (resolved.ok) return { ok: true, model: resolved.selection.config };
        }
        return { ok: true };
      }
      const resolved = resolveModelSelection(choice.providerId, choice.modelId, keys);
      return resolved.ok
        ? { ok: true, model: resolved.selection.config }
        : { ok: false, error: `插件设置的模型不可用：${resolved.error}` };
    },
  });
}

export function setSessionThinking(
  identity: SessionIdentity,
  level: ThinkingLevel
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'set-thinking', identity, level });
}

/** 秘书档案改了：活着的会话就地换系统提示词，不重建、不丢历史 */
export function setSessionSystemPrompt(
  identity: SessionIdentity,
  systemPrompt: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'set-system-prompt', identity, systemPrompt });
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
  images: AttachedImage[] | undefined,
  /** 未送达时 worker 按它回执 delivery-rejected；调用方没有自己的号就现生成一个 */
  deliveryId: string,
  /** 带新消息的断点续跑：worker 先移出未完成的最后一条 assistant 再 prompt */
  resume?: true
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'prompt',
    identity,
    text,
    ...(images?.length ? { images } : {}),
    deliveryId,
    ...(resume ? { resume } : {}),
    ...instanceField(identity),
  });
}

export function steerSession(
  identity: SessionIdentity,
  text: string,
  images?: AttachedImage[],
  deliveryId?: string,
  activeOnly?: true
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'steer',
    identity,
    text,
    ...(images?.length ? { images } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(activeOnly ? { activeOnly } : {}),
    ...instanceField(identity),
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
  /** 连通性探测：模型已响应但正文为空（被预算截断 / 只输出思考）也算完成 */
  probe?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  if (!worker || !workerReady) return Promise.reject(new Error('Agent worker is not running.'));
  if (input.signal?.aborted) return Promise.reject(new Error('aborted'));
  const requestId = input.requestId?.trim() || randomUUID();
  const { requestId: _requestId, stream, reasoning, probe, signal, ...rest } = input;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    // 每个候选各自 timeoutMs，整体再留一点余量做兑底
    const timer = setTimeout(
      () => {
        pendingCompletions.delete(requestId);
        finish(() => reject(new Error('completion timed out')));
      },
      rest.timeoutMs * rest.candidates.length + 5_000
    );
    const onAbort = () => {
      if (!pendingCompletions.delete(requestId)) return;
      finish(() => reject(new Error('aborted')));
      sendAgentCommand({ type: 'abort-complete-text', requestId });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingCompletions.set(requestId, {
      resolve: (text) => finish(() => resolve(text)),
      reject: (error) => finish(() => reject(error)),
    });
    const posted = sendAgentCommand({
      type: 'complete-text',
      requestId,
      ...rest,
      ...(stream ? { stream: true as const } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(probe ? { probe: true as const } : {}),
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

/** release 等待者：sessionId → resolve。parent-ended / parent-rejected 回流或 worker 退出时唤醒 */
const releaseWaiters = new Map<string, (() => void)[]>();

function resolveReleaseWaiters(event: AgentWorkerEvent): void {
  if (event.type !== 'parent-ended' && event.type !== 'parent-rejected') return;
  const waiters = releaseWaiters.get(event.identity.sessionId);
  if (!waiters) return;
  releaseWaiters.delete(event.identity.sessionId);
  for (const resolve of waiters) resolve();
}

function resolveAllReleaseWaiters(): void {
  const waiters = [...releaseWaiters.values()].flat();
  releaseWaiters.clear();
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
  // worker 未就绪（未启动 / 已崩溃 / 已 fork 未 spawn）时进程里还没有任何会话，根会话只能由积压的
  // spawn-parent 建出。两者都没有就无树可释放：照常下发会让崩溃后的 worker 白白重启，
  // 新 worker 对不存在的会话静默丢弃 release-parent，调用方只能空等到超时。
  if (
    !workerReady &&
    !('parent' in identity) &&
    !commandsPending.some(
      (command) =>
        command.type === 'spawn-parent' &&
        command.identity.sessionId === identity.sessionId &&
        command.identity.generation === identity.generation
    )
  ) {
    return Promise.resolve({ ok: true });
  }
  const posted = sendAgentCommand({ type: 'release-parent', identity });
  if (!posted.ok) return Promise.resolve(posted);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 超时兜底：不永久挂起调用方；调用方拿到失败后不会继续建 worktree
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

export function withdrawSteerSession(
  identity: SessionIdentity,
  deliveryId: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'withdraw-steer', identity, deliveryId });
}

/** 终态失败后手动续跑：不新增 user 消息，从当前上下文 continue */
export function retrySession(
  identity: SessionIdentity | ChildSessionIdentity,
  unfinishedOnly = false,
  run?: { turnId: string; requestBudget?: boolean; requestsUsed?: number }
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'retry',
    identity,
    ...instanceField(identity),
    ...(unfinishedOnly ? { unfinishedOnly: true as const } : {}),
    ...(run ? { turnId: run.turnId } : {}),
    ...(run?.requestBudget ? { requestBudget: true as const } : {}),
    ...(run?.requestsUsed ? { requestsUsed: run.requestsUsed } : {}),
  });
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
  answer: string,
  /** 谁答的：缺省是用户亲手答；relay 是秘书代答，原会话据此显示「X 已回答」 */
  meta?: { by?: 'user' | 'relay'; name?: string }
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'ask-respond',
    identity,
    requestId,
    answer,
    ...(meta?.by ? { by: meta.by } : {}),
    ...(meta?.name ? { name: meta.name } : {}),
  });
}

/** 秘书派出/跟踪的会话：把 ask_user 转给它；relay 缺省表示恢复成直接问用户 */
export function setSessionAskRelay(
  identity: SessionIdentity,
  relay?: { name: string }
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'set-ask-relay',
    identity,
    ...(relay ? { relay } : {}),
  });
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
  anchor: { entryId: string } | { turnIndexFromEnd: number }
): { ok: boolean; error?: string } {
  return sendAgentCommand({
    type: 'fork',
    identity,
    targetConversationId,
    ...('entryId' in anchor
      ? { entryId: anchor.entryId }
      : { turnIndexFromEnd: anchor.turnIndexFromEnd }),
  });
}

/** 按会话 id 停：会话不必已打开，worker 校验任务归属 */
export function stopBackgroundTask(
  sessionId: string,
  taskId: string
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'task-stop', sessionId, taskId });
}

/** 手动保留（reason 为 null 取消保留） */
export function keepBackgroundTask(
  sessionId: string,
  taskId: string,
  reason: string | null
): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'task-keep', sessionId, taskId, reason });
}

/** 清掉根会话及其子会话的自定提醒（用户停止、删除、会话已不可用） */
export function clearSessionReminders(sessionId: string): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'reminders-clear', sessionId });
}

/** 把已到点的自定提醒交给会话（会话已在 worker 里） */
export function fireSessionReminders(sessionId: string): { ok: boolean; error?: string } {
  return sendAgentCommand({ type: 'reminders-fire', sessionId });
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
  authenticatedAccountKeys: ReadonlySet<string> = new Set(),
  autoReject?: boolean
): { ok: boolean; error?: string } {
  if (mode === 'assistant') {
    const reviewer = resolveApprovalReviewer(authenticatedAccountKeys);
    if (!reviewer.ok) return reviewer;
    if (!reviewer.source) {
      return { ok: false, error: 'Select an assistant approval model in Settings first.' };
    }
    pushApprovalReviewer(authenticatedAccountKeys);
  }
  return sendAgentCommand({
    type: 'set-approval-mode',
    identity,
    mode,
    ...(autoReject === undefined ? {} : { autoReject }),
  });
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
  nativePluginAgents?: readonly NativePluginAgentDef[]
): AgentTypeSpawnConfig[] {
  const state = readSettingsState();
  const disabled = new Set(
    Array.isArray(state?.disabledBuiltinAgentTypes)
      ? state.disabledBuiltinAgentTypes.filter((name): name is string => typeof name === 'string')
      : []
  );
  const custom = withPluginAgentTypes(
    Array.isArray(state?.agentTypes) ? state.agentTypes.filter(isAgentTypeEntry) : [],
    nativePluginAgents
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
        ? resolveModelSelection(entry.providerId, entry.modelId, authenticatedAccountKeys, {
            allowVirtual: true,
          })
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
          ? resolveModelSelection(entry.providerId, entry.modelId, authenticatedAccountKeys, {
              allowVirtual: true,
            })
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
        // 与 custom 分支/resolveAgentTypeSpawnConfig 同口径：白名单过滤，非法不透传
        ...(MODEL_REASONING_OVERRIDES.includes(entry.reasoning as ModelReasoningOverride)
          ? { reasoning: entry.reasoning as ModelReasoningOverride }
          : {}),
        ...(MODEL_THINKING_LEVEL_OVERRIDES.includes(
          entry.thinkingLevel as ModelThinkingLevelOverride
        )
          ? { thinkingLevel: entry.thinkingLevel as ModelThinkingLevelOverride }
          : {}),
      };
    }
  );
  return [...builtins, ...customs, ...members];
}

function resolveConfiguredSubagentSelection(
  ref: SubagentModelRef,
  authenticatedAccountKeys: ReadonlySet<string>
): ResolvedModelSelection | undefined {
  const resolved = resolveModelSelection(
    ref.providerId,
    ref.modelId,
    authenticatedAccountKeys,
    isVirtualRef(ref) ? { allowVirtual: true } : undefined
  );
  if (!resolved.ok) return undefined;
  return {
    ...resolved.selection,
    config: {
      ...resolved.selection.config,
      ...(ref.reasoning ? { reasoning: ref.reasoning } : {}),
      ...(ref.thinkingLevel ? { thinkingLevel: ref.thinkingLevel } : {}),
    },
  };
}

interface ConfiguredSubagentSelection {
  name: string;
  description?: string;
  selection: ResolvedModelSelection;
}

function listConfiguredSubagentSelections(
  authenticatedAccountKeys: ReadonlySet<string>
): ConfiguredSubagentSelection[] {
  const state = readSettingsState();
  if (state?.subagentModelsEnabled !== true) return [];
  const entries = Array.isArray(state.subagentModels)
    ? state.subagentModels.filter(isSubagentModelEntry)
    : [];
  const selections: ConfiguredSubagentSelection[] = [];
  for (const ref of pickSubagentModelRefs(
    entries,
    providersFromSettings(),
    virtualModelsFromSettings()
  )) {
    const selection = resolveConfiguredSubagentSelection(ref, authenticatedAccountKeys);
    if (!selection) continue;
    selections.push({
      name: ref.name,
      ...(ref.description ? { description: ref.description } : {}),
      selection,
    });
  }
  return selections;
}

/** 设置页「允许子代理指定模型」列表 → 解析凭证后随 spawn-parent 下发（开关关闭/不可用静默跳过） */
function configuredSubagentModels(
  authenticatedAccountKeys: ReadonlySet<string>
): SubagentModelOption[] {
  return listConfiguredSubagentSelections(authenticatedAccountKeys).map(
    ({ name, description, selection }) => ({
      name,
      config: selection.config,
      ...(description ? { description } : {}),
    })
  );
}

export function resolveSubagentModelSelection(
  name: string,
  authenticatedAccountKeys: ReadonlySet<string>
): { ok: true; selection: ResolvedModelSelection } | { ok: false; error: string } {
  const selected = listConfiguredSubagentSelections(authenticatedAccountKeys).find(
    (entry) => entry.name === name
  );
  if (!selected) return { ok: false, error: `Subagent model is unavailable: ${name}` };
  return { ok: true, selection: selected.selection };
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

/** 秘书的 skill：启用的自有目录总是挂，全局 skill 只挂勾选的 */
function secretarySkillPaths(
  secretary?: { skillIds?: readonly string[]; skillDirs?: readonly string[] } | undefined
): string[] {
  if (!secretary) return [];
  const ids = secretary.skillIds ?? [];
  const state = readSettingsState();
  const skills = Array.isArray(state?.skills) ? state.skills.filter(isSkillEntry) : [];
  const picked = skills.filter((skill) => ids.includes(skill.id)).map((skill) => skill.path);
  return [...(secretary.skillDirs ?? []), ...picked];
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
  const headers = server.transport === 'stdio' ? undefined : mcpHeaders(server.headers);
  // 自配 Authorization 优先：worker 那边也不会再注入 OAuth token
  const ownAuth = Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'authorization');
  const oauth =
    server.transport === 'stdio' || ownAuth ? undefined : getMcpOAuthStore().access(server.id);
  return {
    ...(server.id ? { id: server.id } : {}),
    name: server.name,
    ...(server.description?.trim() ? { description: server.description.trim() } : {}),
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(headers ? { headers } : {}),
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

export function asModelRef(value: unknown): DefaultModelRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { providerId?: unknown; modelId?: unknown };
  return typeof candidate.providerId === 'string' &&
    candidate.providerId.trim() &&
    typeof candidate.modelId === 'string' &&
    candidate.modelId.trim()
    ? { providerId: candidate.providerId, modelId: candidate.modelId }
    : null;
}

export type ApprovalReviewerSource =
  | { model: SpawnModelConfig }
  | {
      classifier: VirtualClassifierCredentials;
      managed?: true;
      allowThreshold?: ApprovalAllowThreshold;
    };

/** 代审来源：分类器专用供应商（如 Jev）走分类器，其余按聊天模型解析 */
export function resolveApprovalReviewer(
  authenticatedAccountKeys: ReadonlySet<string>
): { ok: false; error: string } | { ok: true; source: ApprovalReviewerSource | null } {
  const ref = asModelRef(readSettingsState()?.approvalReviewer);
  if (!ref) return { ok: true, source: null };
  const provider = providersFromSettings().find((item) => item.id === ref.providerId);
  if (provider && isClassifierOnlyProvider(provider)) {
    const classifier = classifierCredentialsFor(provider, ref.modelId, authenticatedAccountKeys);
    const state = readSettingsState();
    const managed = state?.approvalAutoManage === true;
    const allowThreshold = parseApprovalAllowThreshold(state?.approvalAllowThreshold);
    return classifier
      ? {
          ok: true,
          source: {
            classifier,
            ...(managed ? { managed: true as const } : {}),
            ...(allowThreshold === DEFAULT_APPROVAL_ALLOW_THRESHOLD ? {} : { allowThreshold }),
          },
        }
      : { ok: false, error: 'The assistant approval classifier is unavailable.' };
  }
  const resolved = resolveModelSelection(ref.providerId, ref.modelId, authenticatedAccountKeys);
  return resolved.ok
    ? { ok: true, source: { model: resolved.selection.config } }
    : { ok: false, error: resolved.error };
}

function approvalReviewerSpawnFields(source: ApprovalReviewerSource | null | undefined) {
  if (!source) return {};
  return 'model' in source
    ? { approvalReviewer: source.model }
    : {
        approvalReviewerClassifier: source.classifier,
        ...(source.managed ? { approvalReviewerManaged: true as const } : {}),
        ...(source.allowThreshold === undefined
          ? {}
          : { approvalReviewerAllowThreshold: source.allowThreshold }),
      };
}

export function pushApprovalReviewer(authenticatedAccountKeys?: ReadonlySet<string>): void {
  if (!worker || !workerReady) return;
  const keys = authenticatedAccountKeys ?? new Set<string>();
  const resolved = resolveApprovalReviewer(keys);
  const source = resolved.ok ? resolved.source : null;
  worker.postMessage({
    type: 'set-approval-reviewer',
    ...(source
      ? 'model' in source
        ? { model: source.model }
        : {
            classifier: source.classifier,
            ...(source.managed ? { managed: true as const } : {}),
            ...(source.allowThreshold === undefined
              ? {}
              : { allowThreshold: source.allowThreshold }),
          }
      : {}),
  } satisfies AgentCommand);
}

/** 已打开会话的下一次压缩用当前摘要模型，不沿用 spawn 时的那份 */
export function pushCompactRoute(authenticatedAccountKeys?: ReadonlySet<string>): void {
  if (!worker || !workerReady) return;
  const state = readSettingsState();
  const strategy = resolveCompactStrategy(state?.compactStrategy, state?.smartCompactEnabled);
  const ref = asModelRef(state?.smartCompactModel);
  const resolved =
    strategy !== 'standard' && ref
      ? resolveModelSelection(ref.providerId, ref.modelId, authenticatedAccountKeys ?? new Set())
      : undefined;
  const model = resolved?.ok ? resolved.selection.config : undefined;
  const mode = parseSmartCompactMode(state?.smartCompactMode) ?? undefined;
  worker.postMessage({
    type: 'set-compact-route',
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
  } satisfies AgentCommand);
}

export function pushMaxActiveCoworkers(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-max-active-coworkers',
    limit: normalizeMaxActiveCoworkers(readSettingsState()?.maxActiveCoworkers),
  } satisfies AgentCommand);
}

export function pushAutoRetryLimit(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-auto-retry-limit',
    limit: normalizeAutoRetryLimit(readSettingsState()?.autoRetryLimit),
  } satisfies AgentCommand);
}

export function pushLongCacheRetention(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-long-cache-retention',
    enabled: readSettingsState()?.longCacheRetention === true,
  } satisfies AgentCommand);
}

/** worker 跟随 Main 当前的应用日志开关 */
export function pushAppLogging(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-app-logging',
    enabled: isAppLoggingEnabled(),
  } satisfies AgentCommand);
}

export function pushPrivacyMasking(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-privacy-masking',
    settings: parsePrivacyMaskSettings(readSettingsState()?.privacyMasking),
  } satisfies AgentCommand);
}

export function pushDisabledWorkflowPresets(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-disabled-workflow-presets',
    ids: parseDisabledWorkflowPresets(readSettingsState()?.disabledWorkflowPresets),
  } satisfies AgentCommand);
}

/** 全局 settings.shell（命令时限回退开关），与 worker 侧同一个 resolveShellLimits 解析 */
export function resolveShellLimitsSetting(): ShellLimits {
  return resolveShellLimits(readSettingsState()?.shell);
}

export function pushShellLimits(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-shell-limits',
    limits: resolveShellLimitsSetting(),
  } satisfies AgentCommand);
}

/** 内置工具开关变化后推给已开的父会话；只推结果变了的会话 */
export function pushBuiltinTools(): void {
  if (!worker || !workerReady) return;
  for (const change of builtinToolScopes.changes(
    readSettingsState(),
    isComputerPlatformSupported()
  )) {
    worker.postMessage({ type: 'set-builtin-tools', ...change } satisfies AgentCommand);
  }
}

export function resolveWebSearchConfig(): { chain: WebSearchChainEntry[]; configured: boolean } {
  const rawChain = parseWebSearchChain(readSettingsState()?.webSearchChain);
  const providers = providersFromSettings();
  const chain: WebSearchChainEntry[] = [];
  for (const entry of rawChain) {
    const provider = providers.find((p) => p.id === entry.providerId);
    if (!provider || provider.enabled === false || provider.oauthAccountPool !== undefined)
      continue;
    if (
      !Array.isArray(provider.models) ||
      !provider.models.some((model) => model?.id === entry.modelId && model.enabled !== false)
    )
      continue;
    if (
      !provider.oauthAccountKey &&
      (typeof provider.api !== 'string' ||
        typeof provider.baseUrl !== 'string' ||
        typeof provider.apiKey !== 'string')
    )
      continue;
    const runtimeProviderId = provider.oauthAccountKey ?? providerKeyFor(provider);
    chain.push({ providerId: runtimeProviderId, modelId: entry.modelId });
  }
  return { chain, configured: rawChain.length > 0 };
}

/** web_search 候选链推送：只发引用，凭证由 worker 调用时经 modelRegistry 现取。 */
export function pushWebSearchConfig(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-web-search-config',
    ...resolveWebSearchConfig(),
  } satisfies AgentCommand);
}

/** 设置失效同样下发 null，防止已打开会话沿用被撤销的生图模型和凭据。 */
export function pushImageGenerationConfig(): void {
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-image-generation-config',
    ...resolveImageGenerationConfig(
      readSettingsState()?.imageGenerationModel,
      providersFromSettings()
    ),
  } satisfies AgentCommand);
}

let modelDirectoryListenerBound = false;

function bindModelDirectoryListener(): void {
  if (modelDirectoryListenerBound) return;
  modelDirectoryListenerBound = true;
  onModelDirectoryChanged(() => {
    pushModelDirectory();
    pushWebSearchConfig();
    pushImageGenerationConfig();
  });
}

export function customProvidersForWorker(): WorkerCustomProvider[] {
  const out: WorkerCustomProvider[] = [];
  for (const item of providersFromSettings()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const provider = item as Partial<ModelProvider>;
    if (provider.oauthAccountKey) continue;
    if (typeof provider.id !== 'string' || provider.id.length === 0) continue;
    if (typeof provider.name !== 'string') continue;
    if (
      typeof provider.api !== 'string' ||
      typeof provider.baseUrl !== 'string' ||
      typeof provider.apiKey !== 'string'
    ) {
      continue;
    }
    if (!Array.isArray(provider.models)) continue;
    const headers = parseProviderHeaders(provider.headers);
    // 坏代理整条不下发：降级成跟随全局会把请求发到用户没选的出口
    const proxy = parseProviderProxy(provider.proxy);
    if (proxy === null) continue;
    out.push({
      settingsId: provider.id,
      name: provider.name,
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      models: provider.models,
      ...(headers ? { headers } : {}),
      ...(proxy ? { proxy } : {}),
    });
  }
  return out;
}

/** 把目录快照和自定义 provider 注册信息推给 worker。worker 未就绪时丢掉，ready 时会再推一次。 */
export function pushModelDirectory(): void {
  bindModelDirectoryListener();
  if (!worker || !workerReady) return;
  worker.postMessage({
    type: 'set-model-directory',
    snapshot: getModelDirectorySnapshot(),
    customProviders: customProvidersForWorker(),
  } satisfies AgentCommand);
}

export function readSettingsState(): Record<string, unknown> | undefined {
  return persistedSettingsState(readSettings()?.['enso-settings']);
}

export function virtualModelsFromSettings(): VirtualModelEntry[] {
  return parseVirtualModels(readSettingsState()?.virtualModels);
}

export function providersFromSettings(): ModelProvider[] {
  const providers = readSettingsState()?.providers;
  const raw = Array.isArray(providers)
    ? providers.filter(
        (provider): provider is ModelProvider =>
          Boolean(provider) &&
          typeof provider === 'object' &&
          typeof (provider as ModelProvider).id === 'string'
      )
    : [];
  // OAuth 条目的 models 只是稀疏覆盖；存在性、enabled 与凭证校验都看目录物化后的清单。
  const materialized = materializeProviders(raw, getModelDirectorySnapshot());
  return materialized;
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
  const headers = parseProviderHeaders(provider.headers);
  // 订阅条目不支持独立代理；坏值已在 resolvePhysicalModelSelection 拒绝
  const proxy = provider.oauthAccountKey ? undefined : parseProviderProxy(provider.proxy);
  return {
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelId,
    settingsProviderId: provider.id,
    ...(headers ? { headers } : {}),
    ...(proxy ? { proxy } : {}),
    ...(provider.oauthAccountKey ? { oauthAccountKey: provider.oauthAccountKey } : {}),
    ...(isOauthAccountPool(provider) ? { oauthAccountPool: provider.oauthAccountPool } : {}),
    // 统一目录后 OAuth 条目 models 只承载稀疏用户覆盖（enabled/别名/能力/档位），
    // 行覆盖对 OAuth 同样生效；旧守卫丢弃它们是因为那时行是 catalog 冻结拷贝。
    // 已知过渡窗口：renderer 水合才执行 v16 稀疏化，Main 先读（bot 自启/tray）时
    // v15 稠密行的 catalog 能力字段会被当覆盖透传——只影响子会话档位且水合后自愈，接受。
    ...pickModelCapabilityOverrides(entry),
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

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentSession,
  createAgentSession,
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  estimateTokens,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import {
  type ChildSessionIdentity,
  ENSO_LOCKED_PROFILE,
  isSameChildSessionIdentity,
  type SessionIdentity,
} from '@shared/builtinAgents';
import {
  findCatalogModelById,
  positiveContextWindow,
  resolveCustomModelCapabilities,
} from '@shared/modelCatalog';
import { ensureAccountProvider } from '@shared/piAccounts';
import { resolvePiProviderBaseUrl } from '@shared/providerCatalog';
import { ANTIGRAVITY_PROVIDER_ID, antigravityProviderConfig } from '@shared/providers/antigravity';
import { buildSshShellCommand, shellQuote } from '@shared/ssh';
import type {
  AgentCommand,
  AgentRemoteConfig,
  AgentSessionCustomEntry,
  AgentTypeSpawnConfig,
  AgentWorkerEvent,
  ApprovalMode,
  ChildConversationMetadata,
  CoworkerInfo,
  McpServerSpawnConfig,
  MessageTiming,
  ModelRef,
  NodeStatus,
  ProjectedMessage,
  ResolvedAgentTypeSpawnConfig,
  SessionSnapshot,
  SlashCommand,
  SpawnModelConfig,
  SubagentInfo,
  SubagentModelOption,
  ThinkingLevel,
} from '@shared/types/agent';
import { parseAgentSessionCustomEntry } from '@shared/types/agent';
import { providerIdOfAccountKey } from '@shared/types/oauthProviders';
import { version } from '../../package.json';
import { ApprovalGate, withApproval } from './approval';
import { AskManager, createAskTool } from './ask';
import {
  BackgroundTaskManager,
  createTaskTools,
  withBackground,
  withTaskReminders,
} from './backgroundTasks';
import { CheckpointManager, withCheckpoint } from './checkpoint/manager';
import { createRemoteCheckpointHost } from './checkpoint/remoteHost';
import { resolveChildReasoning } from './childReasoning';
import {
  collectContextOccupancy,
  type OccupancyBranchEntry,
  type OccupancySkill,
} from './contextOccupancy';
import { createCoworkerTool } from './coworker';
import { CURSOR_PROVIDER_ID, loadCursorProvider } from './cursor/loadProvider';
import { attachCursorBridgeToSession, isCursorModel } from './cursor/sessionBridge';
import { createLenientEditTool } from './editTool';
import { ENSO_SYSTEM_PROMPT } from './ensoPrompt';
import { EnsoSafeJournal } from './ensoSafeJournal';
import { OperationGate } from './gate';
import { createGoalTools } from './goal';
import { McpManager } from './mcp';
import { createMessageMainTool } from './messageMain';
import { ParentNotifier } from './notify';
import { projectMessage } from './projection';
import { applyWorkerProxyEnv } from './proxyEnv';
import {
  EVICTION_SWEEP_INTERVAL_MS,
  type EvictionCandidate,
  selectEvictable,
} from './sessionEviction';
import { branchSessionFromPersistedFile, resolveForkLeafId } from './sessionFork';
import {
  createSshExecutor,
  resolveSshControlPath,
  type SshExecutor,
  sshPasswordEnv,
} from './ssh/executor';
import { createRemoteGrepToolDefinition } from './ssh/remoteGrep';
import { createRemoteOperations } from './ssh/remoteOperations';
import { createSubagentTool, lastAssistantText } from './subagent';
import { buildTitleUserText, extractTitle, TITLE_SYSTEM_PROMPT } from './titleSummary';
import { createTodoTool } from './todo';
import { BrowserInvoker, createBrowserTools, withNavigateApproval } from './tools/browser';
import { createEnsoAppTool, EnsoAppInvoker } from './tools/ensoApp';
import { createEnsoCapabilitiesTool } from './tools/ensoCapabilities';
import { transcriptMessages } from './transcript';
import { withWriteScope } from './writeScope';

/** 子会话产物：实际 session、模型与精确工具集合。 */
interface ChildSessionResult {
  session: AgentSession;
  modelId: string;
  modelRef: { providerId: string; modelId: string };
  toolIds: string[];
  proofToolIds: string[];
  ensoApp?: EnsoAppInvoker;
  safeJournal?: EnsoSafeJournal;
}

/** 会话工厂：父 runtime/resource/tool 配置的唯一 child 创建入口。 */
interface SessionFactory {
  cwd: string;
  /** gate 验收命令执行器(远程会话走 ssh,本地会话走 /bin/sh) */
  runGate: (gate: string) => Promise<string>;
  agentTypes: AgentTypeSpawnConfig[];
  subagentModels: SubagentModelOption[];
  modelId: string;
  createChildSession(opts: {
    agentType?: AgentTypeSpawnConfig;
    resolved?: ResolvedAgentTypeSpawnConfig;
    /** 主 agent 显式指定的模型,优先于 resolved/agentType 绑定模型 */
    modelOverride?: SpawnModelConfig;
    identity?: ChildSessionIdentity;
    gate: ApprovalGate;
    askManager?: AskManager;
    resumeFile?: string;
    extraTools?: unknown[];
  }): Promise<ChildSessionResult>;
}

interface ManagedSession {
  identity: SessionIdentity;
  childIdentity?: ChildSessionIdentity;
  childMetadata?: ChildConversationMetadata;
  session: AgentSession;
  status: NodeStatus;
  seq: number;
  messages: ProjectedMessage[];
  customEntries: AgentSessionCustomEntry[];
  commands: SlashCommand[];
  modelId: string;
  toolIds: string[];
  proofToolIds: string[];
  safeJournal?: EnsoSafeJournal;
  currentTurnId?: string;
  promptedRequestIds: Set<string>;
  ensoApp?: EnsoAppInvoker;
  browser?: BrowserInvoker;
  adaptiveDowngraded: boolean;
  /** 最近一次 auto_retry_start 携带的原始错误（取消重试时的终态错误文案） */
  lastRetryError?: string;
  timings: (MessageTiming | undefined)[];
  toolStartAt: Map<string, number>;
  toolDurations: Map<string, number>;
  gate: ApprovalGate;
  asks: AskManager;
  pendingTaskReminders: string[];
  /** 忙碌时收到的手动压缩请求：本轮收束后自动执行（用户选择「排队」而非打断） */
  pendingCompact?: { instructions?: string };
  /**
   * 压缩进度与压完锚点，随快照下发。compaction 是瞬时事件且不重放，
   * 不存在这里的话 guest（手机刷新）重建投影时拿不到，压完提示会丢。
   */
  compaction?: 'queued' | 'running';
  /** 绝对消息 index 口径：压完那刻 messages.length（须在 reconcileMessages 之后取） */
  compactionNoticeAt?: number;
  subagents: Map<string, SubagentInfo>;
  factory?: SessionFactory;
  parentId?: string;
  coworkerName?: string;
  pendingRole?: string;
  /** 最近一轮的完整摘要(不含 gate),供 coworker report/wait 取用;由 settleRound 在每轮终态统一记入 */
  lastRoundSummary?: string;
  /** 等待本轮终态(idle/failed/销毁)的回调;由 settleRound 统一触发 */
  roundWaiters: Set<() => void>;
  /** 父正在 wait 阻塞等本轮;message_main_agent 据此免去冗余上报 */
  parentWaiting?: boolean;
  /** 已投递、尚未进入 running 的一轮(send 与 agent_start 之间);wait 据此不把它当空闲 */
  roundPending?: boolean;
  checkpoints?: CheckpointManager;
  coworkers: Map<string, CoworkerInfo>;
  /** 最近一次收到命令或产生事件；闲置回收的计时起点 */
  lastActivityAt: number;
  unsubscribe: () => void;
}

export interface SupervisorOptions {
  emit(event: AgentWorkerEvent): void;
  /** pi 全局目录（auth/models/settings），指到 app userData 下以隔离用户的 ~/.pi */
  agentDir: string;
  /** 会话 jsonl 目录 */
  sessionDir: string;
}

/** 指令走 loader 覆盖：去掉 agentDir 里的共享 AGENTS.md，再按会话前置一份。 */
function sessionAgentsFilesOverride(
  agentDir: string,
  instruction?: { path: string; content: string }
) {
  const resolvedAgentDir = path.resolve(agentDir);
  return (current: { agentsFiles: Array<{ path: string; content: string }> }) => ({
    agentsFiles: [
      ...(instruction ? [instruction] : []),
      ...current.agentsFiles.filter(
        (file) => path.resolve(path.dirname(file.path)) !== resolvedAgentDir
      ),
    ],
  });
}

function createSessionResourceLoader(options: {
  cwd: string;
  agentDir: string;
  noSkills: boolean;
  /** 类型化子代理:不装项目扩展(扩展注册的工具与 systemPrompt 注入是给主会话的,漏进去会让它误以为要再委派) */
  noExtensions?: boolean;
  skillPaths: string[];
  instruction?: { path: string; content: string };
  /** 远程会话:替换掉本地 cwd 扫描出的 AGENTS.md(cwd 在本机不存在),只用预取的远端文件 */
  remoteAgentsFiles?: Array<{ path: string; content: string }>;
}): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    noSkills: options.noSkills,
    ...(options.noExtensions ? { noExtensions: true } : {}),
    ...(options.skillPaths.length > 0 ? { additionalSkillPaths: options.skillPaths } : {}),
    agentsFilesOverride: options.remoteAgentsFiles
      ? () => ({
          agentsFiles: [
            ...(options.instruction ? [options.instruction] : []),
            ...(options.remoteAgentsFiles ?? []),
          ],
        })
      : sessionAgentsFilesOverride(options.agentDir, options.instruction),
  });
}

/** Enso 不发现任何宿主或项目资源；cwd 只供 pi 的会话文件元数据使用。 */
function createEnsoResourceLoader(cwd: string, agentDir: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: ENSO_SYSTEM_PROMPT,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),

    themesOverride: () => ({ themes: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    appendSystemPromptOverride: () => [],
  });
}
/**
 * pi 的 SessionManager._persist 在会话出现第一条 assistant 消息之前一个字节不写（避免留下空会话
 * 文件）。而纯派发的父容器按设计永远不跑主 coding 回合，永远不会有 assistant 消息，
 * 于是它的 custom entry（已派发/完成通知）只存在内存里，且 parent-ready 上报的 sessionFile
 * 指向一个不存在的文件——重启后 resume 直接失败，连带 child 的历史也打不开。
 *
 * 因此在会话还没有 assistant 消息时，由我们强制落盘；一旦 pi 自己接管了持久化就不再介入。
 * 依赖的 `_rewriteFile` 是 pi 的私有方法：升级 pi 时需复检，回归测试断言的是“文件落盘”
 * 这个可观测结果，不是调用了该方法，所以上游改语义时测试会直接飘红。
 */
export function materializeSessionFile(session: AgentSession): void {
  const hasAssistant = (session.messages as { role?: string }[] | undefined)?.some(
    (message) => message?.role === 'assistant'
  );
  if (hasAssistant) return;
  const manager = session.sessionManager as unknown as { _rewriteFile?: () => void };
  try {
    manager._rewriteFile?.();
  } catch {
    // 落盘失败不能弄挂派发；内存中的通知仍然可用。
  }
}

function requiredSessionFile(session: AgentSession): string {
  if (!session.sessionFile) throw new Error('SessionManager did not provide a session file.');
  return session.sessionFile;
}

function settingsModelRef(model: SpawnModelConfig): ModelRef {
  if (
    'settingsProviderId' in model &&
    typeof model.settingsProviderId === 'string' &&
    model.settingsProviderId
  ) {
    return { providerId: model.settingsProviderId, modelId: model.modelId };
  }
  throw new Error('Spawn model is missing its settings provider identity.');
}

function isSameGeneration(left: SessionIdentity, right: SessionIdentity): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}

async function refreshWorkerProviderModels(
  runtime: ModelRuntime,
  providerId: string
): Promise<void> {
  try {
    await runtime.refresh({ providers: [providerId], allowNetwork: true });
  } catch {
    // 拉不到就留用该 provider 的兜底清单，不该让 worker 起不来
  }
}

/**
 * 注册 worker 自己的订阅 provider，并在解析会话模型前补齐联网发现的真实清单。
 */
export async function initializeWorkerRuntime(runtime: ModelRuntime): Promise<ModelRuntime> {
  // 推理发生在本进程：Main 侧注册过不算，worker 不注册就会以「未知 provider」流不起来
  runtime.registerProvider(ANTIGRAVITY_PROVIDER_ID, antigravityProviderConfig());
  await loadCursorProvider(runtime);
  // registerProvider 只触发 allowNetwork:false 的 refresh，拿到的是兜底清单；Main 侧界面
  // 展示的却是联网发现结果。必须拆成两次并各自吞错，避免一个 provider 的发现服务异常
  // 连带另一个拿不到清单；失败方只回退自己的兜底，worker 仍能启动。
  // await 而非 fire-and-forget：resolveBaseModel 紧接着就要用这份清单。
  await refreshWorkerProviderModels(runtime, ANTIGRAVITY_PROVIDER_ID);
  await refreshWorkerProviderModels(runtime, CURSOR_PROVIDER_ID);
  return runtime;
}

/** 故障域 A：本进程持有全部活会话。同一会话的命令串行，不同会话并行。 */
export class SessionSupervisor {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly gate = new OperationGate();
  private readonly mcp = new McpManager();
  private readonly bgTasks: BackgroundTaskManager;
  private runtimePromise: Promise<ModelRuntime> | null = null;
  /** 不可回收的会话（桌面正在查看 / 手机订阅），由 Main 全量下发 */
  private pinned: ReadonlySet<string> = new Set();
  private readonly evictionTimer: ReturnType<typeof setInterval>;
  /** 父会话通知(合并投递):闲则注入合成提示唤醒,忙则挂 pending 搭下次工具结果 */
  private readonly notifier = new ParentNotifier((sessionId, text) => {
    this.deliverNotification(sessionId, text);
  });

  private deliverNotification(sessionId: string, text: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    if (managed.status === 'idle') {
      void managed.session
        .prompt(`<agent-notification>\n${text}\n</agent-notification>`)
        .catch(() => {
          // status 是我们的投影,pi loop 可能仍在收尾拒绝 prompt——退回 pending 待搭车/轮末重投,绝不静默丢
          managed.pendingTaskReminders.push(text);
        });
    } else {
      managed.pendingTaskReminders.push(text);
    }
  }

  constructor(private readonly options: SupervisorOptions) {
    this.bgTasks = new BackgroundTaskManager(
      {
        onStarted: (sessionId, task) => {
          const managed = this.sessions.get(sessionId);
          if (managed) {
            this.options.emit({
              type: 'task-started',
              identity: managed.identity,
              seq: ++managed.seq,
              task,
            });
          }
        },
        onOutput: (sessionId, taskId, tail, status) => {
          const managed = this.sessions.get(sessionId);
          if (managed) {
            this.options.emit({
              type: 'task-output',
              identity: managed.identity,
              seq: ++managed.seq,
              taskId,
              tail,
              status,
            });
          }
        },
        onEnded: (sessionId, taskId, status, exitCode) => {
          const managed = this.sessions.get(sessionId);
          if (managed) {
            this.options.emit({
              type: 'task-ended',
              identity: managed.identity,
              seq: ++managed.seq,
              taskId,
              status,
              ...(exitCode !== undefined ? { exitCode } : {}),
            });
          }
        },
        // 完成通知走合并投递:多任务同时完成合并成一条,失败在 manager 文本里自带标注
        onCompletionNotify: (sessionId, text) => {
          this.notifier.notify(sessionId, text);
        },
      },
      path.join(options.agentDir, 'task-logs')
    );
    // 点开过的会话否则常驻到 app 退出（每个 AgentSession 持有全量 jsonl 上下文）
    this.evictionTimer = setInterval(() => this.evictIdleSessions(), EVICTION_SWEEP_INTERVAL_MS);
    this.evictionTimer.unref?.();
  }

  private evictionCandidate(managed: ManagedSession): EvictionCandidate {
    const id = managed.identity.sessionId;
    return {
      sessionId: id,
      isChild: Boolean(managed.parentId || managed.childIdentity),
      status: managed.status,
      lastActivityAt: managed.lastActivityAt,
      hasPendingWork:
        managed.currentTurnId !== undefined ||
        managed.gate.snapshot().length > 0 ||
        managed.asks.snapshot().length > 0 ||
        (managed.ensoApp?.pendingCount ?? 0) > 0 ||
        (managed.browser?.pendingCount ?? 0) > 0 ||
        managed.pendingTaskReminders.length > 0 ||
        this.bgTasks.snapshot(id).some((task) => task.status === 'running'),
      hasChildren:
        managed.coworkers.size > 0 ||
        [...managed.subagents.values()].some((s) => s.status === 'running') ||
        [...this.sessions.keys()].some((key) => key.startsWith(`${id}::`)),
    };
  }

  private evictIdleSessions(): void {
    const candidates = [...this.sessions.values()].map((m) => this.evictionCandidate(m));
    for (const sessionId of selectEvictable(candidates, this.pinned, Date.now())) {
      void this.gate
        .run(sessionId, async () => {
          // 排队期间可能有 prompt/pin 插队，进门后重新校验
          const managed = this.sessions.get(sessionId);
          if (!managed) return;
          const still = selectEvictable([this.evictionCandidate(managed)], this.pinned, Date.now());
          if (still.length === 0) return;
          await this.releaseParent(managed, 'evicted');
        })
        .catch((error) => {
          console.error('[evict] failed:', toErrorMessage(error));
        });
    }
  }

  /** 释放父会话：中断 + 销毁 worker 侧会话树，jsonl 留盘。下游靠 parent-ended 把 started
   *  清回 false，之后可携新 cwd + resumeFile 重新 spawn（Move to worktree / 闲置回收后再点开）。 */
  private async releaseParent(managed: ManagedSession, reason: string): Promise<void> {
    const parentId = managed.identity.sessionId;
    // 先收掉整棵子会话（coworker/child 都以 `${parentId}::` 为键前缀）
    for (const [id, child] of [...this.sessions]) {
      if (!id.startsWith(`${parentId}::`)) continue;
      child.gate.cancelAll();
      child.asks.cancelAll();
      child.ensoApp?.cancelAll('Parent released');
      try {
        await child.session.abort();
      } catch {}
      child.unsubscribe();
      try {
        child.session.dispose();
      } catch {}
      this.sessions.delete(id);
      this.settleRound(child);
    }
    managed.coworkers.clear();
    managed.gate.cancelAll();
    managed.asks.cancelAll();
    managed.ensoApp?.cancelAll('Session released');
    managed.browser?.cancelAll('Session released');
    try {
      await managed.session.abort();
    } catch {}
    managed.unsubscribe();
    try {
      managed.session.dispose();
    } catch {}
    this.sessions.delete(parentId);
    this.options.emit({
      type: 'parent-ended',
      identity: managed.identity,
      seq: managed.seq + 1,
      reason,
    });
  }

  handleCommand(command: AgentCommand): void {
    if (command.type === 'snapshot') {
      const sessions = command.sessionId
        ? this.snapshotSessions().filter(
            (session) => session.identity.sessionId === command.sessionId
          )
        : this.snapshotSessions();
      this.options.emit({
        type: 'snapshot',
        sessions,
        ...(command.sessionId ? { partial: true } : {}),
      });
      return;
    }
    if (command.type === 'warm-mcp') {
      void this.mcp.toolsFor(command.servers);
      return;
    }
    if (command.type === 'pin-sessions') {
      this.pinned = new Set(command.sessionIds);
      return;
    }
    if (command.type === 'summarize-title') {
      // 标题总结不属于任何会话：旁路串行门；失败静默（截断标题已是可用兑底，不值得报错打扰）
      void this.summarizeTitle(command).catch(() => {});
      return;
    }
    if (command.type === 'set-proxy-env') {
      applyWorkerProxyEnv(command.env);
      return;
    }
    const identity =
      command.type === 'capability-result'
        ? command.child
        : command.type === 'browser-result'
          ? command.identity
          : command.type === 'dismiss-child' ||
              command.type === 'dismiss-coworker' ||
              command.type === 'resume-coworker'
            ? command.parent
            : command.identity;
    const touched = this.sessions.get(identity.sessionId);
    if (touched) touched.lastActivityAt = Date.now();
    // abort 必须旁路串行门：它要打断的正是占着门的那一轮，排队等于永远等不到
    if (command.type === 'abort') {
      void this.execute(command).catch((error) => {
        console.error('[abort] failed:', toErrorMessage(error));
      });
      return;
    }
    void this.gate
      .run(identity.sessionId, () => this.execute(command))
      .catch((error) => {
        const message = toErrorMessage(error);
        if (command.type === 'spawn-parent') {
          this.options.emit({
            type: 'parent-rejected',
            identity: command.identity,
            seq: 0,
            reason: message,
          });
          return;
        }
        if (command.type === 'spawn-child') {
          this.options.emit({
            type: 'child-rejected',
            identity: command.identity,
            seq: 0,
            reason: message,
          });
          return;
        }
        const managed = this.sessions.get(identity.sessionId);
        if (!managed || !isSameGeneration(managed.identity, identity)) return;
        managed.status = 'failed';
        this.emitStatus(managed, message);
      });
  }

  private async execute(command: Exclude<AgentCommand, { type: 'snapshot' }>): Promise<void> {
    switch (command.type) {
      case 'spawn-parent':
        await this.spawn(
          command.identity,
          command.cwd,
          command.model,
          command.resumeFile,
          command.reasoningEnabled ?? false,
          command.thinkingLevel,
          command.loadLocalSkills,
          command.skillPaths,
          command.mcpServers,
          command.approvalMode,
          command.agentTypes,
          command.disabledTools,
          command.instruction,
          command.subagentModels,
          command.remote
        );
        return;
      case 'spawn-child':
        await this.spawnTypedChild(
          command.identity,
          command.cwd,
          command.config,
          command.resumeFile
        );
        return;
      case 'dismiss-child': {
        this.must(command.parent);
        const child = this.must(command.child);
        if (
          !child.childIdentity ||
          !isSameChildSessionIdentity(command.child, child.childIdentity)
        ) {
          return;
        }
        const name = await this.dismissCoworker(command.parent.sessionId, command.child.sessionId);
        if (command.notify) {
          this.notifier.notify(
            command.parent.sessionId,
            `The user dismissed coworker "${name}". Its session is closed; do not send to it again.`,
            { urgent: true }
          );
        }
        return;
      }
      case 'resume-coworker': {
        // 重启后恢复工具直雇 coworker：name/agentType/resumeFile 全部来自 Main
        // 自己读的持久化；spawnCoworker 的 resumeFile 分支自带容量豁免与类型降级容错。
        this.must(command.parent);
        await this.spawnCoworker(
          command.parent.sessionId,
          command.coworkerId,
          command.name,
          command.agentType,
          undefined,
          command.resumeFile
        );
        return;
      }
      case 'dismiss-coworker': {
        // 双形状过渡：工具直雇 coworker 无 ChildSessionIdentity，Main 按
        // parent.coworkers 映射发裸 id；这里以 exact 父代为门（must 抛即拒）。
        this.must(command.parent);
        const name = await this.dismissCoworker(command.parent.sessionId, command.coworkerId);
        if (command.notify) {
          this.notifier.notify(
            command.parent.sessionId,
            `The user dismissed coworker "${name}". Its session is closed; do not send to it again.`,
            { urgent: true }
          );
        }
        return;
      }
      case 'prompt-child': {
        const managed = this.must(command.identity);
        if (
          !managed.childIdentity ||
          !isSameChildSessionIdentity(command.identity, managed.childIdentity) ||
          managed.promptedRequestIds.has(command.requestId)
        ) {
          return;
        }
        managed.promptedRequestIds.add(command.requestId);
        managed.currentTurnId = command.requestId;
        managed.safeJournal?.appendUserText(command.task.text);
        const images = command.task.images.map((image) => ({ type: 'image' as const, ...image }));
        void managed.session
          .prompt(
            consumeRole(managed, command.task.text),
            images.length > 0 ? { images } : undefined
          )
          .catch((error) => {
            this.failTurn(managed, toErrorMessage(error));
          });
        return;
      }
      case 'prompt': {
        const managed = this.must(command.identity);
        const images = command.images?.map((image) => ({ type: 'image' as const, ...image }));
        // 桌面投影可能已 idle，但 pi 仍 isStreaming（漏事件 / abort 收尾）。
        // 这时再 prompt() 会抛 AgentBusyError，乐观消息随后被对账清掉。
        const live = managed.session.isStreaming || managed.status === 'running';
        if (live && !(await this.interruptRetryIfAny(managed))) {
          await managed.session.steer(command.text, images);
          return;
        }
        this.promptFresh(managed, command.text, images);
        return;
      }
      case 'steer': {
        const managed = this.must(command.identity);
        const images = command.images?.map((image) => ({ type: 'image' as const, ...image }));
        // 重试倒计时期间 renderer 看到的仍是 running 会发 steer：此时没有活轮可插，
        // 语义是用户接管——打断重试，改为新轮 prompt
        if (await this.interruptRetryIfAny(managed)) {
          this.promptFresh(managed, command.text, images);
          return;
        }
        await managed.session.steer(command.text, images);
        return;
      }
      case 'abort-retry':
        this.must(command.identity).session.abortRetry();
        return;
      case 'retry': {
        const managed = this.must(command.identity);
        if (managed.session.isStreaming || managed.status === 'running') return;
        const agent = managed.session.agent;
        const messages = agent.state.messages;
        if (messages.at(-1)?.role === 'assistant') {
          // 与 pi _prepareRetry 相同：错误 assistant 留在 session 历史，从模型上下文摘掉再 continue
          agent.state.messages = messages.slice(0, -1);
        }
        if (agent.state.messages.at(-1)?.role === 'assistant') return;
        managed.currentTurnId = randomUUID();
        void agent.continue().catch((error) => {
          this.failTurn(managed, toErrorMessage(error));
        });
        return;
      }
      case 'set-thinking':
        this.must(command.identity).session.setThinkingLevel(command.level);
        return;
      case 'set-model': {
        const managed = this.must(command.identity);
        const runtime = await this.getRuntime();
        const base = await resolveBaseModelOrRefresh(runtime, command.model);
        const next = applyReasoningToModel(
          { ...base, compat: base.compat ? { ...base.compat } : undefined },
          managed.session.model ? Boolean(managed.session.model.reasoning) : false,
          command.model.modelId
        );
        await managed.session.setModel(next);
        managed.modelId = command.model.modelId;
        // 必须回报：Main 的 agentSessionIndex 只认 parent-ready 与本事件，
        // 不回报就会让后续派发的 selection 校验永远对不上（issue #30）。
        this.options.emit({
          type: 'model-changed',
          identity: managed.identity,
          seq: ++managed.seq,
          model: settingsModelRef(command.model),
        });
        return;
      }
      case 'set-reasoning': {
        const managed = this.must(command.identity);
        if (managed.session.model) {
          applyReasoningToModel(managed.session.model, command.enabled, managed.modelId);
        }
        if (command.enabled && command.level) {
          managed.session.setThinkingLevel(command.level);
        }
        return;
      }
      case 'approval-respond':
        this.must(command.identity).gate.respond(command.requestId, command.decision);
        return;
      case 'set-approval-mode':
        this.must(command.identity).gate.mode = command.mode;
        return;
      case 'ask-respond':
        this.must(command.identity).asks.respond(command.requestId, command.answer);
        return;
      case 'capability-result': {
        const managed = this.must(command.child);
        if (
          !managed.childIdentity ||
          !isSameChildSessionIdentity(command.child, managed.childIdentity) ||
          managed.currentTurnId !== command.turnId
        ) {
          return;
        }
        managed.safeJournal?.appendCapabilityResult(command.requestId, command.envelope);
        managed.ensoApp?.resolve(command.turnId, command.requestId, command.envelope);
        return;
      }
      case 'browser-result': {
        const managed = this.must(command.identity);
        if (!managed.browser?.resolve(command)) {
          console.warn(`[browser] dropped result for unknown request ${command.requestId}`);
        }
        return;
      }
      case 'append-session-custom-entry': {
        const managed = this.must(command.identity);
        managed.session.sessionManager.appendCustomEntry('enso-agent-session', command.entry);
        materializeSessionFile(managed.session);
        managed.customEntries.push(command.entry);
        this.options.emit({
          type: 'session-custom-entry',
          identity: managed.identity,
          seq: ++managed.seq,
          entry: command.entry,
        });
        return;
      }
      case 'task-stop':
        this.must(command.identity);
        this.bgTasks.stop(command.taskId);
        return;
      case 'fork': {
        const managed = this.must(command.identity);
        if (managed.status !== 'idle' || managed.childIdentity) {
          this.options.emit({
            type: 'fork-done',
            identity: managed.identity,
            seq: ++managed.seq,
            targetConversationId: command.targetConversationId,
            error: 'source-not-idle',
          });
          return;
        }
        const entryId = resolveForkLeafId(
          managed.session.sessionManager.getBranch(),
          command.entryId
            ? { entryId: command.entryId }
            : { userIndexFromEnd: command.userIndexFromEnd ?? 0 }
        );
        if (!entryId) {
          this.options.emit({
            type: 'fork-done',
            identity: managed.identity,
            seq: ++managed.seq,
            targetConversationId: command.targetConversationId,
            error: 'anchor-not-found',
          });
          return;
        }
        const branched = branchSessionFromPersistedFile(
          managed.session.sessionManager,
          entryId,
          (sessionFile) => SessionManager.open(sessionFile)
        );
        this.options.emit({
          type: 'fork-done',
          identity: managed.identity,
          seq: ++managed.seq,
          targetConversationId: command.targetConversationId,
          entryId,
          ...(branched.ok ? { sessionFile: branched.sessionFile } : { error: branched.error }),
        });
        return;
      }
      case 'compact': {
        const managed = this.must(command.identity);
        if (managed.status !== 'idle') {
          // 忙碌时排队：不打断当前轮次，turn 收束后由 runCompaction 接手
          managed.pendingCompact = command.instructions
            ? { instructions: command.instructions }
            : {};
          managed.compaction = 'queued';
          this.options.emit({
            type: 'compaction',
            identity: managed.identity,
            seq: ++managed.seq,
            state: 'queued',
          });
          return;
        }
        await this.runCompaction(managed, command.instructions);
        return;
      }
      case 'rewind': {
        const managed = this.must(command.identity);
        if (managed.status !== 'idle') {
          this.options.emit({
            type: 'rewind-done',
            identity: managed.identity,
            seq: ++managed.seq,
          });
          return;
        }
        const userEntries = managed.session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === 'message' && entry.message.role === 'user');
        const target = userEntries[userEntries.length - 1 - command.userIndexFromEnd];
        if (!target) {
          this.options.emit({
            type: 'rewind-done',
            identity: managed.identity,
            seq: ++managed.seq,
          });
          return;
        }
        let filesRestored = false;
        if (command.restoreFiles && managed.checkpoints) {
          try {
            filesRestored = await managed.checkpoints.restoreForEntry(
              target.id,
              new Date(target.timestamp).getTime()
            );
          } catch (error) {
            console.error('[rewind] file restore failed:', toErrorMessage(error));
            this.options.emit({
              type: 'rewind-done',
              identity: managed.identity,
              seq: ++managed.seq,
            });
            return;
          }
        }
        const result = await managed.session.navigateTree(target.id);
        this.reconcileMessages(managed, this.transcript(managed));
        this.options.emit({
          type: 'rewind-done',
          identity: managed.identity,
          seq: ++managed.seq,
          ...(!result.cancelled && result.editorText ? { editorText: result.editorText } : {}),
          ...(filesRestored ? { filesRestored } : {}),
        });
        return;
      }
      case 'abort': {
        const managed = this.must(command.identity);
        managed.gate.cancelAll();
        managed.asks.cancelAll();
        managed.ensoApp?.cancelAll('Enso capability invocation aborted');
        managed.browser?.cancelAll('Browser action aborted');
        managed.currentTurnId = undefined;
        // 立即收口投影：不 await session.abort()（内部 waitForIdle 会一直等到工具/流
        // 真正结束，工具不响应 signal 时永远等不到，UI 就卡在 running 上）。
        // 中断信号发出即视为本轮终止，后续 agent_end 回流由 status 守卫幂等吸收。
        managed.status = 'idle';
        this.emitStatus(managed);
        void managed.session.abort().catch(() => {});
        return;
      }
      case 'release-parent':
        await this.releaseParent(this.must(command.identity), 'released');
        return;
    }
  }

  private async spawn(
    identity: SessionIdentity,
    cwd: string,
    model: SpawnModelConfig,
    resumeFile?: string,
    reasoningEnabled = false,
    thinkingLevel?: ThinkingLevel,
    loadLocalSkills = true,
    skillPaths: string[] = [],
    mcpServers: McpServerSpawnConfig[] = [],
    approvalMode: ApprovalMode = 'full',
    agentTypes: AgentTypeSpawnConfig[] = [],
    disabledTools: string[] = [],
    instruction?: { path: string; content: string },
    subagentModels: SubagentModelOption[] = [],
    remote?: AgentRemoteConfig
  ): Promise<void> {
    const sessionId = identity.sessionId;
    const toolEnabled = (id: string) => !disabledTools.includes(id);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (!isSameGeneration(existing.identity, identity) || existing.childIdentity) {
        throw new Error('Parent session identity is already reserved by another generation.');
      }
      this.options.emit({
        type: 'parent-ready',
        identity,
        seq: ++existing.seq,
        sessionFile: requiredSessionFile(existing.session),
        model: settingsModelRef(model),
      });
      return;
    }
    const spawnStart = Date.now();
    const runtime = await this.getRuntime();
    const baseModel = await resolveBaseModelOrRefresh(runtime, model);
    const piModel = applyReasoningToModel(
      { ...baseModel, compat: baseModel.compat ? { ...baseModel.compat } : undefined },
      reasoningEnabled,
      model.modelId
    );
    // 远程会话：ssh 执行器(ControlMaster 按 host 哈希共享连接) + 远端 AGENTS.md 单文件预取
    const sshExecutor = remote
      ? (() => {
          const controlDir = path.join(this.options.agentDir, 'ssh');
          mkdirSync(controlDir, { recursive: true });
          return createSshExecutor(remote.host, controlDir, undefined, remote);
        })()
      : undefined;
    const remoteOps = sshExecutor ? createRemoteOperations(sshExecutor) : undefined;
    const remoteAgentsFiles = sshExecutor
      ? await sshExecutor
          .exec(['cat', '--', `${cwd}/AGENTS.md`], { timeoutMs: 15_000 })
          .then((result) =>
            result.code === 0 && result.stdout.trim().length > 0
              ? [{ path: `${cwd}/AGENTS.md`, content: result.stdout }]
              : []
          )
          .catch(() => [] as Array<{ path: string; content: string }>)
      : undefined;
    const resourceLoader = createSessionResourceLoader({
      cwd,
      agentDir: this.options.agentDir,
      noSkills: loadLocalSkills === false,
      skillPaths,
      instruction,
      remoteAgentsFiles,
    });
    const toolsStart = Date.now();
    const [, mcpTools] = await Promise.all([
      resourceLoader.reload(),
      mcpServers.length > 0 ? this.mcp.toolsFor(mcpServers, 3000) : Promise.resolve([]),
    ]);
    const toolsMs = Date.now() - toolsStart;

    let managedRef: ManagedSession | undefined;
    const gate = new ApprovalGate(
      approvalMode,
      (request) => {
        if (managedRef) {
          this.options.emit({
            type: 'approval-request',
            identity: managedRef.identity,
            seq: ++managedRef.seq,
            request,
          });
        }
      },
      (requestId) => {
        if (managedRef) {
          this.options.emit({
            type: 'approval-resolved',
            identity: managedRef.identity,
            seq: ++managedRef.seq,
            requestId,
          });
        }
      }
    );
    const checkpoints = new CheckpointManager(
      cwd,
      sessionId,
      () => {
        const managed = managedRef ?? this.sessions.get(sessionId);
        const last = managed?.session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === 'message' && entry.message.role === 'user')
          .at(-1);
        return last ? { entryId: last.id, entryTimestamp: new Date(last.timestamp).getTime() } : {};
      },
      // 远程会话:快照直接打在远端 repo(非 git 目录仍然静默降级)
      sshExecutor ? createRemoteCheckpointHost(sshExecutor) : undefined
    );
    // 工具注入：noTools:'builtin' 下 read 也需重注册（免审）；bash 叠 background 能力
    // 后包审批门（审批先问，批准后分流后台），edit 叠宽容版，MCP 同门，todo/task_* 免审。
    // 最外层统一包 withTaskReminders：后台任务完成提醒搭任意工具结果送达模型
    type Def = Parameters<typeof withApproval>[2];
    const takePendingReminders = () => managedRef?.pendingTaskReminders.splice(0) ?? [];
    // 只读探索四件套(read/grep/find/ls,免审):readonly 子代理的全部工具,也是 base 的底座。
    // 远程会话经 operations 注入落到 ssh(grep 无注入点,换整个定义)
    const readOnlyTools = (): Def[] =>
      remoteOps && sshExecutor
        ? [
            createReadToolDefinition(cwd, { operations: remoteOps.read }) as unknown as Def,
            createRemoteGrepToolDefinition(cwd, sshExecutor) as unknown as Def,
            createFindToolDefinition(cwd, { operations: remoteOps.find }) as unknown as Def,
            createLsToolDefinition(cwd, { operations: remoteOps.ls }) as unknown as Def,
          ]
        : [
            createReadToolDefinition(cwd) as unknown as Def,
            createGrepToolDefinition(cwd) as unknown as Def,
            createFindToolDefinition(cwd) as unknown as Def,
            createLsToolDefinition(cwd) as unknown as Def,
          ];
    // 后台任务 manager 本体始终本地 spawn:远程会话把命令变换成本地 ssh 命令
    const backgroundTransform = remote
      ? (command: string, taskCwd: string) => {
          const controlDir = path.join(this.options.agentDir, 'ssh');
          let sshCommand = buildSshShellCommand(remote.host, command, {
            cwd: taskCwd,
            controlPath: resolveSshControlPath(controlDir),
            auth: remote.auth,
            port: remote.port,
          });
          if (remote.auth === 'password' && remote.password) {
            const env = sshPasswordEnv(controlDir, remote.password);
            sshCommand = `${[
              'SSH_ASKPASS',
              'SSH_ASKPASS_REQUIRE',
              'DISPLAY',
              'ENSO_SSH_ASKPASS_PASSWORD',
              'SSH_AUTH_SOCK',
            ]
              .map((key) => `${key}=${shellQuote(env[key] ?? '')}`)
              .join(' ')} ${sshCommand}`;
          }
          return { command: sshCommand, cwd: process.cwd() };
        }
      : undefined;
    const buildBaseTools = (
      toolGate: ApprovalGate,
      cp?: CheckpointManager,
      writeScope?: readonly string[]
    ): Def[] => {
      const guarded = (definition: Def): Def => (cp ? withCheckpoint(definition, cp) : definition);
      // 写范围在审批之外:越界直接拒绝,不占用审批也不落盘
      const scoped = (kind: 'file-edit' | 'file-write', definition: Def): Def =>
        withWriteScope(withApproval(toolGate, kind, guarded(definition)), cwd, writeScope);
      return [
        ...readOnlyTools(),
        withApproval(
          toolGate,
          'command',
          guarded(
            withBackground(
              createBashToolDefinition(
                cwd,
                remoteOps ? { operations: remoteOps.bash } : undefined
              ) as unknown as Def,
              this.bgTasks,
              sessionId,
              cwd,
              backgroundTransform
            )
          )
        ),
        scoped(
          'file-edit',
          createLenientEditTool(cwd, remoteOps ? { operations: remoteOps.edit } : undefined)
        ),
        scoped(
          'file-write',
          createWriteToolDefinition(
            cwd,
            remoteOps ? { operations: remoteOps.write } : undefined
          ) as unknown as Def
        ),
      ];
    };
    const wrapMcpTools = (toolGate: ApprovalGate): Def[] =>
      mcpTools.map((tool) => withApproval(toolGate, 'mcp', tool));
    const buildCoreTools = (): Def[] => [
      ...buildBaseTools(gate, checkpoints),
      ...wrapMcpTools(gate),
    ];
    // 会话工厂：一次性 subagent 与持久 coworker 共用。gate 参数化——subagent 复用父门,
    // coworker 用独立门(否则审批条落错 tab、allowSession 白名单跨会话泄漏)
    const factory: SessionFactory = {
      cwd,
      runGate: (gateCommand) => runGateCommand(cwd, gateCommand, sshExecutor),
      agentTypes,
      subagentModels,
      modelId: model.modelId,
      createChildSession: async ({
        agentType,
        resolved,
        modelOverride,
        identity: childIdentity,
        gate: childGate,
        askManager,
        resumeFile: childResume,
        extraTools = [],
      }) => {
        const selectedModel = modelOverride ?? resolved?.model ?? agentType?.model ?? model;
        const base = await resolveBaseModelOrRefresh(runtime, selectedModel);
        // 条目级推理覆盖（subagent-models）赢过父会话；缺省跟随父
        const childReasoning = resolveChildReasoning(
          selectedModel,
          reasoningEnabled,
          thinkingLevel
        );
        const subModel = applyReasoningToModel(
          { ...base, compat: base.compat ? { ...base.compat } : undefined },
          childReasoning.enabled,
          selectedModel.modelId
        );
        const isLockedEnso = resolved?.tools === 'enso-locked';
        if (isLockedEnso && (!childIdentity || !askManager)) {
          throw new Error('Locked Enso child requires exact identity and ask manager.');
        }
        const selectedMcp = resolved?.mcpServers ?? agentType?.mcpServers ?? [];
        const mcpToolGroups =
          !isLockedEnso && selectedMcp.length > 0
            ? await Promise.all(selectedMcp.map((server) => this.mcp.toolsFor([server], 3000)))
            : [];
        if (mcpToolGroups.some((tools) => tools.length === 0)) {
          throw new Error('Agent profile MCP resource failed to establish.');
        }
        const typeMcpTools = mcpToolGroups
          .flat()
          .map((tool) => withApproval(childGate, 'mcp', tool));
        const ensoApp =
          isLockedEnso && childIdentity && askManager
            ? new EnsoAppInvoker(
                childIdentity,
                () => this.sessions.get(childIdentity.sessionId)?.currentTurnId,
                (request) => {
                  const managed = this.sessions.get(childIdentity.sessionId);
                  if (
                    !managed?.childIdentity ||
                    !isSameChildSessionIdentity(childIdentity, managed.childIdentity)
                  ) {
                    throw new Error('Enso child generation is no longer current.');
                  }
                  managed.safeJournal?.append({
                    type: 'enso-operation',
                    operationId: request.requestId,
                    capabilityId: request.capabilityId,
                    toolCallId: request.requestId,
                    at: Date.now(),
                  });
                  this.options.emit({
                    type: 'capability-invoke',
                    child: request.child,
                    seq: ++managed.seq,
                    turnId: request.turnId,
                    requestId: request.requestId,
                    capabilityId: request.capabilityId,
                    params: request.params,
                  });
                }
              )
            : undefined;
        const subTools = isLockedEnso
          ? [createEnsoCapabilitiesTool(), createEnsoAppTool(ensoApp!), createAskTool(askManager!)]
          : [
              ...(resolved?.tools === 'readonly' || agentType?.tools === 'readonly'
                ? readOnlyTools()
                : buildBaseTools(childGate, undefined, agentType?.writeScope)),
              ...(resolved || agentType ? typeMcpTools : wrapMcpTools(childGate)),
              ...(extraTools as Def[]),
            ];
        const selectedSkillPaths = resolved?.skillPaths ?? agentType?.skillPaths ?? [];
        const subLoader = isLockedEnso
          ? createEnsoResourceLoader(cwd, this.options.agentDir)
          : createSessionResourceLoader({
              cwd,
              agentDir: this.options.agentDir,
              noSkills: resolved || agentType ? true : loadLocalSkills === false,
              noExtensions: Boolean(resolved || agentType),
              skillPaths: resolved || agentType ? [...selectedSkillPaths] : skillPaths,
              instruction,
              remoteAgentsFiles,
            });
        await subLoader.reload();
        const safeJournal =
          isLockedEnso && childIdentity
            ? new EnsoSafeJournal(this.options.sessionDir, childIdentity, cwd, childResume)
            : undefined;
        const sessionManager = safeJournal
          ? SessionManager.inMemory(cwd)
          : childResume
            ? SessionManager.open(childResume, this.options.sessionDir, cwd)
            : SessionManager.create(cwd, this.options.sessionDir);
        if (safeJournal && childResume) {
          for (const record of EnsoSafeJournal.restore(childResume).records) {
            if (record.type === 'safe-user-text') {
              sessionManager.appendMessage({
                role: 'user',
                content: [{ type: 'text', text: record.text }],
                timestamp: record.at,
              });
            }
          }
        }
        const { session } = await createAgentSession({
          cwd,
          agentDir: this.options.agentDir,
          modelRuntime: runtime,
          model: subModel,
          thinkingLevel: childReasoning.level,
          noTools: 'builtin',
          customTools: subTools,
          resourceLoader: subLoader,
          sessionManager,
        });
        if (isCursorModel(subModel)) attachCursorBridgeToSession(session, subTools, cwd);
        return {
          session,
          modelId: selectedModel.modelId,
          ...(safeJournal ? { safeJournal } : {}),
          modelRef: settingsModelRef(selectedModel),
          toolIds: subTools.map((tool) => tool.name),
          proofToolIds: subTools
            .filter((tool) => !typeMcpTools.includes(tool))
            .map((tool) => tool.name),
          ...(ensoApp ? { ensoApp } : {}),
        };
      },
    };
    // 子代理：同 worker 子会话，复用 runtime/model/审批门/MCP 连接；工具同父但不含 task/todo（防递归）
    const taskTool = createSubagentTool({
      modelId: model.modelId,
      agentTypes,
      models: subagentModels,
      createSubSession: async (agentType, modelOverride) =>
        (await factory.createChildSession({ agentType, modelOverride, gate })).session,
      runGate: (gateCommand) => runGateCommand(cwd, gateCommand, sshExecutor),
      notify: (text, urgent) => this.notifier.notify(sessionId, text, { urgent }),
      emitUpdate: (agent) => {
        const managed = managedRef ?? this.sessions.get(sessionId);
        if (!managed) return;
        managed.subagents.set(agent.id, agent);
        this.options.emit({
          type: 'subagent-update',
          identity: managed.identity,
          seq: ++managed.seq,
          agent,
        });
      },
    });
    // 模型常把 spawn 与 send/wait 放进同一批并行工具调用:后者按名字等 spawn 落地再解析。
    // 无 pending 时同步解析,避免多一跳微任务(parentWaiting 等状态位要在调用当刻立起)
    const pendingSpawns = new Map<string, Promise<CoworkerInfo>>();
    const withCoworker = <T>(
      name: string,
      fn: (info: CoworkerInfo) => T | Promise<T>
    ): Promise<T> => {
      const pending = pendingSpawns.get(name);
      if (!pending) return Promise.resolve(fn(this.mustCoworker(identity, name)));
      return pending.catch(() => {}).then(() => fn(this.mustCoworker(identity, name)));
    };
    const coworkerTool = createCoworkerTool({
      agentTypes,
      models: subagentModels,
      spawn: (name, agentTypeName, modelName) => {
        const spawning = this.spawnCoworker(
          sessionId,
          `${sessionId}::cw-${slugify(name)}`,
          name,
          agentTypeName,
          modelName
        );
        pendingSpawns.set(name, spawning);
        void spawning.finally(() => pendingSpawns.delete(name)).catch(() => {});
        return spawning;
      },
      send: (name, message, opts) =>
        withCoworker(name, (info) => this.coworkerSend(info.id, message, opts)),
      list: () => {
        const parent = this.must(identity);
        return [...parent.coworkers.values()].map((info) => ({
          ...info,
          status: this.sessions.get(info.id)?.status ?? info.status,
        }));
      },
      dismiss: (name) =>
        withCoworker(name, async (info) => {
          await this.dismissCoworker(sessionId, info.id);
        }),
      wait: (name, opts) => withCoworker(name, (info) => this.coworkerWait(info.id, opts)),
      report: (name) =>
        withCoworker(name, (info) => {
          const managed = this.sessions.get(info.id);
          const base = managed?.lastRoundSummary ?? '(no round completed yet)';
          return managed?.status === 'running' || managed?.roundPending
            ? `${base}\n\n(a round is in progress — use coworker wait to get its result)`
            : base;
        }),
    });
    const askManager = this.createAskManager(identity);
    // 内嵌浏览器：页面活在 Main，worker 只发 browser-invoke 事件。每个父会话一张挂起表。
    const browser = toolEnabled('browser')
      ? new BrowserInvoker(identity, (request) => {
          const managed = managedRef ?? this.sessions.get(sessionId);
          if (!managed) throw new Error('Session is not ready for browser actions.');
          this.options.emit({
            type: 'browser-invoke',
            identity: managed.identity,
            seq: ++managed.seq,
            requestId: request.requestId,
            op: request.op,
            params: request.params,
          });
        })
      : undefined;
    const customTools = [
      ...buildCoreTools(),
      ...(browser
        ? createBrowserTools(browser).map((tool) => withNavigateApproval(gate, tool))
        : []),
      ...(toolEnabled('todo') ? [createTodoTool()] : []),
      ...(toolEnabled('ask_user') ? [createAskTool(askManager)] : []),
      ...(toolEnabled('subagent') ? [taskTool] : []),
      ...(toolEnabled('coworker') ? [coworkerTool] : []),
      ...(toolEnabled('background_tasks') ? createTaskTools(this.bgTasks) : []),
      ...(toolEnabled('goal')
        ? createGoalTools((kind, note) => {
            const managed = managedRef ?? this.sessions.get(sessionId);
            if (!managed) return;
            this.options.emit({
              type: 'goal-signal',
              identity: managed.identity,
              seq: ++managed.seq,
              kind,
              note,
            });
          })
        : []),
    ].map((tool) => withTaskReminders(tool, takePendingReminders));

    const { session } = await createAgentSession({
      cwd,
      agentDir: this.options.agentDir,
      modelRuntime: runtime,
      model: piModel,
      thinkingLevel: reasoningEnabled ? (thinkingLevel ?? 'medium') : 'off',
      resourceLoader,
      noTools: 'builtin',
      ...(customTools.length > 0 ? { customTools } : {}),
      sessionManager: resumeFile
        ? SessionManager.open(resumeFile, this.options.sessionDir, cwd)
        : SessionManager.create(cwd, this.options.sessionDir),
    });
    if (isCursorModel(piModel)) attachCursorBridgeToSession(session, customTools, cwd);
    console.log(
      `[spawn] ${sessionId.slice(0, 8)} total ${Date.now() - spawnStart}ms` +
        ` (tools ${toolsMs}ms, mcp ${mcpTools.length} tools, cwd ${cwd})`
    );

    managedRef = this.registerManagedSession(identity, session, gate, model.modelId, {
      resumeFile,
      asks: askManager,
      factory,
      toolIds: customTools.map((tool) => tool.name),
      checkpoints,
    });
    managedRef.browser = browser;
    this.options.emit({
      type: 'parent-ready',
      identity,
      seq: ++managedRef.seq,
      sessionFile: requiredSessionFile(session),
      model: settingsModelRef(model),
    });
    checkpoints?.cleanupOldSessions();
  }

  private createAskManager(identity: SessionIdentity): AskManager {
    return new AskManager(
      (ask) => {
        const managed = this.sessions.get(identity.sessionId);
        if (managed && isSameGeneration(managed.identity, identity)) {
          this.options.emit({
            type: 'ask-request',
            identity: managed.identity,
            seq: ++managed.seq,
            ask,
          });
        }
      },
      (requestId) => {
        const managed = this.sessions.get(identity.sessionId);
        if (managed && isSameGeneration(managed.identity, identity)) {
          this.options.emit({
            type: 'ask-resolved',
            identity: managed.identity,
            seq: ++managed.seq,
            requestId,
          });
        }
      }
    );
  }

  private registerManagedSession(
    identity: SessionIdentity,
    session: AgentSession,
    gate: ApprovalGate,
    modelId: string,
    opts: {
      factory?: SessionFactory;
      childIdentity?: ChildSessionIdentity;
      childMetadata?: ChildConversationMetadata;
      parentId?: string;
      coworkerName?: string;
      resumeFile?: string;
      asks?: AskManager;
      checkpoints?: CheckpointManager;
      ensoApp?: EnsoAppInvoker;
      toolIds?: string[];
      proofToolIds?: string[];
      safeJournal?: EnsoSafeJournal;
    } = {}
  ): ManagedSession {
    const customEntries = session.sessionManager.getBranch().flatMap((entry) => {
      if (entry.type !== 'custom' || entry.customType !== 'enso-agent-session') return [];
      const parsed = parseAgentSessionCustomEntry(entry.data);
      return parsed ? [parsed] : [];
    });
    const managed: ManagedSession = {
      identity,
      ...(opts.childIdentity ? { childIdentity: opts.childIdentity } : {}),
      ...(opts.childMetadata ? { childMetadata: opts.childMetadata } : {}),
      session,
      status: 'idle',
      seq: 0,
      messages: [],
      customEntries,
      commands: collectSlashCommands(session),
      modelId,
      toolIds: opts.toolIds ?? [],
      proofToolIds: opts.proofToolIds ?? opts.toolIds ?? [],
      promptedRequestIds: new Set(),
      ...(opts.ensoApp ? { ensoApp: opts.ensoApp } : {}),
      ...(opts.safeJournal ? { safeJournal: opts.safeJournal } : {}),
      adaptiveDowngraded: false,
      timings: [],
      toolStartAt: new Map(),
      toolDurations: new Map(),
      gate,
      asks: opts.asks ?? this.createAskManager(identity),
      pendingTaskReminders: [],
      roundWaiters: new Set(),
      subagents: new Map(),
      coworkers: new Map(),
      lastActivityAt: Date.now(),
      ...(opts.factory ? { factory: opts.factory } : {}),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.coworkerName ? { coworkerName: opts.coworkerName } : {}),
      ...(opts.checkpoints ? { checkpoints: opts.checkpoints } : {}),
      unsubscribe: () => {},
    };
    managed.unsubscribe = session.subscribe((event) => {
      this.onSessionEvent(managed, event);
    });
    this.sessions.set(identity.sessionId, managed);
    this.emitStatus(managed);
    this.options.emit({
      type: 'commands',
      identity,
      seq: ++managed.seq,
      commands: managed.commands,
    });
    this.emitSessionMeta(managed);
    if (opts.resumeFile) {
      managed.messages = this.transcript(managed)
        .map(projectMessage)
        .filter((message): message is ProjectedMessage => message !== null);
      this.options.emit({
        type: 'snapshot',
        partial: true,
        sessions: [
          {
            identity,
            status: managed.status,
            messages: managed.messages,
            commands: managed.commands,
            ...(managed.childMetadata ? { child: managed.childMetadata } : {}),
            ...(managed.customEntries.length > 0 ? { customEntries: managed.customEntries } : {}),
          },
        ],
      });
    }
    return managed;
  }

  private async spawnTypedChild(
    identity: ChildSessionIdentity,
    cwd: string,
    config: ResolvedAgentTypeSpawnConfig,
    resumeFile?: string
  ): Promise<void> {
    const parent = this.must(identity.parent);
    const factory = parent.factory;
    if (!factory) throw new Error('Parent session cannot create child Agents.');
    if (cwd !== factory.cwd || identity.typeKey !== config.typeKey) {
      throw new Error('Child source or Agent type does not match the reserved identity.');
    }
    const isLockedEnso = identity.typeKey === ENSO_LOCKED_PROFILE.typeKey;
    if (
      isLockedEnso !== (config.tools === 'enso-locked') ||
      identity.profileId !== config.lockedProfileId ||
      (isLockedEnso &&
        (identity.profileId !== ENSO_LOCKED_PROFILE.profileId ||
          config.skillPaths.length !== 0 ||
          config.mcpServers.length !== 0))
    ) {
      throw new Error('Child locked profile does not match the reserved identity.');
    }
    const existing = this.sessions.get(identity.sessionId);
    if (existing) {
      if (
        !existing.childIdentity ||
        !isSameChildSessionIdentity(existing.childIdentity, identity)
      ) {
        throw new Error('Child session id is owned by another generation.');
      }
      this.options.emit({
        type: 'child-ready',
        identity,
        seq: ++existing.seq,
        sessionFile: existing.safeJournal?.sessionFile ?? requiredSessionFile(existing.session),
        proof: {
          spawnSpecId: config.spawnSpecId,
          typeKey: config.typeKey,
          model: settingsModelRef(config.model),
          toolIds: existing.proofToolIds,
          loadedSkillBindingIds: config.skillBindingIds,
          loadedMcpBindingIds: config.mcpBindingIds,
          systemPromptHash: config.systemPromptHash,
        },
      });
      return;
    }
    // 容量对 resume 豁免（与 coworker 路径同语义）：恢复量受关机前存量约束，
    // 不是疯雇；上限的目的是防主 agent 循环雇人。
    if (!resumeFile && parent.coworkers.size >= MAX_ACTIVE_COWORKERS) {
      throw new Error(`coworker limit reached (${MAX_ACTIVE_COWORKERS} active)`);
    }

    let managedRef: ManagedSession | undefined;
    const gate = new ApprovalGate(
      parent.gate.mode,
      (request) => {
        if (!managedRef) return;
        this.options.emit({
          type: 'approval-request',
          identity,
          seq: ++managedRef.seq,
          request,
        });
      },
      (requestId) => {
        if (!managedRef) return;
        this.options.emit({
          type: 'approval-resolved',
          identity,
          seq: ++managedRef.seq,
          requestId,
        });
      }
    );
    const askManager = this.createAskManager(identity);
    const result = await factory.createChildSession({
      resolved: config,
      identity,
      gate,
      askManager,
      resumeFile,
      ...(isLockedEnso
        ? {}
        : {
            extraTools: [
              createMessageMainTool(
                (text, urgent) => this.notifier.notify(identity.parent.sessionId, text, { urgent }),
                identity.instanceName
              ),
            ],
          }),
    });
    const metadata: ChildConversationMetadata = {
      parentId: identity.parent.sessionId,
      childGeneration: identity.generation,
      agentTypeKey: identity.typeKey,
      agentInstanceId: identity.instanceId,
      agentInstanceName: identity.instanceName,
      dispatchOrigin: 'typed-mention',
      ...(identity.profileId ? { lockedProfileId: identity.profileId } : {}),
    };
    const info: CoworkerInfo = {
      id: identity.sessionId,
      child: metadata,
      name: identity.instanceName,
      agentType: identity.typeKey,
      status: 'idle',
      modelId: result.modelId,
      sessionFile: result.safeJournal?.sessionFile ?? result.session.sessionFile,
      createdAt: Date.now(),
    };
    parent.coworkers.set(identity.instanceName, info);
    this.options.emit({
      type: 'coworker-update',
      identity: parent.identity,
      seq: ++parent.seq,
      coworker: info,
    });
    managedRef = this.registerManagedSession(identity, result.session, gate, result.modelId, {
      childIdentity: identity,
      childMetadata: metadata,
      parentId: identity.parent.sessionId,
      coworkerName: identity.instanceName,
      resumeFile,
      asks: askManager,
      ensoApp: result.ensoApp,
      toolIds: result.toolIds,
      proofToolIds: result.proofToolIds,
      safeJournal: result.safeJournal,
    });
    if (!resumeFile) managedRef.pendingRole = config.systemPrompt;
    this.options.emit({
      type: 'child-ready',
      identity,
      seq: ++managedRef.seq,
      sessionFile: result.safeJournal?.sessionFile ?? requiredSessionFile(result.session),
      proof: {
        spawnSpecId: config.spawnSpecId,
        typeKey: config.typeKey,
        model: result.modelRef,
        toolIds: result.proofToolIds,
        loadedSkillBindingIds: config.skillBindingIds,
        loadedMcpBindingIds: config.mcpBindingIds,
        systemPromptHash: config.systemPromptHash,
      },
    });
  }

  /** 雇佣 coworker：独立审批门 + 完整 ManagedSession(prompt/abort/审批通路全复用) */
  private async spawnCoworker(
    parentId: string,
    coworkerId: string,
    name: string,
    agentTypeName?: string,
    modelName?: string,
    resumeFile?: string
  ): Promise<CoworkerInfo> {
    const parent = this.mustCurrent(parentId);
    const factory = parent.factory;
    if (!factory) throw new Error(`session cannot hire coworkers: ${parentId}`);
    if (parent.coworkers.has(name)) throw new Error(`coworker name already in use: ${name}`);
    if (!resumeFile && parent.coworkers.size >= MAX_ACTIVE_COWORKERS) {
      throw new Error(
        `coworker limit reached (${MAX_ACTIVE_COWORKERS} active) — dismiss one before hiring more`
      );
    }
    if (this.sessions.has(coworkerId)) throw new Error(`coworker already exists: ${coworkerId}`);
    // 类型找不到降级 general(resume 时配置漂移不毁恢复;工具路径在 coworker.ts 已前置校验)
    const agentType = agentTypeName
      ? factory.agentTypes.find((type) => type.name === agentTypeName)
      : undefined;
    // 模型同样降级容错:resume/配置漂移时找不到就回 agentType/父模型(工具入口已前置校验)
    const modelOverride = modelName
      ? factory.subagentModels.find((option) => option.name === modelName)?.config
      : undefined;
    const identity: SessionIdentity = { sessionId: coworkerId, generation: randomUUID() };
    const gate = new ApprovalGate(
      parent.gate.mode,
      (request) => {
        const managed = this.sessions.get(coworkerId);
        if (managed) {
          this.options.emit({
            type: 'approval-request',
            identity: managed.identity,
            seq: ++managed.seq,
            request,
          });
        }
      },
      (requestId) => {
        const managed = this.sessions.get(coworkerId);
        if (managed) {
          this.options.emit({
            type: 'approval-resolved',
            identity: managed.identity,
            seq: ++managed.seq,
            requestId,
          });
        }
      }
    );
    const askManager = this.createAskManager(identity);
    const { session, modelId, toolIds } = await factory.createChildSession({
      agentType,
      modelOverride,
      gate,
      resumeFile,
      extraTools: [
        createAskTool(askManager),
        createMessageMainTool(
          (text, urgent) => this.notifier.notify(parentId, text, { urgent }),
          name,
          () => this.sessions.get(coworkerId)?.parentWaiting === true
        ),
      ],
    });
    const info: CoworkerInfo = {
      id: coworkerId,
      name,
      ...(agentType ? { agentType: agentType.name } : {}),
      status: 'idle',
      modelId,
      ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
      createdAt: Date.now(),
    };
    this.options.emit({
      type: 'coworker-update',
      identity: parent.identity,
      seq: ++parent.seq,
      coworker: info,
      coworkerIdentity: identity,
    });
    const managed = this.registerManagedSession(identity, session, gate, modelId, {
      parentId,
      coworkerName: name,
      asks: askManager,
      toolIds,
      ...(resumeFile ? { resumeFile } : {}),
    });
    // 角色提示在首条消息前缀注入(无论来自主 agent send 还是用户 tab);resume 时 jsonl 已有
    if (!resumeFile && agentType?.systemPrompt) {
      managed.pendingRole = agentType.systemPrompt;
    }
    parent.coworkers.set(name, info);
    return info;
  }

  /** 解雇 coworker：中断并销毁会话,jsonl 留盘。返回解雇名(通知/事件用) */
  private async dismissCoworker(parentId: string, coworkerId: string): Promise<string> {
    const parent = this.mustCurrent(parentId);
    const managed = this.sessions.get(coworkerId);
    if (managed) {
      managed.gate.cancelAll();
      managed.asks.cancelAll();
      managed.ensoApp?.cancelAll('Child dismissed');
      try {
        await managed.session.abort();
      } catch {}
      managed.unsubscribe();
      try {
        managed.session.dispose();
      } catch {}
      this.sessions.delete(coworkerId);
      this.settleRound(managed);
    }
    let dismissedName = managed?.coworkerName ?? coworkerId.split('::cw-').at(-1) ?? coworkerId;
    for (const [name, info] of parent.coworkers) {
      if (info.id === coworkerId) {
        dismissedName = name;
        parent.coworkers.delete(name);
        break;
      }
    }
    this.options.emit({
      type: 'coworker-update',
      identity: parent.identity,
      seq: ++parent.seq,
      coworker: { id: coworkerId, name: dismissedName, status: 'dismissed', createdAt: 0 },
    });
    if (managed?.childIdentity) {
      this.options.emit({
        type: 'child-ended',
        identity: managed.childIdentity,
        seq: ++managed.seq,
        reason: 'dismissed',
      });
    }
    return dismissedName;
  }

  /**
   * 向 coworker 发消息。经命令门串行启动(与用户 tab 的 prompt 一致排队);
   * running 时 steer 汇入当前轮。wait=false(默认)投递即返回,完成后经 notifier 通知父;
   * wait=true 阻塞至该轮结束返回结果。父 abort(signal)只提前返回,不杀 coworker(持久实体)。
   */
  private async coworkerSend(
    coworkerId: string,
    text: string,
    opts: { signal?: AbortSignal; wait?: boolean; gate?: string } = {}
  ): Promise<string> {
    const managed = this.mustCurrent(coworkerId);
    const { signal } = opts;
    // 先登记等待再启动,防终态竞态;终态由 settleRound 统一判定(含重试耗尽/abort/销毁)
    const done = this.waitRoundEnd(managed, signal);
    managed.roundPending = true;
    managed.currentTurnId = randomUUID();
    const start = async () => {
      if (managed.status === 'running') {
        await managed.session.steer(text);
      } else {
        void managed.session
          .prompt(consumeRole(managed, text))
          .then(() => {
            // prompt 已归但未见任何终态事件(不应发生的退化路径):不让 wait 挂死
            if (managed.status !== 'running' && managed.roundPending) this.settleRound(managed);
          })
          .catch((error) => {
            this.failTurn(managed, toErrorMessage(error));
          });
      }
    };

    if (opts.wait) {
      managed.parentWaiting = true;
      try {
        await this.gate.run(coworkerId, start);
        await done;
      } finally {
        managed.parentWaiting = false;
      }
      if (signal?.aborted) {
        return `(send interrupted — coworker keeps running; use coworker wait/send to follow up)`;
      }
      return `${await this.coworkerRoundSummary(managed, opts.gate)}\n\n${COWORKER_FOLLOW_UP_HINT}`;
    }

    // 非阻塞:投递即返回;轮次完成后组摘要经 notifier 回父(失败立即,成功合并)
    void (async () => {
      await this.gate.run(coworkerId, start);
      await done;
      const parentId = managed.parentId;
      // 父正在 wait 阻塞等这一轮:结果由 wait 内联返回,不再重复通知
      // (本等待者先于 wait 登记,在 wait 的 finally 复位 parentWaiting 之前运行)
      if (
        !parentId ||
        !this.sessions.has(coworkerId) ||
        managed.parentWaiting ||
        managed.childMetadata?.dispatchOrigin === 'typed-mention'
      ) {
        return;
      }
      const summary = await this.coworkerRoundSummary(managed, opts.gate);
      const failed = managed.status === 'failed';
      const label = managed.coworkerName ?? coworkerId;
      const brief =
        summary.length > NOTIFY_SUMMARY_LIMIT
          ? `${summary.slice(0, NOTIFY_SUMMARY_LIMIT)}\n…(truncated — use coworker report "${label}" for the full text)`
          : summary;
      this.notifier.notify(
        parentId,
        `Coworker "${label}" finished a round:\n${brief}\n\n${COWORKER_FOLLOW_UP_HINT}`,
        { urgent: failed }
      );
    })().catch(() => {});
    const label = managed.coworkerName ?? coworkerId;
    return (
      `(dispatched to coworker "${label}" — you'll be notified when the round completes; ` +
      'keep working or return to the user meanwhile)'
    );
  }

  /**
   * 阻塞至 coworker 当前轮结束(无论由主 agent 还是用户 tab 触发);空闲则立即返回最近一轮摘要。
   * 传 gate 时(重)跑验收。父 abort 只提前返回。
   */
  private async coworkerWait(
    coworkerId: string,
    opts: { signal?: AbortSignal; gate?: string } = {}
  ): Promise<string> {
    const managed = this.mustCurrent(coworkerId);
    if (managed.status === 'running' || managed.roundPending) {
      managed.parentWaiting = true;
      try {
        await this.waitRoundEnd(managed, opts.signal);
      } finally {
        managed.parentWaiting = false;
      }
      if (opts.signal?.aborted) {
        return '(wait interrupted — coworker keeps running; use coworker wait/send to follow up)';
      }
    } else if (!managed.lastRoundSummary) {
      return '(no round completed yet — coworker is idle)';
    }
    return `${await this.coworkerRoundSummary(managed, opts.gate)}\n\n${COWORKER_FOLLOW_UP_HINT}`;
  }

  private mustCoworker(identity: SessionIdentity, name: string): CoworkerInfo {
    const parent = this.must(identity);
    const info = parent.coworkers.get(name);
    if (!info) {
      throw new Error(
        `unknown coworker "${name}". Hired: [${[...parent.coworkers.keys()].join(', ')}]`
      );
    }
    return info;
  }

  private runParentGate(managed: ManagedSession, gateCommand: string): Promise<string> {
    const parentFactory = this.sessions.get(managed.parentId ?? '')?.factory;
    return parentFactory
      ? parentFactory.runGate(gateCommand)
      : runGateCommand(process.cwd(), gateCommand);
  }

  /** 轮次结果正文:最终文本 + 输出截断/上下文水位警告(不含 gate,可缓存) */
  private roundBaseSummary(managed: ManagedSession): string {
    let summary =
      managed.status === 'failed'
        ? '(coworker turn failed — check its tab for details)'
        : lastAssistantText(managed.session) || '(coworker produced no output)';
    const last = [
      ...(managed.session.messages as {
        role?: string;
        stopReason?: string;
        usage?: { input?: number; output?: number };
      }[]),
    ]
      .reverse()
      .find((message) => message.role === 'assistant');
    // 输出被模型上限截断的轮次按不完整处理,不当部分成功接受
    if (last?.stopReason === 'length') {
      summary = `(WARNING: output hit the model limit — treat this round as incomplete)\n${summary}`;
    }
    const used = (last?.usage?.input ?? 0) + (last?.usage?.output ?? 0);
    const window = positiveContextWindow(managed.session.model);
    if (window !== undefined && used > window * 0.85) {
      const pct = Math.round((used / window) * 100);
      summary += `\n\n(coworker context ${pct}% full — have it summarize, or dismiss it soon)`;
    }
    return summary;
  }

  /** 轮次结果摘要 = 缓存正文(settleRound 记入) + 本次 gate 验收结果 */
  private async coworkerRoundSummary(
    managed: ManagedSession,
    gateCommand?: string
  ): Promise<string> {
    const base = managed.lastRoundSummary ?? this.roundBaseSummary(managed);
    return gateCommand ? `${base}\n\n${await this.runParentGate(managed, gateCommand)}` : base;
  }

  private onSessionEvent(
    managed: ManagedSession,
    event: Parameters<Parameters<AgentSession['subscribe']>[0]>[0]
  ): void {
    managed.lastActivityAt = Date.now();
    switch (event.type) {
      case 'agent_start':
        managed.currentTurnId ??= randomUUID();
        managed.status = 'running';
        managed.checkpoints?.resetTurn();
        this.emitStatus(managed);
        return;
      case 'message_start': {
        const index = managed.messages.length;
        const message = projectMessage(event.message);
        if (message?.role === 'assistant') {
          managed.timings[index] = { stepStartMs: Date.now() };
        }
        this.upsertLocalMessage(managed, message);
        return;
      }
      case 'message_update': {
        const index = managed.messages.length - 1;
        const timing = managed.timings[index];
        const projected = projectMessage(event.message);
        if (timing) {
          if (timing.firstTokenMs === undefined) timing.firstTokenMs = Date.now();
          if (
            timing.thinkingEndMs === undefined &&
            projected?.content.some(
              (part) =>
                (part.type === 'text' && part.text.trim()) ||
                part.type === 'toolCall' ||
                part.type === 'image'
            )
          ) {
            timing.thinkingEndMs = Date.now();
          }
        }
        // 工具耗时起点 = toolCall part 首次流式出现（含模型生成参数的时间），
        // 与渲染层运行中计时器（工具行出现即起表）口径一致，避免完成后骤降为 0s
        if (projected?.role === 'assistant') {
          for (const part of projected.content) {
            if (part.type === 'toolCall' && !managed.toolStartAt.has(part.id)) {
              managed.toolStartAt.set(part.id, Date.now());
            }
          }
        }
        this.replaceLastMessage(managed, projected);
        return;
      }
      case 'message_end': {
        const index = managed.messages.length - 1;
        const timing = managed.timings[index];
        if (timing) timing.completedMs = Date.now();
        const projected = projectMessage(event.message);
        this.replaceLastMessage(managed, projected);
        if (projected?.role === 'assistant') {
          const text = projected.content
            .filter(
              (part): part is Extract<(typeof projected.content)[number], { type: 'text' }> =>
                part.type === 'text'
            )
            .map((part) => part.text)
            .join('\\n');
          if (text) managed.safeJournal?.appendAssistantText(text);
        }
        return;
      }
      case 'auto_retry_start':
        managed.lastRetryError = event.errorMessage || 'Unknown error';
        this.options.emit({
          type: 'turn-retry',
          identity: managed.identity,
          seq: ++managed.seq,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage || 'Unknown error',
        });
        return;
      case 'auto_retry_end': {
        // 重试被取消（abortRetry）时没有后续 agent_end，在这里收口；
        // 重试耗尽则已由 agent_end(willRetry=false) 走 failTurn，status 守卫避免重复
        if (event.success || managed.status !== 'running') return;
        this.failTurn(managed, managed.lastRetryError ?? event.finalError ?? 'Auto-retry failed.');
        return;
      }
      case 'tool_execution_start':
        // message_update 已在生成阶段记过起点；这里兜底（如工具调用未经流式直接执行）
        if (!managed.toolStartAt.has(event.toolCallId)) {
          managed.toolStartAt.set(event.toolCallId, Date.now());
        }
        return;
      case 'tool_execution_end': {
        const start = managed.toolStartAt.get(event.toolCallId);
        managed.toolStartAt.delete(event.toolCallId);
        if (start !== undefined) {
          managed.toolDurations.set(event.toolCallId, Date.now() - start);
        }
        return;
      }
      case 'compaction_start':
        managed.compaction = 'running';
        this.options.emit({
          type: 'compaction',
          identity: managed.identity,
          seq: ++managed.seq,
          state: 'start',
        });
        return;
      case 'compaction_end':
        // 自动压缩在 agent_end 之后异步完成：context 视图换了形，重新按完整记录对齐（历史不丢，summary 行入列）
        this.reconcileMessages(managed, this.transcript(managed));
        managed.compaction = undefined;
        // 锚点必须在对齐之后取：否则摘要消息未入列，与 guest 事件口径 maxIndex+1 差 1
        if (!event.errorMessage) managed.compactionNoticeAt = managed.messages.length;
        this.emitSessionMeta(managed);
        this.options.emit({
          type: 'compaction',
          identity: managed.identity,
          seq: ++managed.seq,
          state: 'end',
          ...(event.errorMessage ? { error: event.errorMessage } : {}),
        });
        return;
      case 'agent_end': {
        this.reconcileMessages(managed, this.transcript(managed));
        // pi 将自动重试瞬态错误（随后 auto_retry_start）：非终态，不 settle、
        // 不发 turn-completed、状态保持 running，否则输入框解锁后又自己跑起来
        if (event.willRetry) {
          // pi 的 _prepareRetry 稍后会把这条瞬态错误 assistant 消息从自身状态删掉重发；
          // 提前对齐投影，重试期间时间线不闪现错误（错误文本已在 RetryBar 上）
          const last = managed.messages.at(-1);
          if (last?.role === 'assistant' && last.stopReason === 'error') {
            managed.messages.length -= 1;
            managed.timings.length = managed.messages.length;
            this.options.emit({
              type: 'messages-truncated',
              identity: managed.identity,
              seq: ++managed.seq,
              length: managed.messages.length,
            });
          }
          return;
        }
        if (this.tryAdaptiveDowngrade(managed)) return;
        // 终态错误轮（重试耗尽或不可重试）按失败收口，不再误报「回复完成」
        const lastAssistant = [...managed.messages]
          .reverse()
          .find((message) => message.role === 'assistant');
        if (lastAssistant?.stopReason === 'error') {
          this.failTurn(managed, lastAssistant.errorMessage ?? 'Turn failed.');
          return;
        }
        const turnId = managed.currentTurnId ?? randomUUID();
        managed.currentTurnId = undefined;
        managed.status = 'idle';
        this.emitStatus(managed);
        this.emitSessionMeta(managed);
        this.options.emit({
          type: 'turn-completed',
          identity: managed.identity,
          seq: ++managed.seq,
          turnId,
        });
        if (managed.pendingCompact) {
          const queued = managed.pendingCompact;
          managed.pendingCompact = undefined;
          void this.runCompaction(managed, queued.instructions);
        }
        if (managed.pendingTaskReminders.length > 0) {
          setTimeout(() => {
            if (managed.status !== 'idle' || managed.pendingTaskReminders.length === 0) return;
            const texts = managed.pendingTaskReminders.splice(0);
            this.deliverNotification(managed.identity.sessionId, texts.join('\\n\\n---\\n\\n'));
          }, 150);
        }
        return;
      }
      default:
        return;
    }
  }

  private withTiming(
    managed: ManagedSession,
    index: number,
    message: ProjectedMessage
  ): ProjectedMessage {
    const timing = managed.timings[index];
    let decorated = timing ? { ...message, timing } : message;
    if (decorated.role === 'toolResult' && decorated.toolCallId) {
      const durationMs = managed.toolDurations.get(decorated.toolCallId);
      if (durationMs !== undefined && decorated.toolDurationMs === undefined) {
        decorated = { ...decorated, toolDurationMs: durationMs };
      }
    }
    return decorated;
  }

  private tryAdaptiveDowngrade(managed: ManagedSession): boolean {
    if (managed.adaptiveDowngraded) return false;
    const lastError = managed.messages.at(-1)?.errorMessage ?? '';
    if (!lastError.includes('adaptive thinking is not supported')) return false;
    managed.adaptiveDowngraded = true;
    runtimeAdaptiveBlocklist.add(managed.modelId);
    const compat = managed.session.model?.compat as { forceAdaptiveThinking?: boolean } | undefined;
    if (compat) compat.forceAdaptiveThinking = undefined;
    const lastUser = [...managed.messages].reverse().find((message) => message.role === 'user');
    const text = lastUser?.content.find((part) => part.type === 'text')?.text;
    if (!text) return false;
    void managed.session.prompt(text).catch((error) => {
      this.failTurn(managed, toErrorMessage(error));
    });
    return true;
  }

  private upsertLocalMessage(managed: ManagedSession, message: ProjectedMessage | null): void {
    if (!message) return;
    const index = managed.messages.length;
    const decorated = this.withTiming(managed, index, message);
    managed.messages.push(decorated);
    this.options.emit({
      type: 'message-upsert',
      identity: managed.identity,
      seq: ++managed.seq,
      index,
      message: decorated,
    });
  }

  private replaceLastMessage(managed: ManagedSession, message: ProjectedMessage | null): void {
    if (!message) return;
    if (managed.messages.length === 0) {
      this.upsertLocalMessage(managed, message);
      return;
    }
    const index = managed.messages.length - 1;
    const decorated = this.withTiming(managed, index, message);
    managed.messages[index] = decorated;
    this.options.emit({
      type: 'message-upsert',
      identity: managed.identity,
      seq: ++managed.seq,
      index,
      message: decorated,
    });
  }

  /** 渲染层口径的完整记录：compaction 之前的历史 + pi 当前上下文 */
  private transcript(managed: ManagedSession): unknown[] {
    return transcriptMessages(
      managed.session.sessionManager,
      managed.session.messages as unknown[]
    );
  }

  private reconcileMessages(managed: ManagedSession, rawMessages: unknown[]): void {
    const projected = rawMessages
      .map(projectMessage)
      .filter((message): message is ProjectedMessage => message !== null);
    projected.forEach((rawMessage, index) => {
      const known = managed.messages[index];
      const message = this.withTiming(managed, index, rawMessage);
      if (known && JSON.stringify(known) === JSON.stringify(message)) return;
      managed.messages[index] = message;
      this.options.emit({
        type: 'message-upsert',
        identity: managed.identity,
        seq: ++managed.seq,
        index,
        message,
      });
    });
    if (managed.messages.length > projected.length) {
      managed.messages.length = projected.length;
      managed.timings.length = projected.length;
      this.options.emit({
        type: 'messages-truncated',
        identity: managed.identity,
        seq: ++managed.seq,
        length: projected.length,
      });
    }
  }

  /** 重试倒计时中则打断并等待本轮收尾；返回是否发生了打断（用户输入接管重试） */
  private async interruptRetryIfAny(managed: ManagedSession): Promise<boolean> {
    if (!managed.session.isRetrying) return false;
    managed.session.abortRetry();
    await managed.session.waitForIdle();
    return true;
  }

  private promptFresh(
    managed: ManagedSession,
    text: string,
    images?: { type: 'image'; data: string; mimeType: string }[]
  ): void {
    if (managed.session.isStreaming) {
      void managed.session.steer(text, images).catch((error) => {
        this.failTurn(managed, toErrorMessage(error));
      });
      return;
    }
    managed.currentTurnId = randomUUID();
    void managed.session
      .prompt(consumeRole(managed, text), images ? { images } : undefined)
      .catch((error) => {
        this.failTurn(managed, toErrorMessage(error));
      });
  }

  private failTurn(managed: ManagedSession, error: string): void {
    const turnId = managed.currentTurnId ?? randomUUID();
    managed.currentTurnId = undefined;
    managed.status = 'failed';
    this.emitStatus(managed, error);
    this.options.emit({
      type: 'turn-failed',
      identity: managed.identity,
      seq: ++managed.seq,
      turnId,
      error,
    });
  }

  private emitStatus(managed: ManagedSession, error?: string): void {
    this.options.emit({
      type: 'status',
      identity: managed.identity,
      seq: ++managed.seq,
      status: managed.status,
      ...(error ? { error } : {}),
    });
    if (managed.status !== 'running') this.settleRound(managed);
  }

  /**
   * 轮次终态收口(idle/failed/abort/销毁统一经此):coworker 记下本轮摘要供 report/wait,
   * 唤醒所有等待者。与触发来源(主 agent send / 用户 tab / 重试耗尽)无关。
   */
  private settleRound(managed: ManagedSession): void {
    // 注册时的首次 emitStatus 也走到这里:没跑过任何轮(无 assistant 消息且未失败)不记摘要
    const ran =
      managed.status === 'failed' ||
      (managed.session.messages as { role?: string }[]).some((m) => m.role === 'assistant');
    if (managed.coworkerName && ran) managed.lastRoundSummary = this.roundBaseSummary(managed);
    managed.roundPending = false;
    const waiters = [...managed.roundWaiters];
    managed.roundWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  /** 下一次 settleRound 时 resolve;签号 abort 也 resolve(只提前返回,不杀 coworker) */
  private waitRoundEnd(managed: ManagedSession, signal?: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => {
      managed.roundWaiters.delete(done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    managed.roundWaiters.add(done);
    signal?.addEventListener('abort', done, { once: true });
    return promise;
  }

  /** 执行一次手动压缩。进度/收束由 pi 的 compaction_start / compaction_end 事件推给渲染层；
   *  这里只兵底 compact() 直接抛错（未走到 compaction_end）的情况，否则 UI 会卡在「压缩中」。 */
  private async runCompaction(managed: ManagedSession, instructions?: string): Promise<void> {
    try {
      await managed.session.compact(instructions);
    } catch (error) {
      console.error('[compact] failed:', toErrorMessage(error));
      // 未走到 compaction_end：不清的话快照会让手机永远卡在「压缩中」
      managed.compaction = undefined;
      this.options.emit({
        type: 'compaction',
        identity: managed.identity,
        seq: ++managed.seq,
        state: 'end',
        error: toErrorMessage(error),
      });
    }
  }

  private emitSessionMeta(managed: ManagedSession): void {
    const contextWindow = positiveContextWindow(managed.session.model);
    let occupancy: ReturnType<typeof collectContextOccupancy> | undefined;
    try {
      occupancy = occupancyFromManaged(managed, contextWindow);
    } catch {
      occupancy = undefined;
    }
    this.options.emit({
      type: 'session-meta',
      identity: managed.identity,
      seq: ++managed.seq,
      sessionFile: managed.session.sessionFile,
      ...(occupancy ? { occupancy } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    });
  }

  private snapshotSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.values()).map((managed) => ({
      identity: managed.identity,
      status: managed.status,
      messages: managed.messages,
      commands: managed.commands,
      ...(managed.gate.snapshot().length > 0 ? { pendingApprovals: managed.gate.snapshot() } : {}),
      ...(managed.asks.snapshot().length > 0 ? { pendingAsks: managed.asks.snapshot() } : {}),
      ...(managed.childMetadata ? { child: managed.childMetadata } : {}),
      ...(managed.customEntries.length > 0 ? { customEntries: managed.customEntries } : {}),
      ...(managed.compaction ? { compaction: managed.compaction } : {}),
      ...(managed.compactionNoticeAt !== undefined
        ? { compactionNoticeAt: managed.compactionNoticeAt }
        : {}),
    }));
  }

  private must(identity: SessionIdentity): ManagedSession {
    const managed = this.sessions.get(identity.sessionId);
    if (!managed || !isSameGeneration(managed.identity, identity)) {
      throw new Error(`unknown or stale session generation: ${identity.sessionId}`);
    }
    return managed;
  }

  private mustCurrent(sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`unknown session: ${sessionId}`);
    return managed;
  }

  /** worker 退出前 fail-closed 清理挂起 capability，并断开 MCP 子进程。 */
  shutdown(): Promise<void> {
    clearInterval(this.evictionTimer);
    this.bgTasks.stopAll();
    for (const managed of this.sessions.values()) {
      managed.ensoApp?.cancelAll('Enso worker shutdown');
      managed.browser?.cancelAll('Enso worker shutdown');
      managed.currentTurnId = undefined;
    }
    return this.mcp.closeAll();
  }

  private getRuntime(): Promise<ModelRuntime> {
    // 共享 ModelRuntime（M0 验证项 2 已实测双会话共享可行）
    this.runtimePromise ??= (async () => {
      const runtime = await ModelRuntime.create({
        authPath: path.join(this.options.agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      });
      return initializeWorkerRuntime(runtime);
    })();
    return this.runtimePromise;
  }

  /** 会话标题总结：一次性补全，不建 AgentSession、不落盘；成功才回事件，失败静默 */
  private async summarizeTitle(
    command: Extract<AgentCommand, { type: 'summarize-title' }>
  ): Promise<void> {
    const runtime = await this.getRuntime();
    const model = await resolveBaseModelOrRefresh(runtime, command.model);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TITLE_SUMMARY_TIMEOUT_MS);
    try {
      const message = await runtime.completeSimple(
        model,
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: buildTitleUserText(command.text),
              timestamp: Date.now(),
            },
          ],
        },
        { signal: controller.signal }
      );
      const title = extractTitle(message);
      if (title) {
        this.options.emit({
          type: 'title-generated',
          conversationId: command.conversationId,
          title,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 标题总结超时：超过就保留截断标题，不重试 */
const TITLE_SUMMARY_TIMEOUT_MS = 15_000;

/** 同一父会话的在编 coworker 上限,防主 agent 循环疯狂雇人 */
const MAX_ACTIVE_COWORKERS = 5;
/** 异步通知里的摘要上限;全文经 coworker report 取 */
const NOTIFY_SUMMARY_LIMIT = 1500;
/** 一轮结束回父的摘要尾句：阻塞/非阻塞两条路径共用，把「继续 send」写成默认动作 */
const COWORKER_FOLLOW_UP_HINT =
  '(follow up with coworker send to verify or steer; dismiss only when its goal is met)';

/** gate 验收:在会话 cwd 跑命令,退出码即结论(比再叫一个模型评审便宜且诚实)。
 * 远程会话传 executor,命令改在远端 cwd 执行 */
export function runGateCommand(cwd: string, gate: string, executor?: SshExecutor): Promise<string> {
  if (executor) {
    return executor.exec(gate, { cwd, timeoutMs: 300_000 }).then((result) => {
      if (result.code === 0) return `GATE PASSED: \`${gate}\``;
      const tail = `${result.stdout}\n${result.stderr}`.trim().slice(-1500);
      return `GATE FAILED \`${gate}\` (${result.code ?? 'timeout'}):\n${tail}`;
    });
  }
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', gate],
      { cwd, timeout: 300_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(`GATE PASSED: \`${gate}\``);
          return;
        }
        const tail = `${stdout}\n${stderr}`.trim().slice(-1500);
        resolve(`GATE FAILED \`${gate}\` (${error.code ?? 'timeout'}):\n${tail}`);
      }
    );
  });
}

/** coworker 首条消息前缀注入角色提示,消费一次 */
function consumeRole(managed: { pendingRole?: string }, text: string): string {
  if (!managed.pendingRole) return text;
  const role = managed.pendingRole;
  managed.pendingRole = undefined;
  return `<role>\n${role}\n</role>\n\n${text}`;
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'coworker';

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** provider 注册 id：掺 apiKey 指纹——同一中转 baseUrl 下多个 provider 条目(不同 key)
 *  不能共用注册槽,否则后 spawn 会话覆盖 apiKey 导致请求串账号 */
function providerKeyFor(model: { api: string; baseUrl: string; apiKey: string }): string {
  const keyFp = createHash('sha256').update(model.apiKey).digest('hex').slice(0, 8);
  return `enso-${model.api}-${model.baseUrl}-${keyFp}`;
}

/**
 * worker 的 ModelRuntime 按进程常驻，订阅清单只在首次建 runtime 时联网拉一次。之后用户
 * 才登录 / 后端上新（如 `gemini-3.8-flash-tiered` 这种不在兜底表里的 wire id），Main 侧
 * 已能选到，worker 这边仍是旧清单 → 未命中时对基础 provider 补一次联网刷新再重试。
 */
export async function resolveBaseModelOrRefresh(runtime: ModelRuntime, model: SpawnModelConfig) {
  try {
    return resolveBaseModel(runtime, model);
  } catch (error) {
    if (!model.oauthAccountKey) throw error;
    await refreshWorkerProviderModels(runtime, providerIdOfAccountKey(model.oauthAccountKey));
    return resolveBaseModel(runtime, model);
  }
}

/**
 * 解析 spawn 模型：oauth 直取 pi 内置 catalog（凭证由 runtime 从共享 auth.json 解析，
 * 不注册自定义 provider、不覆盖 UA、不读行覆盖——订阅端点保持 pi 原生标识）；
 * apiKey 注册自定义 provider：行覆盖 > 精确 catalog id > 乐观默认。
 */
export function resolveBaseModel(runtime: ModelRuntime, model: SpawnModelConfig) {
  if (model.oauthAccountKey) {
    // worker 与 Main 是两个 ModelRuntime 实例，只共用 auth.json。合成 id（第 2+ 个账号）
    // 的克隆 provider 必须在本进程也注册一遍，否则 getModel 取不到
    ensureAccountProvider(runtime, model.oauthAccountKey);
    const oauthModel = runtime.getModel(model.oauthAccountKey, model.modelId);
    if (!oauthModel) {
      throw new Error(`oauth model not found: ${model.oauthAccountKey}/${model.modelId}`);
    }
    return oauthModel;
  }
  const providerId = providerKeyFor(model);
  const catalog = findCatalogModelById(runtime.getModels(), model.modelId);
  const resolved = resolveCustomModelCapabilities(catalog, model);
  const contextWindow = resolved.contextWindow ?? 128_000;
  const maxTokens = resolved.maxTokens ?? 32_000;
  runtime.registerProvider(providerId, {
    baseUrl: resolvePiProviderBaseUrl(model.api, model.baseUrl),
    api: model.api,
    apiKey: model.apiKey,
    // 统一伪装为 enso-code 客户端（覆盖 pi 默认的 "pi (darwin ...)"）
    headers: { 'User-Agent': ENSO_USER_AGENT },
    models: [
      {
        id: model.modelId,
        name: model.modelId,
        reasoning: resolved.reasoning,
        ...(resolved.thinkingLevelMap ? { thinkingLevelMap: resolved.thinkingLevelMap } : {}),
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // applyExtension 原样展开定义，不填默认值；缺 contextWindow 时 pi 会把 max_tokens 钳成 NaN
        contextWindow,
        // 太小会把 high/max 的思考预算压扁（预算被限制在 maxTokens-1024 内）
        maxTokens,
      },
    ],
  });
  const registered = runtime.getModel(providerId, model.modelId);
  if (!registered) throw new Error(`model not found after register: ${model.modelId}`);
  return registered;
}

/** 统一的客户端标识，格式对齐 pi-coding-agent 的 getPiUserAgent（<name>/<ver> (<platform>; <runtime>; <arch>)） */
const ENSO_USER_AGENT = `enso-code/${version} (${process.platform}; node/${process.version}; ${process.arch})`;

/**
 * adaptive thinking（output_config.effort）的判定：乐观默认支持——未来新模型都支持，
 * 白名单会过时而这个黑名单是封闭集合（不支持的只有历史老世代，不会再新增）。
 * 漏网的靠运行时自愈：撞到 "adaptive thinking is not supported" 会记入 runtimeAdaptiveBlocklist
 * 并自动降级重试（见 tryAdaptiveDowngrade）。
 */
const ADAPTIVE_UNSUPPORTED = /claude-(3|opus-4-[0-6]|sonnet-4-[0-6]|haiku-4-[0-6])/i;
/** 运行时学到的不支持 adaptive 的模型（进程内记忆） */
const runtimeAdaptiveBlocklist = new Set<string>();

export function supportsAdaptiveThinking(modelId: string): boolean {
  return !ADAPTIVE_UNSUPPORTED.test(modelId) && !runtimeAdaptiveBlocklist.has(modelId);
}

function occupancyFromManaged(
  managed: ManagedSession,
  contextWindow: number | undefined
): ReturnType<typeof collectContextOccupancy> {
  const loader = managed.session.resourceLoader as {
    getAgentsFiles?: () => { agentsFiles?: ReadonlyArray<{ path: string; content: string }> };
    getSkills?: () => { skills?: OccupancySkill[] };
  };
  const sessionManager = managed.session.sessionManager as {
    buildSessionContext?: () => { messages?: unknown[] };
    getBranch?: () => OccupancyBranchEntry[];
  };
  const branch = sessionManager.getBranch?.() ?? [];
  return collectContextOccupancy({
    systemPrompt: managed.session.systemPrompt ?? '',
    agentsFiles: loader.getAgentsFiles?.().agentsFiles ?? [],
    skills: loader.getSkills?.().skills ?? [],
    tools: typeof managed.session.getAllTools === 'function' ? managed.session.getAllTools() : [],
    contextMessages: sessionManager.buildSessionContext?.().messages ?? [],
    branch,
    currentModelFamily: modelFamilyOf(managed.session.model?.id ?? managed.modelId),
    compactionModelFamily: compactionModelFamilyOf(branch),
    contextWindow,
    pendingTaskReminders: managed.pendingTaskReminders,
    estimateMessageTokens: (message) => {
      try {
        return estimateTokens(message as never);
      } catch {
        return 0;
      }
    },
  });
}

function compactionModelFamilyOf(
  branch: ReadonlyArray<{ type: string; modelId?: string }>
): string | undefined {
  let lastModel: string | undefined;
  for (const entry of branch) {
    if (entry.type === 'model_change' && typeof entry.modelId === 'string')
      lastModel = entry.modelId;
    if (entry.type === 'compaction') return lastModel ? modelFamilyOf(lastModel) : undefined;
  }
  return undefined;
}

function modelFamilyOf(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes('claude')) return 'claude';
  if (id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4'))
    return 'gpt';
  if (id.includes('gemini')) return 'gemini';
  const vendor = id.split(/[-/_]/)[0];
  return vendor || id;
}

/**
 * 按 reasoning 开关就地定制 model：关 → reasoning:false（pi 不发 thinking）；
 * 开 → reasoning:true + adaptive 模型加 forceAdaptiveThinking。返回同一个 model（就地改）。
 */
function applyReasoningToModel<T extends { reasoning?: boolean; compat?: unknown }>(
  model: T,
  enabled: boolean,
  modelId: string
): T {
  model.reasoning = enabled;
  const adaptive = enabled && supportsAdaptiveThinking(modelId);
  const compat = (model.compat ?? {}) as { forceAdaptiveThinking?: boolean };
  compat.forceAdaptiveThinking = adaptive ? true : undefined;
  model.compat = compat;
  return model;
}

/** 从 pi 的资源加载器收集可用斜杠命令：skills（/skill:name）与 prompt templates（/name） */
function collectSlashCommands(session: AgentSession): SlashCommand[] {
  const commands: SlashCommand[] = [];
  try {
    const loader = session.resourceLoader;
    for (const skill of loader.getSkills().skills) {
      commands.push({ name: `/skill:${skill.name}`, description: skill.description });
    }
    for (const prompt of loader.getPrompts().prompts) {
      commands.push({ name: `/${prompt.name}`, description: prompt.description });
    }
  } catch {
    // 资源加载失败不阻塞会话，命令列表为空即可
  }
  return commands;
}

import path from 'node:path';
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentCommand,
  AgentWorkerEvent,
  NodeStatus,
  ProjectedMessage,
  SessionSnapshot,
  SlashCommand,
  SpawnModelConfig,
  ThinkingLevel,
} from '@shared/types/agent';
import { OperationGate } from './gate';
import { projectMessage } from './projection';

interface ManagedSession {
  session: AgentSession;
  status: NodeStatus;
  seq: number;
  /** 渲染层投影的权威副本，message-upsert 以此为准 */
  messages: ProjectedMessage[];
  commands: SlashCommand[];
  modelId: string;
  /** adaptive→budget 的自动降级每会话只做一次，防重试循环 */
  adaptiveDowngraded: boolean;
  unsubscribe: () => void;
}

export interface SupervisorOptions {
  emit(event: AgentWorkerEvent): void;
  /** pi 全局目录（auth/models/settings），指到 app userData 下以隔离用户的 ~/.pi */
  agentDir: string;
  /** 会话 jsonl 目录 */
  sessionDir: string;
}

/** 故障域 A：本进程持有全部活会话。同一会话的命令串行，不同会话并行。 */
export class SessionSupervisor {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly gate = new OperationGate();
  private runtimePromise: Promise<ModelRuntime> | null = null;

  constructor(private readonly options: SupervisorOptions) {}

  handleCommand(command: AgentCommand): void {
    if (command.type === 'snapshot') {
      this.options.emit({ type: 'snapshot', sessions: this.snapshotSessions() });
      return;
    }
    const sessionId = command.sessionId;
    void this.gate
      .run(sessionId, () => this.execute(command))
      .catch((error) => {
        const managed = this.sessions.get(sessionId);
        if (managed) {
          managed.status = 'failed';
          this.emitStatus(sessionId, managed, toErrorMessage(error));
        } else {
          // spawn 失败时会话尚未登记，用独立事件告知
          this.options.emit({
            type: 'status',
            sessionId,
            seq: 0,
            status: 'failed',
            error: toErrorMessage(error),
          });
        }
      });
  }

  private async execute(command: Exclude<AgentCommand, { type: 'snapshot' }>): Promise<void> {
    switch (command.type) {
      case 'spawn':
        await this.spawn(
          command.sessionId,
          command.cwd,
          command.model,
          command.resumeFile,
          command.reasoningEnabled ?? false,
          command.thinkingLevel,
          command.loadLocalSkills,
          command.skillPaths
        );
        return;
      case 'prompt': {
        const managed = this.must(command.sessionId);
        const images = command.images?.map((image) => ({ type: 'image' as const, ...image }));
        // user 消息不本地 upsert——agent 会为它发 message_start，本地再发一份会错位
        // prompt 的 promise 覆盖整个 turn，不 await——否则门会把 steer/abort 排到 turn 之后
        void managed.session
          .prompt(command.text, images ? { images } : undefined)
          .catch((error) => {
            managed.status = 'failed';
            this.emitStatus(command.sessionId, managed, toErrorMessage(error));
          });
        return;
      }
      case 'steer': {
        const images = command.images?.map((image) => ({ type: 'image' as const, ...image }));
        await this.must(command.sessionId).session.steer(command.text, images);
        return;
      }
      case 'set-thinking':
        this.must(command.sessionId).session.setThinkingLevel(command.level);
        return;
      case 'set-reasoning': {
        const managed = this.must(command.sessionId);
        if (managed.session.model) {
          applyReasoningToModel(managed.session.model, command.enabled, managed.modelId);
        }
        // 重新开启时把档位落到 session（clamp 到模型支持的档位）
        if (command.enabled && command.level) {
          managed.session.setThinkingLevel(command.level);
        }
        return;
      }
      case 'abort':
        await this.must(command.sessionId).session.abort();
        return;
    }
  }

  private async spawn(
    sessionId: string,
    cwd: string,
    model: SpawnModelConfig,
    resumeFile?: string,
    reasoningEnabled = false,
    thinkingLevel?: ThinkingLevel,
    loadLocalSkills = true,
    skillPaths: string[] = []
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    const runtime = await this.getRuntime();
    const providerId = `enso-${model.api}-${model.baseUrl}`;
    // 注册基础模型恒 reasoning:true（放开全部档位能力）。开关/adaptive 由 per-session
    // 克隆的 applyReasoningToModel 决定，避免同 provider 多会话共享引用而串台或被后开会话覆盖。
    runtime.registerProvider(providerId, {
      baseUrl: model.baseUrl,
      api: model.api,
      apiKey: model.apiKey,
      // 统一伪装为 enso-code 客户端（覆盖 pi 默认的 "pi (darwin ...)"）
      headers: { 'User-Agent': ENSO_USER_AGENT },
      models: [
        {
          id: model.modelId,
          name: model.modelId,
          reasoning: true,
          // max 档需显式声明，否则被钳到 high
          thinkingLevelMap: { max: 'max' },
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          // 太小会把 high/max 的思考预算压扁（预算被限制在 maxTokens-1024 内）
          maxTokens: 32_000,
        },
      ],
    });
    const baseModel = runtime.getModel(providerId, model.modelId);
    if (!baseModel) throw new Error(`model not found after register: ${model.modelId}`);
    // per-session 独立副本：set-reasoning 就地改它，不污染其它会话
    const piModel = applyReasoningToModel(
      { ...baseModel, compat: baseModel.compat ? { ...baseModel.compat } : undefined },
      reasoningEnabled,
      model.modelId
    );

    // 定制资源加载：noSkills 关掉本机自动发现（.agents/skills、.pi/skills），
    // additionalSkillPaths 注入应用内登记的 skill——两者独立，noSkills 下注入仍生效。
    // 注意：createAgentSession 只对自建 loader 调 reload，传入的必须先自行 reload
    let resourceLoader: DefaultResourceLoader | undefined;
    if (loadLocalSkills === false || skillPaths.length > 0) {
      resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: this.options.agentDir,
        noSkills: loadLocalSkills === false,
        ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
      });
      await resourceLoader.reload();
    }

    const { session } = await createAgentSession({
      cwd,
      agentDir: this.options.agentDir,
      modelRuntime: runtime,
      model: piModel,
      thinkingLevel: reasoningEnabled ? (thinkingLevel ?? 'medium') : 'off',
      resourceLoader,
      sessionManager: resumeFile
        ? SessionManager.open(resumeFile, this.options.sessionDir, cwd)
        : SessionManager.create(cwd, this.options.sessionDir),
    });

    const managed: ManagedSession = {
      session,
      status: 'idle',
      seq: 0,
      messages: [],
      commands: collectSlashCommands(session),
      modelId: model.modelId,
      adaptiveDowngraded: false,
      unsubscribe: () => {},
    };
    managed.unsubscribe = session.subscribe((event) => {
      this.onSessionEvent(sessionId, managed, event);
    });
    this.sessions.set(sessionId, managed);
    this.emitStatus(sessionId, managed);
    this.options.emit({
      type: 'commands',
      sessionId,
      seq: ++managed.seq,
      commands: managed.commands,
    });
    // jsonl 路径回传给 renderer 持久化，app 重启后凭它 resume
    this.options.emit({
      type: 'session-meta',
      sessionId,
      seq: ++managed.seq,
      sessionFile: managed.session.sessionFile,
    });
    if (resumeFile) {
      // 恢复的会话历史一次性快照回放——逐条 upsert 会打出上千条 IPC 事件，渲染层每条都重渲染
      managed.messages = (managed.session.messages as unknown[])
        .map(projectMessage)
        .filter((message): message is ProjectedMessage => message !== null);
      this.options.emit({
        type: 'snapshot',
        partial: true,
        sessions: [
          {
            sessionId,
            status: managed.status,
            messages: managed.messages,
            commands: managed.commands,
          },
        ],
      });
    }
  }

  private onSessionEvent(
    sessionId: string,
    managed: ManagedSession,
    event: Parameters<Parameters<AgentSession['subscribe']>[0]>[0]
  ): void {
    switch (event.type) {
      case 'agent_start':
        managed.status = 'running';
        this.emitStatus(sessionId, managed);
        return;
      case 'message_start':
        this.upsertLocalMessage(sessionId, managed, projectMessage(event.message));
        return;
      case 'message_update':
      case 'message_end':
        this.replaceLastMessage(sessionId, managed, projectMessage(event.message));
        return;
      case 'agent_end': {
        // 全量对齐兜住未经 message_* 事件出现的消息（steer 注入等）。
        // 注意：agent_end 事件的 messages 只是本次 run 的消息，多轮会话下
        // 用它对齐会把历史轮次抹掉；session.messages 才是全量权威源。
        this.reconcileMessages(sessionId, managed, managed.session.messages as unknown[]);
        if (this.tryAdaptiveDowngrade(sessionId, managed)) return;
        managed.status = 'idle';
        this.emitStatus(sessionId, managed);
        this.options.emit({ type: 'turn-completed', sessionId, seq: ++managed.seq });
        return;
      }
      default:
        return;
    }
  }

  /**
   * 运行时自愈：模型不吃 adaptive（400 "adaptive thinking is not supported"）时，
   * 记入黑名单、就地改回 budget 形态并自动重发最后一条输入。返回 true 表示已接管本次收尾。
   */
  private tryAdaptiveDowngrade(sessionId: string, managed: ManagedSession): boolean {
    if (managed.adaptiveDowngraded) return false;
    const lastError = managed.messages.at(-1)?.errorMessage ?? '';
    if (!lastError.includes('adaptive thinking is not supported')) return false;
    managed.adaptiveDowngraded = true;
    runtimeAdaptiveBlocklist.add(managed.modelId);
    const compat = managed.session.model?.compat as { forceAdaptiveThinking?: boolean } | undefined;
    if (compat) compat.forceAdaptiveThinking = undefined;
    // 重发最后一条 user 文本（降级场景极少见，图片附件不随重试携带）
    const lastUser = [...managed.messages].reverse().find((message) => message.role === 'user');
    const text = lastUser?.content.find((part) => part.type === 'text')?.text;
    if (!text) return false;
    void managed.session.prompt(text).catch((error) => {
      managed.status = 'failed';
      this.emitStatus(sessionId, managed, toErrorMessage(error));
    });
    return true;
  }

  private upsertLocalMessage(
    sessionId: string,
    managed: ManagedSession,
    message: ProjectedMessage | null
  ): void {
    if (!message) return;
    const index = managed.messages.length;
    managed.messages.push(message);
    this.options.emit({ type: 'message-upsert', sessionId, seq: ++managed.seq, index, message });
  }

  private replaceLastMessage(
    sessionId: string,
    managed: ManagedSession,
    message: ProjectedMessage | null
  ): void {
    if (!message) return;
    if (managed.messages.length === 0) {
      this.upsertLocalMessage(sessionId, managed, message);
      return;
    }
    const index = managed.messages.length - 1;
    managed.messages[index] = message;
    this.options.emit({ type: 'message-upsert', sessionId, seq: ++managed.seq, index, message });
  }

  private reconcileMessages(
    sessionId: string,
    managed: ManagedSession,
    rawMessages: unknown[]
  ): void {
    const projected = rawMessages
      .map(projectMessage)
      .filter((message): message is ProjectedMessage => message !== null);
    projected.forEach((message, index) => {
      const known = managed.messages[index];
      if (known && JSON.stringify(known) === JSON.stringify(message)) return;
      managed.messages[index] = message;
      this.options.emit({ type: 'message-upsert', sessionId, seq: ++managed.seq, index, message });
    });
    if (managed.messages.length > projected.length) {
      managed.messages.length = projected.length;
      this.options.emit({
        type: 'messages-truncated',
        sessionId,
        seq: ++managed.seq,
        length: projected.length,
      });
    }
  }

  private emitStatus(sessionId: string, managed: ManagedSession, error?: string): void {
    this.options.emit({
      type: 'status',
      sessionId,
      seq: ++managed.seq,
      status: managed.status,
      ...(error ? { error } : {}),
    });
  }

  private snapshotSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.entries()).map(([sessionId, managed]) => ({
      sessionId,
      status: managed.status,
      messages: managed.messages,
      commands: managed.commands,
    }));
  }

  private must(sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`unknown session: ${sessionId}`);
    return managed;
  }

  private getRuntime(): Promise<ModelRuntime> {
    // 共享 ModelRuntime（M0 验证项 2 已实测双会话共享可行）
    this.runtimePromise ??= ModelRuntime.create({
      authPath: path.join(this.options.agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    return this.runtimePromise;
  }
}

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 统一的客户端标识，替换 pi 默认发出的 "pi (darwin ...; arm64)" */
const ENSO_USER_AGENT = 'enso-code';

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

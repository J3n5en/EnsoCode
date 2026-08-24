import path from 'node:path';
import {
  type AgentSession,
  createAgentSession,
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
          command.thinkingLevel
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
    thinkingLevel?: ThinkingLevel
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    const runtime = await this.getRuntime();
    const providerId = `enso-${model.api}-${model.baseUrl}`;
    runtime.registerProvider(providerId, {
      baseUrl: model.baseUrl,
      api: model.api,
      apiKey: model.apiKey,
      models: [
        {
          id: model.modelId,
          name: model.modelId,
          // 声明支持 reasoning，否则 pi 会把任何思考档位钳到 off
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
    });
    const piModel = runtime.getModel(providerId, model.modelId);
    if (!piModel) throw new Error(`model not found after register: ${model.modelId}`);

    const { session } = await createAgentSession({
      cwd,
      agentDir: this.options.agentDir,
      modelRuntime: runtime,
      model: piModel,
      thinkingLevel: thinkingLevel ?? 'off',
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
        managed.status = 'idle';
        this.emitStatus(sessionId, managed);
        this.options.emit({ type: 'turn-completed', sessionId, seq: ++managed.seq });
        return;
      }
      default:
        return;
    }
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

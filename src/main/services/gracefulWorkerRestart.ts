import { parseRestartCheckpoint } from '@shared/gracefulRestart';
import type {
  AgentCommand,
  AgentSpawnRequest,
  AgentWorkerEvent,
  SessionIdentity,
} from '@shared/types/agent';
import { type RestartSessionSettings, secretValuesOf } from './restartManifest';

export type GracefulRestartRequest = 'requested' | 'already-restarting' | 'no-session';
/** joined：菜单重启正在等安全点，改为退出用；busy：旧进程已在换代，没有可等的 */
export type GracefulQuitRequest = 'requested' | 'joined' | 'no-session' | 'busy';
export interface RestartSettingsSnapshot {
  settingsOf(sessionId: string, generation: string): RestartSessionSettings | undefined;
  secrets: string[];
}

type SpawnParent = Extract<AgentCommand, { type: 'spawn-parent' }>;
interface RestartSession {
  spawn: SpawnParent;
  settings: Map<string, AgentCommand>;
  /** 普通根会话的 spawn 请求（不含凭据）：退出时写进恢复清单，冷启动按它重走 spawn */
  request?: RestartSessionSettings;
}

/** spawn 之后改会话配置的命令：换代时跟在 spawn 后面重发，每种只留最新一条 */
const SESSION_SETTINGS = new Set<AgentCommand['type']>([
  'set-model',
  'set-thinking',
  'set-reasoning',
  'set-system-prompt',
  'set-approval-mode',
  'set-ask-relay',
  'set-plan-mode',
  'set-builtin-tools',
]);

/**
 * Main 侧的优雅重启：记住每个父会话最近一次 spawn-parent（含凭据，只在 Main 内存）与之后的会话设置；
 * worker 落好断点后由它决定换代时重发哪些命令。同一时刻只有一次重启在进行。
 */
export class GracefulWorkerRestart<W> {
  private readonly sessions = new Map<string, RestartSession>();
  private phase: 'idle' | 'waiting' | 'swapping' = 'idle';
  /** swap = 菜单重启换进程；quit = 应用退出 / 安装更新，断点落盘后不换代 */
  private mode: 'swap' | 'quit' = 'swap';
  private owner: W | undefined;
  private replay: AgentCommand[] = [];

  get pending(): boolean {
    return this.phase !== 'idle';
  }

  get quitting(): boolean {
    return this.mode === 'quit';
  }

  /** 显式停掉 worker：会话随之消失，进行中的重启作废 */
  reset(): void {
    this.sessions.clear();
    this.phase = 'idle';
    this.mode = 'swap';
    this.owner = undefined;
    this.replay = [];
  }

  record(command: AgentCommand): void {
    if (command.type === 'spawn-parent') {
      this.sessions.set(command.identity.sessionId, { spawn: command, settings: new Map() });
      return;
    }
    if (command.type === 'release-parent') {
      this.forget(command.identity);
      return;
    }
    if (!SESSION_SETTINGS.has(command.type) || !('identity' in command)) return;
    const session = this.current(command.identity);
    if (!session) return;
    session.settings.delete(command.type);
    session.settings.set(command.type, command);
    if (session.request) session.request = patchRequest(session.request, command);
  }

  /** spawn-parent 已记下之后调用：附上这次的原始请求，供退出时写恢复清单 */
  rememberRequest(identity: SessionIdentity, request: AgentSpawnRequest): void {
    const session = this.current(identity);
    if (!session) return;
    const { sessionId: _sessionId, resumeFile: _resumeFile, ...settings } = request;
    session.request = settings;
  }

  /** 就地换模型：清单里只记 provider / model id，凭据冷启动时重新解析 */
  recordModel(identity: SessionIdentity, providerId: string, modelId: string): void {
    const session = this.current(identity);
    if (session?.request) session.request = { ...session.request, providerId, modelId };
  }

  restartSettingsOf(sessionId: string, generation: string): RestartSessionSettings | undefined {
    return this.current({ sessionId, generation })?.request;
  }

  /** 停 worker 前留一份会话设置与凭据：worker 收尾时才落的断点仍能配上设置写清单 */
  snapshot(): RestartSettingsSnapshot {
    const requests = new Map(
      [...this.sessions].map(([id, session]) => [
        id,
        { generation: session.spawn.identity.generation, request: session.request },
      ])
    );
    return {
      settingsOf: (sessionId, generation) => {
        const entry = requests.get(sessionId);
        return entry?.generation === generation ? entry.request : undefined;
      },
      secrets: this.knownSecrets(),
    };
  }

  /** Main 内存里各会话真实下发过的凭据：写清单后据此核对一个都没有落盘 */
  knownSecrets(): string[] {
    return [...this.sessions.values()].flatMap((session) =>
      secretValuesOf([session.spawn, ...session.settings.values()])
    );
  }

  observe(event: AgentWorkerEvent): void {
    if (event.type === 'parent-ended' || event.type === 'parent-rejected')
      this.forget(event.identity);
  }

  request(worker: W | null): GracefulRestartRequest {
    if (this.phase !== 'idle') return 'already-restarting';
    if (!worker || this.sessions.size === 0) return 'no-session';
    this.phase = 'waiting';
    this.mode = 'swap';
    this.owner = worker;
    return 'requested';
  }

  /** 应用退出 / 安装更新：同一套安全点，但断点落盘后不换代，由调用方放行退出 */
  requestQuit(worker: W | null): GracefulQuitRequest {
    if (this.phase === 'swapping') return 'busy';
    if (this.phase === 'waiting') {
      this.mode = 'quit';
      return 'joined';
    }
    if (!worker || this.sessions.size === 0) return 'no-session';
    this.phase = 'waiting';
    this.mode = 'quit';
    this.owner = worker;
    return 'requested';
  }

  /**
   * 退出没成（安装更新失败）：改回换代。返回 true 表示 worker 已落断点、不再推进会话，
   * 调用方应让它退出，由 exit 分支按断点换新进程。
   */
  cancelQuit(): boolean {
    if (this.mode !== 'quit') return false;
    this.mode = 'swap';
    return this.phase === 'swapping';
  }

  /** worker 断点已落盘：之后它不再推进会话，调用方应停止投递并让它退出 */
  ready(worker: W, raw: unknown): boolean {
    if (this.phase !== 'waiting' || this.owner !== worker) return false;
    this.phase = 'swapping';
    const checkpoint = parseRestartCheckpoint(raw);
    if (!checkpoint) console.error('[graceful-restart] worker 断点格式不对，换代后不恢复会话');
    const kept = new Map<string, RestartSession>();
    for (const entry of checkpoint?.sessions ?? []) {
      const session = this.sessions.get(entry.sessionId);
      if (!session || session.spawn.identity.generation !== entry.generation) continue;
      kept.set(entry.sessionId, {
        ...session,
        spawn: { ...session.spawn, resumeFile: entry.sessionFile },
      });
    }
    this.sessions.clear();
    for (const [id, session] of kept) this.sessions.set(id, session);
    this.replay = [...kept.values()].flatMap((session) => [
      session.spawn,
      ...session.settings.values(),
    ]);
    return true;
  }

  /** worker 退出：swap=true 时按 replay 拉起下一代；否则是崩溃，worker 里的会话全没了 */
  exited(worker: W): { swap: true; replay: AgentCommand[] } | { swap: false } {
    const swap = this.phase === 'swapping' && this.owner === worker;
    const replay = this.replay;
    this.phase = 'idle';
    this.mode = 'swap';
    this.owner = undefined;
    this.replay = [];
    if (swap) return { swap, replay };
    this.sessions.clear();
    return { swap };
  }

  private current(identity: SessionIdentity): RestartSession | undefined {
    const session = this.sessions.get(identity.sessionId);
    return session?.spawn.identity.generation === identity.generation ? session : undefined;
  }

  private forget(identity: { sessionId: string; generation: string }): void {
    const session = this.sessions.get(identity.sessionId);
    if (session?.spawn.identity.generation === identity.generation)
      this.sessions.delete(identity.sessionId);
  }
}

function patchRequest(
  request: RestartSessionSettings,
  command: AgentCommand
): RestartSessionSettings {
  switch (command.type) {
    case 'set-thinking':
      return { ...request, thinkingLevel: command.level };
    case 'set-reasoning':
      return {
        ...request,
        reasoningEnabled: command.enabled,
        ...(command.level ? { thinkingLevel: command.level } : {}),
      };
    case 'set-approval-mode':
      return {
        ...request,
        approvalMode: command.mode,
        ...(command.autoReject === undefined ? {} : { autoRejectApprovals: command.autoReject }),
      };
    case 'set-ask-relay': {
      const { askRelay: _askRelay, ...rest } = request;
      return command.relay ? { ...rest, askRelay: { name: command.relay.name } } : rest;
    }
    case 'set-plan-mode':
      return { ...request, planMode: command.active };
    case 'set-builtin-tools':
      return { ...request, disabledTools: [...command.disabledTools] };
    default:
      return request;
  }
}

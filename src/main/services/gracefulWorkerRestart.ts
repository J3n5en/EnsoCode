import { parseRestartCheckpoint } from '@shared/gracefulRestart';
import type { AgentCommand, AgentWorkerEvent } from '@shared/types/agent';

export type GracefulRestartRequest = 'requested' | 'already-restarting' | 'no-session';

type SpawnParent = Extract<AgentCommand, { type: 'spawn-parent' }>;

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
  private readonly sessions = new Map<
    string,
    { spawn: SpawnParent; settings: Map<string, AgentCommand> }
  >();
  private phase: 'idle' | 'waiting' | 'swapping' = 'idle';
  private owner: W | undefined;
  private replay: AgentCommand[] = [];

  get pending(): boolean {
    return this.phase !== 'idle';
  }

  /** 显式停掉 worker：会话随之消失，进行中的重启作废 */
  reset(): void {
    this.sessions.clear();
    this.phase = 'idle';
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
    const session = this.sessions.get(command.identity.sessionId);
    if (!session || session.spawn.identity.generation !== command.identity.generation) return;
    session.settings.delete(command.type);
    session.settings.set(command.type, command);
  }

  observe(event: AgentWorkerEvent): void {
    if (event.type === 'parent-ended' || event.type === 'parent-rejected')
      this.forget(event.identity);
  }

  request(worker: W | null): GracefulRestartRequest {
    if (this.phase !== 'idle') return 'already-restarting';
    if (!worker || this.sessions.size === 0) return 'no-session';
    this.phase = 'waiting';
    this.owner = worker;
    return 'requested';
  }

  /** worker 断点已落盘：之后它不再推进会话，调用方应停止投递并让它退出 */
  ready(worker: W, raw: unknown): boolean {
    if (this.phase !== 'waiting' || this.owner !== worker) return false;
    this.phase = 'swapping';
    const checkpoint = parseRestartCheckpoint(raw);
    if (!checkpoint) console.error('[graceful-restart] worker 断点格式不对，换代后不恢复会话');
    const kept = new Map<string, { spawn: SpawnParent; settings: Map<string, AgentCommand> }>();
    for (const entry of checkpoint?.sessions ?? []) {
      const session = this.sessions.get(entry.sessionId);
      if (!session || session.spawn.identity.generation !== entry.generation) continue;
      kept.set(entry.sessionId, {
        spawn: { ...session.spawn, resumeFile: entry.sessionFile },
        settings: session.settings,
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
    this.owner = undefined;
    this.replay = [];
    if (swap) return { swap, replay };
    this.sessions.clear();
    return { swap };
  }

  private forget(identity: { sessionId: string; generation: string }): void {
    const session = this.sessions.get(identity.sessionId);
    if (session?.spawn.identity.generation === identity.generation)
      this.sessions.delete(identity.sessionId);
  }
}

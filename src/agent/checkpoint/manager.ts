import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  type CheckpointHost,
  createCheckpoint,
  getRepoRoot,
  loadAllCheckpoints,
  localCheckpointHost,
  pruneCheckpoints,
  pruneStaleCheckpoints,
  restoreCheckpoint,
} from './core';

/** 触发快照的写盘工具 */
const MUTATING_TOOLS = new Set(['write', 'edit', 'bash', 'powershell']);

/**
 * per 顶级会话的 checkpoint 管理:每轮首个写盘工具执行前打一次工作树快照,
 * 快照关联本轮 user 消息的 session entry(回退还原按 entry 匹配)。
 * 非 git 项目 / git 连续失败 3 次即禁用,静默降级,绝不影响工具执行。
 */
export class CheckpointManager {
  /** undefined = 未探测;null = 非 git 项目 */
  private root: string | null | undefined;
  private turnDone = false;
  private failures = 0;
  private disabled = false;

  constructor(
    private readonly cwd: string,
    private readonly sessionId: string,
    /** 当前分支最后一个 user entry(即本轮的 user 消息);供快照关联 */
    private readonly getTurnEntry: () => { entryId?: string; entryTimestamp?: number },
    /** 执行面:本地会话缺省本机 git,远程会话传 ssh 实现(快照打在远端 repo) */
    private readonly host: CheckpointHost = localCheckpointHost
  ) {}

  /** agent_start 时调用,放行本轮的一次快照 */
  resetTurn(): void {
    this.turnDone = false;
  }

  private async resolveRoot(): Promise<string | null> {
    if (this.root === undefined) {
      this.root = await getRepoRoot(this.cwd, this.host).catch(() => null);
    }
    return this.root;
  }

  /** 每轮至多一次;失败静默(先置 turnDone,同轮不重试) */
  async ensureTurnCheckpoint(toolName: string): Promise<void> {
    if (this.disabled || this.turnDone) return;
    this.turnDone = true;
    try {
      const root = await this.resolveRoot();
      if (!root) {
        this.disabled = true;
        return;
      }
      const { entryId, entryTimestamp } = this.getTurnEntry();
      await createCheckpoint(
        {
          root,
          id: `tool-${this.sessionId}-${Date.now()}`,
          sessionId: this.sessionId,
          trigger: 'tool',
          toolName,
          entryId,
          entryTimestamp,
        },
        this.host
      );
      void pruneCheckpoints(root, this.sessionId, undefined, this.host).catch(() => {});
      this.failures = 0;
    } catch {
      if (++this.failures >= 3) this.disabled = true;
    }
  }

  /**
   * 把工作树还原到目标 user entry 那一轮开始前的状态。
   * 匹配:entryId 精确命中 → 该轮首个写操作前;否则取 entryTimestamp ≥ 目标时间戳的
   * 最早快照(该轮没写盘,取其后最先发生的写操作前);无命中说明目标之后没写过盘,
   * 工作树已是目标状态。还原前打 before-restore 安全快照。
   * @returns 是否实际执行了还原
   */
  async restoreForEntry(entryId: string, entryTimestamp: number): Promise<boolean> {
    const root = await this.resolveRoot();
    if (!root) return false;
    const all = await loadAllCheckpoints(root, this.sessionId, this.host);
    const candidates = all.filter((cp) => cp.trigger === 'tool');
    const exact = candidates.find((cp) => cp.entryId === entryId);
    const target =
      exact ??
      candidates
        .filter((cp) => (cp.entryTimestamp ?? cp.timestamp) >= entryTimestamp)
        .sort((a, b) => (a.entryTimestamp ?? a.timestamp) - (b.entryTimestamp ?? b.timestamp))[0];
    if (!target) return false;
    await createCheckpoint(
      {
        root,
        id: `before-restore-${this.sessionId}-${Date.now()}`,
        sessionId: this.sessionId,
        trigger: 'before-restore',
      },
      this.host
    );
    await restoreCheckpoint(root, target, this.host);
    return true;
  }

  /** spawn 后清理过期快照(fire-and-forget;不按会话清,同 repo 多会话并存) */
  cleanupOldSessions(): void {
    void this.resolveRoot().then((root) => {
      if (root) void pruneStaleCheckpoints(root, undefined, this.host).catch(() => {});
    });
  }
}

/** 写盘工具包装:首个 mutating 工具执行前打本轮快照(execute 被 pi await,可安全阻塞) */
export function withCheckpoint(
  definition: ToolDefinition,
  manager: CheckpointManager
): ToolDefinition {
  if (!MUTATING_TOOLS.has(definition.name)) return definition;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await manager.ensureTurnCheckpoint(definition.name);
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

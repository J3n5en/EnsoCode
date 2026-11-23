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
const MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'bash', 'powershell']);
/** 另一个 git 进程占着 index.lock 时，等这么久再试一次 */
const INDEX_LOCK_RETRY_MS = 300;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const isIndexLocked = (error: unknown): boolean => /index\.lock/.test(messageOf(error));

/**
 * per 顶级会话的 checkpoint 管理:每轮首个写盘工具执行前打一次工作树快照,
 * 快照关联本轮 user 消息的 session entry(回退还原按 entry 匹配)。
 * 非 git 项目静默禁用;git 连续失败 3 次即禁用(每次失败留日志),绝不影响工具执行。
 * 预期的中间状态不算失败:未解决冲突跳过本轮,index.lock 被占重试一次,工作目录已删除静默跳过。
 */
export class CheckpointManager {
  /** undefined = 未探测;null = 非 git 项目 */
  private root: string | null | undefined;
  /** 本轮快照(进行中或已落定);同轮其余写盘工具共用,不各自打快照 */
  private turnCheckpoint: Promise<void> | undefined;
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
    this.turnCheckpoint = undefined;
  }

  private async resolveRoot(): Promise<string | null> {
    if (this.root === undefined) {
      this.root = await getRepoRoot(this.cwd, this.host).catch(() => null);
    }
    return this.root;
  }

  /**
   * 每轮至多一次;失败不抛(同轮不重试)。同轮调用都等同一个快照落定:pi 默认并行执行
   * 工具,只置标记就放行的话,后到的写盘会抢在快照的 git status/add 之前落盘
   */
  async ensureTurnCheckpoint(toolName: string): Promise<void> {
    if (this.disabled) return;
    this.turnCheckpoint ??= this.createTurnCheckpoint(toolName);
    await this.turnCheckpoint;
  }

  private async createTurnCheckpoint(toolName: string): Promise<void> {
    let root: string | null = null;
    try {
      root = await this.resolveRoot();
      if (!root) {
        this.disabled = true;
        return;
      }
      const repo = root;
      const snapshot = () => {
        const { entryId, entryTimestamp } = this.getTurnEntry();
        return createCheckpoint(
          {
            root: repo,
            id: `tool-${this.sessionId}-${Date.now()}`,
            sessionId: this.sessionId,
            trigger: 'tool',
            toolName,
            entryId,
            entryTimestamp,
          },
          this.host
        );
      };
      await snapshot().catch(async (error: unknown) => {
        if (!isIndexLocked(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, INDEX_LOCK_RETRY_MS));
        await snapshot();
      });
      void pruneCheckpoints(repo, this.sessionId, undefined, this.host).catch(() => {});
      this.failures = 0;
    } catch (error) {
      const tag = `[checkpoint] ${this.sessionId.slice(0, 8)}`;
      // 合并 / rebase 冲突没解完时 git 写不出树:正常的中间状态,冲突解完下一轮照常快照
      if (/\bunmerged\b/.test(messageOf(error))) {
        console.info(`${tag} snapshot skipped: unresolved merge conflicts`);
        return;
      }
      if (root && (error as { code?: unknown }).code === 'ENOENT' && (await this.rootGone(root))) {
        console.debug(`${tag} snapshot skipped: ${root} no longer exists`);
        return;
      }
      if (++this.failures >= 3) this.disabled = true;
      // 非 git 是预期内不可用(上面已返回);git 仓库里打不出快照是「该有而没有」,
      // 只计数会让回退+文件静默失效,至少留下原因
      console.warn(
        `${tag} snapshot failed (${this.failures}/3${this.disabled ? ', disabled for this session' : ''}):`,
        messageOf(error)
      );
    }
  }

  /** spawn git ENOENT 也可能是没装 git;只有工作目录确实没了(如刚删除的 worktree)才算预期 */
  private async rootGone(root: string): Promise<boolean> {
    const stats = await this.host.statBatch(root, ['.']).catch(() => null);
    return stats?.get('.')?.kind === 'missing';
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

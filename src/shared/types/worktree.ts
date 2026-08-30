/** 会话级 git worktree 隔离的共享类型（main 权威，renderer 只读投影） */

/** 一条会话与其隔离 worktree 的绑定记录（持久化在 main 的 worktrees.json） */
export interface SessionWorktree {
  conversationId: string;
  projectId: string;
  /** 项目主工作树根（project.canonicalPath） */
  repoPath: string;
  /** worktree 目录（托管在 userData 下，项目外） */
  path: string;
  /** 为该会话创建的分支 */
  branch: string;
  /** 创建时主工作树所在分支；detached HEAD 时为 null */
  baseBranch: string | null;
  /** 创建时 HEAD commit（baseBranch 被删后 ahead 计算的兜底基准） */
  baseCommit: string;
  createdAt: number;
}

/** worktree 的轻量状态（侧边栏徽标 / 清理拦截用） */
export interface WorktreeStatus {
  /** 目录仍存在且是有效 worktree */
  exists: boolean;
  /** 有未提交改动（含未跟踪文件） */
  dirty: boolean;
  /** 领先 base 的提交数（>0 即「未合并」） */
  ahead: number;
}

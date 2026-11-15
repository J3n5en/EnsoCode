/**
 * 秘书的收尾清理：cleanup_list 只读列清单，cleanup_apply 走确认卡后才动手。
 *
 * 边界：
 * - 分支：只碰 feat/ fix/ chore/ 前缀、且已经合进 feat/secretary-agent 或 main 的；
 *   基线分支、当前检出的分支、任何 worktree 正在用的分支都不列也不删。
 * - worktree：只碰会话 worktree 根下的，删之前先确认没有未提交改动。
 * - 会话：只归档，不删除。
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { app } from '@platform';
import type { ProjectAuthority } from '@shared/types/agent';
import type {
  CleanupDraft,
  CleanupItem,
  SecretaryAuditEntry,
  SecretaryDispatchFile,
} from '@shared/types/secretary';
import { appendAudit } from './audit';
import { type GitRunner, parseWorktrees, runGit } from './repoStatus';
import { SecretaryStore } from './store';
import type { SecretaryOpHandler, SecretaryOpResult } from './tools';

type MaybePromise<T> = T | Promise<T>;

/** 只有这些前缀的分支算秘书派发留下的 */
export const CLEANUP_BRANCH_PREFIXES = ['feat/', 'fix/', 'chore/'] as const;

/** 合进这两个基线之一才算做完 */
export const CLEANUP_BASE_BRANCHES = ['feat/secretary-agent', 'main'] as const;

/** 会话要空闲超过一天才进清单 */
export const CLEANUP_IDLE_MS = 24 * 60 * 60 * 1000;

/** 一次最多处理这么多条，避免一次确认删掉半个仓库 */
export const CLEANUP_MAX_ITEMS = 100;

const SEP = '|';

export const branchItemId = (repoPath: string, branch: string): string =>
  `branch${SEP}${repoPath}${SEP}${branch}`;
export const worktreeItemId = (target: string): string => `worktree${SEP}${target}`;
export const sessionItemId = (conversationId: string): string => `session${SEP}${conversationId}`;

export interface CleanupPorts {
  git: GitRunner;
  realpath(target: string): Promise<string | null>;
  /** 允许清理的 worktree 根目录（真实路径） */
  worktreeRoots(): string[];
  /** du 估算的目录占用；失败返回 null */
  size(target: string): Promise<number | null>;
  projects(): MaybePromise<readonly ProjectAuthority[]>;
  rows(): MaybePromise<Record<string, Record<string, unknown>>>;
  dispatchFile(): MaybePromise<SecretaryDispatchFile>;
  archive(conversationId: string, at: number): MaybePromise<void>;
  audit(entry: SecretaryAuditEntry): void;
  now(): number;
}

export interface CleanupRepo {
  root: string;
  currentBranch: string | null;
  /** 本地分支里符合前缀的 */
  branches: Array<{ name: string; mergedInto: string[]; lastActivityAt?: number }>;
  /** 该仓库的 worktree（不含检出目录本身） */
  worktrees: Array<{ path: string; branch: string | null }>;
}

async function gitOut(
  ports: CleanupPorts,
  cwd: string,
  args: readonly string[]
): Promise<string | null> {
  const result = await ports.git(cwd, args);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function branchExists(ports: CleanupPorts, root: string, branch: string): Promise<boolean> {
  const result = await ports.git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  return result.code === 0;
}

/** 仓库里真实存在的基线分支；每个仓库只查一次，别按分支重复问 git */
async function existingBases(ports: CleanupPorts, root: string): Promise<string[]> {
  const bases: string[] = [];
  for (const base of CLEANUP_BASE_BRANCHES)
    if (await branchExists(ports, root, base)) bases.push(base);
  return bases;
}

/** 分支是不是已经合进某个基线：merge-base --is-ancestor 的退出码就是答案 */
async function mergedInto(
  ports: CleanupPorts,
  root: string,
  branch: string,
  bases?: readonly string[]
): Promise<string[]> {
  const candidates = bases ?? (await existingBases(ports, root));
  const merged: string[] = [];
  for (const base of candidates) {
    if (base === branch) continue;
    const result = await ports.git(root, ['merge-base', '--is-ancestor', branch, base]);
    if (result.code === 0) merged.push(base);
  }
  return merged;
}

async function lastCommitAt(
  ports: CleanupPorts,
  cwd: string,
  ref: string
): Promise<number | undefined> {
  const raw = await gitOut(ports, cwd, ['log', '-1', '--format=%at', ref]);
  const seconds = Number(raw);
  return raw && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** 一个仓库的只读事实：当前分支、符合前缀的本地分支、worktree 清单 */
export async function readCleanupRepo(
  ports: CleanupPorts,
  root: string
): Promise<CleanupRepo | null> {
  const top = await gitOut(ports, root, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const currentRaw = await gitOut(ports, top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = currentRaw && currentRaw !== 'HEAD' ? currentRaw : null;
  const listed = await gitOut(ports, top, ['branch', '--format=%(refname:short)']);
  const bases = await existingBases(ports, top);
  const branches: CleanupRepo['branches'] = [];
  for (const name of (listed ?? '').split('\n').map((line) => line.trim())) {
    if (!name) continue;
    if (!CLEANUP_BRANCH_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    // 基线自己带 feat/ 前缀，永远不进清单
    if ((CLEANUP_BASE_BRANCHES as readonly string[]).includes(name)) continue;
    const merged = await mergedInto(ports, top, name, bases);
    const lastActivityAt = await lastCommitAt(ports, top, name);
    branches.push({ name, mergedInto: merged, ...(lastActivityAt ? { lastActivityAt } : {}) });
  }
  const worktreeRaw = await gitOut(ports, top, ['worktree', 'list', '--porcelain']);
  const worktrees = (worktreeRaw ? parseWorktrees(worktreeRaw) : [])
    .filter((worktree) => worktree.path !== top)
    .map((worktree) => ({ path: worktree.path, branch: worktree.branch }));
  return { root: top, currentBranch, branches, worktrees };
}

function isUnderRoot(target: string, root: string): boolean {
  const normalized = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(normalized);
}

/**
 * 收集清单。每一项都自带判定结果：没合入的、当前分支、被 worktree 占用的都带
 * blocked 原因，cleanup_apply 见到 blocked 直接拒绝，不会走到删除。
 */
export async function collectCleanupItems(ports: CleanupPorts): Promise<CleanupItem[]> {
  const now = ports.now();
  const projects = (await ports.projects()).filter(
    (project) => project.state === 'active' && (project.kind ?? 'local') === 'local'
  );
  const roots = ports.worktreeRoots();
  const items: CleanupItem[] = [];
  for (const project of projects) {
    const repo = await readCleanupRepo(ports, project.canonicalPath);
    if (!repo) continue;
    const inUse = new Set(
      repo.worktrees
        .map((worktree) => worktree.branch)
        .filter((branch): branch is string => !!branch)
    );
    for (const branch of repo.branches) {
      const blocked =
        branch.mergedInto.length === 0
          ? 'not-merged'
          : branch.name === repo.currentBranch
            ? 'current-branch'
            : inUse.has(branch.name)
              ? 'used-by-worktree'
              : undefined;
      items.push({
        id: branchItemId(repo.root, branch.name),
        kind: 'branch',
        name: branch.name,
        projectId: project.projectId,
        repoPath: repo.root,
        mergedInto: branch.mergedInto,
        ...(branch.lastActivityAt ? { lastActivityAt: branch.lastActivityAt } : {}),
        ...(blocked ? { blocked } : {}),
      });
    }
    const mergedByBranch = new Map(
      repo.branches.map((branch) => [branch.name, branch.mergedInto] as const)
    );
    for (const worktree of repo.worktrees) {
      const resolved = (await ports.realpath(worktree.path)) ?? worktree.path;
      // 只碰会话 worktree 根下的目录，别的地方是用户自己的检出
      if (!roots.some((root) => isUnderRoot(resolved, root))) continue;
      // 分支表里已经算过就直接用，省掉每个 worktree 再问一遍 git
      const merged = worktree.branch
        ? (mergedByBranch.get(worktree.branch) ??
          (await mergedInto(ports, repo.root, worktree.branch)))
        : [];
      const blocked = !worktree.branch
        ? 'detached-head'
        : merged.length === 0
          ? 'not-merged'
          : undefined;
      const size = await ports.size(resolved);
      const lastActivityAt = worktree.branch
        ? await lastCommitAt(ports, repo.root, worktree.branch)
        : undefined;
      items.push({
        id: worktreeItemId(resolved),
        kind: 'worktree',
        name: worktree.branch ?? resolved,
        projectId: project.projectId,
        repoPath: repo.root,
        path: resolved,
        ...(merged.length > 0 ? { mergedInto: merged } : {}),
        ...(lastActivityAt ? { lastActivityAt } : {}),
        ...(size !== null ? { sizeBytes: size } : {}),
        ...(blocked ? { blocked } : {}),
      });
    }
  }
  items.push(...(await collectCleanupSessions(ports, projects, now)));
  return items;
}

/** 派发出去的会话：目标已完成、已经空闲超过一天，才进清单 */
async function collectCleanupSessions(
  ports: CleanupPorts,
  projects: readonly ProjectAuthority[],
  now: number
): Promise<CleanupItem[]> {
  const visible = new Set(projects.map((project) => project.projectId));
  const file = await ports.dispatchFile();
  const rows = await ports.rows();
  const items: CleanupItem[] = [];
  for (const record of Object.values(file.dispatched)) {
    if (!visible.has(record.projectId)) continue;
    const row = rows[record.conversationId];
    if (!row || row.archived === true) continue;
    // 还有后台任务（含常驻服务）的会话先不收：等遗留处理完再归档
    if (record.lastState !== 'idle' || record.backgroundRunning || record.leftoverTasks) continue;
    if (record.lastResult?.kind !== 'goal-complete') continue;
    const at = record.lastResult.at;
    if (!Number.isFinite(at) || now - at < CLEANUP_IDLE_MS) continue;
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : '';
    items.push({
      id: sessionItemId(record.conversationId),
      kind: 'session',
      name: title || record.conversationId,
      projectId: record.projectId,
      lastActivityAt: at,
    });
  }
  return items;
}

export type CleanupSelectionResult =
  | { ok: true; items: CleanupItem[] }
  | { ok: false; error: string };

/**
 * 把 id 列表收窄回真实条目：未知 id、带 blocked 的、基线分支一律拒绝并说明。
 * 确认卡与执行都用同一份判定，卡片上看到的就是会发生的。
 */
export async function selectCleanupItems(
  ports: CleanupPorts,
  ids: readonly string[]
): Promise<CleanupSelectionResult> {
  if (ids.length === 0) return { ok: false, error: 'ids is empty: pass the ids from cleanup_list' };
  if (ids.length > CLEANUP_MAX_ITEMS)
    return { ok: false, error: `too many ids: ${ids.length}, the limit is ${CLEANUP_MAX_ITEMS}` };
  const all = await collectCleanupItems(ports);
  const byId = new Map(all.map((item) => [item.id, item]));
  const selected: CleanupItem[] = [];
  const unknown: string[] = [];
  const refused: string[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) {
      unknown.push(id);
      continue;
    }
    if (item.blocked) {
      refused.push(`${item.name}: ${item.blocked}`);
      continue;
    }
    if (selected.some((entry) => entry.id === item.id)) continue;
    selected.push(item);
  }
  if (unknown.length > 0) return { ok: false, error: `unknown cleanup id: ${unknown.join(', ')}` };
  if (refused.length > 0)
    return {
      ok: false,
      error: `refused, nothing was deleted: ${refused.join('; ')}. A branch is only deleted when it is merged into ${CLEANUP_BASE_BRANCHES.join(' or ')}, is not the current branch, and no worktree uses it.`,
    };
  if (selected.length === 0) return { ok: false, error: 'nothing to clean up' };
  return { ok: true, items: selected };
}

export interface CleanupActionReport {
  id: string;
  kind: CleanupItem['kind'];
  name: string;
  action: 'deleted' | 'archived' | 'skipped';
  reason?: string;
}

export interface CleanupApplyResult {
  report: CleanupActionReport[];
  deleted: number;
  archived: number;
  skipped: number;
}

/** 未提交改动：worktree 里哪怕只有一个未跟踪文件也不删 */
async function worktreeIsClean(ports: CleanupPorts, target: string): Promise<boolean> {
  const result = await ports.git(target, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (result.code !== 0) return false;
  return result.stdout.trim() === '';
}

/**
 * 真正执行清理。顺序固定：先删 worktree（释放分支），再删分支，最后归档会话。
 * 每一步都重新判定一次：清单是快照，执行时的事实才算数。
 */
export async function applyCleanup(
  ports: CleanupPorts,
  draft: CleanupDraft,
  /** 谁点的确认：审计要能追到那条秘书会话 */
  secretaryConversationId: string | null = null
): Promise<CleanupApplyResult> {
  const report: CleanupActionReport[] = [];
  const now = ports.now();
  const record = (entry: CleanupActionReport) => {
    report.push(entry);
    ports.audit({
      at: now,
      secretaryConversationId,
      op: `cleanup_${entry.kind}`,
      targetId: entry.id,
      ok: entry.action !== 'skipped',
      detail: entry.reason ?? entry.action,
    });
  };
  const worktrees = draft.items.filter((item) => item.kind === 'worktree');
  const branches = draft.items.filter((item) => item.kind === 'branch');
  const sessions = draft.items.filter((item) => item.kind === 'session');

  for (const item of worktrees) {
    const target = item.path ?? '';
    const repoPath = item.repoPath ?? '';
    if (!target || !repoPath) {
      record({
        id: item.id,
        kind: 'worktree',
        name: item.name,
        action: 'skipped',
        reason: 'invalid-item',
      });
      continue;
    }
    if (!(await worktreeIsClean(ports, target))) {
      record({
        id: item.id,
        kind: 'worktree',
        name: item.name,
        action: 'skipped',
        reason: 'uncommitted-changes',
      });
      continue;
    }
    const removed = await ports.git(repoPath, ['worktree', 'remove', '--force', target]);
    if (removed.code !== 0) {
      record({
        id: item.id,
        kind: 'worktree',
        name: item.name,
        action: 'skipped',
        reason: 'remove-failed',
      });
      continue;
    }
    await ports.git(repoPath, ['worktree', 'prune']);
    record({ id: item.id, kind: 'worktree', name: item.name, action: 'deleted' });
  }

  // 同一个仓库只读一次：删完一条分支后 worktree 占用与当前分支都可能变，所以每条都重读
  const repoCache = new Map<string, CleanupRepo | null>();
  const repoOf = async (repoPath: string): Promise<CleanupRepo | null> => {
    const cached = repoCache.get(repoPath);
    if (cached !== undefined) return cached;
    const repo = await readCleanupRepo(ports, repoPath);
    repoCache.set(repoPath, repo);
    return repo;
  };
  for (const item of branches) {
    const repoPath = item.repoPath ?? '';
    if (!repoPath) {
      record({
        id: item.id,
        kind: 'branch',
        name: item.name,
        action: 'skipped',
        reason: 'invalid-item',
      });
      continue;
    }
    const repo = await repoOf(repoPath);
    if (!repo) {
      record({
        id: item.id,
        kind: 'branch',
        name: item.name,
        action: 'skipped',
        reason: 'not-a-repo',
      });
      continue;
    }
    const inUse = new Set(
      repo.worktrees
        .map((worktree) => worktree.branch)
        .filter((branch): branch is string => !!branch)
    );
    const merged = await mergedInto(ports, repo.root, item.name);
    const reason = (CLEANUP_BASE_BRANCHES as readonly string[]).includes(item.name)
      ? 'base-branch'
      : item.name === repo.currentBranch
        ? 'current-branch'
        : inUse.has(item.name)
          ? 'used-by-worktree'
          : merged.length === 0
            ? 'not-merged'
            : undefined;
    if (reason) {
      record({ id: item.id, kind: 'branch', name: item.name, action: 'skipped', reason });
      continue;
    }
    const deleted = await ports.git(repo.root, ['branch', '-D', item.name]);
    // 删掉一条分支后缓存失效，下一条重新读
    repoCache.delete(repoPath);
    record({
      id: item.id,
      kind: 'branch',
      name: item.name,
      action: deleted.code === 0 ? 'deleted' : 'skipped',
      ...(deleted.code === 0 ? {} : { reason: 'delete-failed' }),
    });
  }

  for (const item of sessions) {
    const conversationId = item.id.slice(`session${SEP}`.length);
    const rows = await ports.rows();
    const row = rows[conversationId];
    if (!row) {
      record({ id: item.id, kind: 'session', name: item.name, action: 'skipped', reason: 'gone' });
      continue;
    }
    if (row.archived === true) {
      record({
        id: item.id,
        kind: 'session',
        name: item.name,
        action: 'skipped',
        reason: 'archived',
      });
      continue;
    }
    // 只归档，不删除：会话正文与 jsonl 都留着
    await ports.archive(conversationId, now);
    record({ id: item.id, kind: 'session', name: item.name, action: 'archived' });
  }

  return {
    report,
    deleted: report.filter((entry) => entry.action === 'deleted').length,
    archived: report.filter((entry) => entry.action === 'archived').length,
    skipped: report.filter((entry) => entry.action === 'skipped').length,
  };
}

/** 给秘书与卡片看的一句话结果 */
export function cleanupReportText(result: CleanupApplyResult): string {
  const parts = [`deleted ${result.deleted}`];
  if (result.archived > 0) parts.push(`archived ${result.archived}`);
  if (result.skipped > 0) {
    const skipped = result.report
      .filter((entry) => entry.action === 'skipped')
      .map((entry) => `${entry.name} (${entry.reason ?? 'skipped'})`);
    parts.push(`skipped ${result.skipped}: ${skipped.join(', ')}`);
  }
  return parts.join('; ');
}

export interface CleanupHandlerPorts extends CleanupPorts {
  /** 落一条待确认的清理提案，返回提案 id */
  saveProposal(items: CleanupItem[], secretaryConversationId: string | null): Promise<string>;
}

function parseIds(value: unknown): string[] {
  // 单个字符串也当一条：worker 侧归一化会包成数组，这里再兜一层
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function createSecretaryCleanupHandlers(ports: CleanupHandlerPorts): {
  cleanup_list: SecretaryOpHandler;
  cleanup_apply: SecretaryOpHandler;
} {
  return {
    async cleanup_list(params, ctx): Promise<SecretaryOpResult> {
      const projectId = typeof params.projectId === 'string' ? params.projectId.trim() : '';
      const items = (await collectCleanupItems(ports)).filter(
        (item) => !projectId || item.projectId === projectId
      );
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'cleanup_list',
        ok: true,
        detail: `${items.length} items`,
      });
      return { ok: true, result: { items } };
    },

    async cleanup_apply(params, ctx): Promise<SecretaryOpResult> {
      const ids = parseIds(params.ids);
      const selection = await selectCleanupItems(ports, ids);
      if (!selection.ok) {
        ports.audit({
          at: ports.now(),
          secretaryConversationId: ctx.secretaryConversationId,
          op: 'cleanup_apply',
          ok: false,
          detail: selection.error.slice(0, 200),
        });
        return { ok: false, error: selection.error };
      }
      const proposalId = await ports.saveProposal(selection.items, ctx.secretaryConversationId);
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'cleanup_apply',
        targetId: proposalId,
        ok: true,
        detail: 'awaiting_confirmation',
      });
      return {
        ok: true,
        result: {
          status: 'awaiting_confirmation',
          proposalId,
          items: selection.items.map((item) => ({ id: item.id, kind: item.kind, name: item.name })),
        },
      };
    },
  };
}

export const runDu = (target: string): Promise<number | null> =>
  new Promise((resolve) => {
    execFile(
      'du',
      ['-sk', target],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const kilobytes = Number(stdout.trim().split(/\s+/u)[0]);
        resolve(Number.isFinite(kilobytes) && kilobytes >= 0 ? kilobytes * 1024 : null);
      }
    );
  });

/** 会话 worktree 根：与 image_view 同一处，加上应用自己托管的 worktree 目录 */
export function defaultCleanupWorktreeRoots(managedRoot?: string, home = homedir()): string[] {
  return [path.join(home, 'project', 'worktree'), ...(managedRoot ? [managedRoot] : [])];
}

function secretaryDir(): string {
  return path.join(app.getPath('userData'), 'secretary');
}

/**
 * 生产端口：与派发模块一样用动态 import 取 Main 的既有函数，
 * 避免 cleanup → dispatch → cleanup 的静态环。
 */
export function realCleanupPorts(): CleanupPorts {
  return {
    git: runGit,
    realpath: async (target) => {
      try {
        return await realpath(target);
      } catch {
        return null;
      }
    },
    // 根目录也解析真实路径：worktree 路径是 realpath 过的，两边口径必须一致
    worktreeRoots: () =>
      defaultCleanupWorktreeRoots(path.join(app.getPath('userData'), 'worktrees')).map((root) => {
        try {
          return realpathSync(root);
        } catch {
          return root;
        }
      }),
    size: runDu,
    projects: async () =>
      (await import('../../ipc/agent')).getSourceAuthorityRegistry()?.projection().projects ?? [],
    rows: async () => (await import('../../ipc/settings')).readPersistedConversations(),
    dispatchFile: () => new SecretaryStore(secretaryDir()).dispatch(),
    archive: async (conversationId, at) => {
      const { patchConversationsState } = await import('../../ipc/settings');
      patchConversationsState((state) => {
        const row = state.conversations[conversationId];
        if (!row) return;
        state.conversations[conversationId] = { ...row, archived: true, archivedAt: at };
      });
    },
    audit: (entry) => appendAudit(secretaryDir(), entry),
    now: () => Date.now(),
  };
}

export const secretaryCleanupHandlers = createSecretaryCleanupHandlers({
  ...realCleanupPorts(),
  // 提案落盘在派发模块里：这里动态取，避免 cleanup ↔ dispatch 的静态环
  saveProposal: async (items, secretaryConversationId) => {
    const { saveCleanupProposal } = await import('./dispatch');
    return saveCleanupProposal(items, secretaryConversationId);
  },
});

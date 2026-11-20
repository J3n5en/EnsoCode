/**
 * 秘书的收尾清理：cleanup_list 只读列清单，cleanup_apply 走确认卡后才动手。
 *
 * 边界：
 * - 分支：只碰 feat/ fix/ chore/ 前缀、且已经合进 feat/secretary-agent 或 main 的
 *   （祖先关系，或 GitHub 上已合并 PR 的 head 正是分支 tip，即 squash 合并）；
 *   基线分支、当前检出的分支、任何 worktree 正在用的分支都不列也不删。
 * - worktree：只碰会话 worktree 根下的，删之前先确认没有未提交改动。
 * - 会话：只归档，不删除。
 *
 * 性能：一个仓库只跑固定几条 git（for-each-ref 批量判合入），du 放后台带缓存，
 * 整体有期限，到点先返回已读完的部分；秘书工具调用的通用超时是 15 秒。
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
  CleanupItemKind,
  CleanupListDetail,
  CleanupListSummary,
  CleanupSummaryItem,
  SecretaryAuditEntry,
  SecretaryDispatchFile,
} from '@shared/types/secretary';
import { CLEANUP_ITEM_KINDS } from '@shared/types/secretary';
import { appendAudit } from './audit';
import type { SavedProposal } from './proposals';
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

/** 精简模式每类给几条：够秘书点单，又不至于把正文撑爆 */
export const CLEANUP_SUMMARY_PER_KIND = 5;
/** 精简模式正文上限（JSON 字符数）：秘书没有 read/grep，超了就是读不到的回执 */
export const CLEANUP_SUMMARY_MAX_CHARS = 2000;
/** detail 模式每页条数与正文上限 */
export const CLEANUP_DETAIL_PAGE_SIZE = 20;
export const CLEANUP_DETAIL_MAX_CHARS = 4000;
/** 名字上限：一条超长标题不能吃掉整页预算 */
export const CLEANUP_NAME_MAX = 60;

/** 扫描整体期限：要明显短于秘书工具调用的 15 秒通用超时 */
export const CLEANUP_SCAN_DEADLINE_MS = 10_000;
/** cleanup_list 最多等 du 这么久，没算完的在后台继续、下次再列 */
export const CLEANUP_SIZE_BUDGET_MS = 1_500;
/** 同时跑的仓库读取与 du 数 */
export const CLEANUP_CONCURRENCY = 4;
/** 扫描结果复用多久：cleanup_apply 紧跟 cleanup_list 时不再重扫 */
export const CLEANUP_SCAN_TTL_MS = 60_000;

const SEP = '|';
const HEADS = 'refs/heads/';

export const branchItemId = (repoPath: string, branch: string): string =>
  `branch${SEP}${repoPath}${SEP}${branch}`;
export const worktreeItemId = (target: string): string => `worktree${SEP}${target}`;
export const sessionItemId = (conversationId: string): string => `session${SEP}${conversationId}`;

/** GitHub 上已合并的一条 PR：head 提交号与合入的基线 */
export interface MergedPull {
  headRefOid: string;
  baseRefName: string;
}

export interface CleanupPorts {
  git: GitRunner;
  realpath(target: string): Promise<string | null>;
  /** 允许清理的 worktree 根目录（真实路径） */
  worktreeRoots(): string[];
  /** du 估算的目录占用；失败返回 null */
  size(target: string): Promise<number | null>;
  /** 仓库在 GitHub 上已合并的 PR，squash 合并靠它认；gh 不可用返回 null */
  mergedPulls(repoRoot: string): Promise<readonly MergedPull[] | null>;
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
  /** 所有本地分支（不限前缀）的合入基线与最后提交时间，worktree 的分支也从这里查 */
  merged: Map<string, string[]>;
  lastActivity: Map<string, number>;
  /** gh 不可用：squash 合并的分支这次认不出来 */
  pullsUnknown: boolean;
}

async function gitOut(
  ports: CleanupPorts,
  cwd: string,
  args: readonly string[]
): Promise<string | null> {
  const result = await ports.git(cwd, args);
  return result.code === 0 ? result.stdout.trim() : null;
}

const headName = (ref: string): string | null =>
  ref.startsWith(HEADS) ? ref.slice(HEADS.length) : null;

/**
 * 一个仓库的只读事实：当前分支、符合前缀的本地分支、worktree 清单。
 * 条数固定：一次 for-each-ref 拿全部分支 tip 与时间，每个基线一次 --merged，
 * 不按分支逐条问 git。
 */
export async function readCleanupRepo(
  ports: CleanupPorts,
  root: string
): Promise<CleanupRepo | null> {
  const top = await gitOut(ports, root, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const [currentRaw, refsRaw, worktreeRaw, pulls, ...mergedRaw] = await Promise.all([
    gitOut(ports, top, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOut(ports, top, [
      'for-each-ref',
      '--format=%(refname) %(objectname) %(committerdate:unix)',
      HEADS,
    ]),
    gitOut(ports, top, ['worktree', 'list', '--porcelain']),
    ports.mergedPulls(top).catch(() => null),
    // 基线不存在时 git 报错，gitOut 给 null，等于没有这个基线
    ...CLEANUP_BASE_BRANCHES.map((base) =>
      gitOut(ports, top, ['for-each-ref', '--format=%(refname)', `--merged=${HEADS}${base}`, HEADS])
    ),
  ]);
  const currentBranch = currentRaw && currentRaw !== 'HEAD' ? currentRaw : null;
  const tips = new Map<string, string>();
  const lastActivity = new Map<string, number>();
  // refname 不能含空格，按空格切是安全的
  for (const line of (refsRaw ?? '').split('\n')) {
    const [ref = '', oid = '', at = ''] = line.trim().split(' ');
    const name = headName(ref);
    if (!name || !oid) continue;
    tips.set(name, oid);
    const seconds = Number(at);
    if (Number.isFinite(seconds) && seconds > 0) lastActivity.set(name, seconds * 1000);
  }
  const ancestry = new Map<string, Set<string>>();
  CLEANUP_BASE_BRANCHES.forEach((base, index) => {
    const raw = mergedRaw[index];
    if (!tips.has(base) || raw === null || raw === undefined) return;
    ancestry.set(base, new Set(raw.split('\n').map((line) => headName(line.trim()) ?? '')));
  });
  // squash 合并：PR 合进基线时的 head 就是分支现在的 tip，分支内容已经全在基线里；
  // 合并后又提交过的 tip 对不上，照旧算没合入
  const squashed = new Map<string, Set<string>>();
  for (const pull of pulls ?? []) {
    if (!ancestry.has(pull.baseRefName)) continue;
    const bases = squashed.get(pull.headRefOid) ?? new Set<string>();
    bases.add(pull.baseRefName);
    squashed.set(pull.headRefOid, bases);
  }
  const merged = new Map<string, string[]>();
  for (const [name, oid] of tips)
    merged.set(
      name,
      [...ancestry.keys()].filter(
        (base) => base !== name && (ancestry.get(base)?.has(name) || squashed.get(oid)?.has(base))
      )
    );
  const branches: CleanupRepo['branches'] = [];
  for (const name of tips.keys()) {
    if (!CLEANUP_BRANCH_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    // 基线自己带 feat/ 前缀，永远不进清单
    if ((CLEANUP_BASE_BRANCHES as readonly string[]).includes(name)) continue;
    const lastActivityAt = lastActivity.get(name);
    branches.push({
      name,
      mergedInto: merged.get(name) ?? [],
      ...(lastActivityAt ? { lastActivityAt } : {}),
    });
  }
  const worktrees = (worktreeRaw ? parseWorktrees(worktreeRaw) : [])
    .filter((worktree) => worktree.path !== top)
    .map((worktree) => ({ path: worktree.path, branch: worktree.branch }));
  return {
    root: top,
    currentBranch,
    branches,
    worktrees,
    merged,
    lastActivity,
    pullsUnknown: pulls === null,
  };
}

function isUnderRoot(target: string, root: string): boolean {
  const normalized = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(normalized);
}

/** 限并发地跑一批任务；stop() 为真后不再启动新任务，没启动的留 undefined */
async function mapLimit<T, R>(
  inputs: readonly T[],
  limit: number,
  run: (input: T) => Promise<R>,
  stop: () => boolean = () => false
): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = new Array(inputs.length).fill(undefined);
  let next = 0;
  const lane = async () => {
    while (next < inputs.length && !stop()) {
      const index = next;
      next += 1;
      out[index] = await run(inputs[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, lane));
  return out;
}

interface Timer {
  promise: Promise<void>;
  fired(): boolean;
  clear(): void;
}

function timer(ms: number): Timer {
  let done = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(() => {
      done = true;
      resolve();
    }, ms);
  });
  return { promise, fired: () => done, clear: () => clearTimeout(handle) };
}

export interface CleanupScanOptions {
  /** 整体期限：到点还没读完的仓库记进 incomplete，先返回已有的 */
  deadlineMs?: number;
  /** 最多等 du 这么久；false 表示这次不算占用 */
  sizeBudgetMs?: number | false;
}

export interface CleanupScan {
  items: CleanupItem[];
  /** 到期限没读完的仓库 */
  incomplete: string[];
  /** 这次没拿到占用的可清理 worktree 数 */
  sizesPending: number;
  warnings: string[];
}

function repoItems(
  project: ProjectAuthority,
  repo: CleanupRepo,
  resolvedPaths: readonly (string | null)[],
  roots: readonly string[]
): CleanupItem[] {
  const items: CleanupItem[] = [];
  const inUse = new Set(
    repo.worktrees.map((worktree) => worktree.branch).filter((branch): branch is string => !!branch)
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
  repo.worktrees.forEach((worktree, index) => {
    const resolved = resolvedPaths[index] ?? worktree.path;
    // 只碰会话 worktree 根下的目录，别的地方是用户自己的检出
    if (!roots.some((root) => isUnderRoot(resolved, root))) return;
    const merged = worktree.branch ? (repo.merged.get(worktree.branch) ?? []) : [];
    const blocked = !worktree.branch
      ? 'detached-head'
      : merged.length === 0
        ? 'not-merged'
        : undefined;
    const lastActivityAt = worktree.branch ? repo.lastActivity.get(worktree.branch) : undefined;
    items.push({
      id: worktreeItemId(resolved),
      kind: 'worktree',
      name: worktree.branch ?? resolved,
      projectId: project.projectId,
      repoPath: repo.root,
      path: resolved,
      ...(merged.length > 0 ? { mergedInto: merged } : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      ...(blocked ? { blocked } : {}),
    });
  });
  return items;
}

/**
 * 扫描清单。每一项都自带判定结果：没合入的、当前分支、被 worktree 占用的都带
 * blocked 原因，cleanup_apply 见到 blocked 直接拒绝，不会走到删除。
 * 仓库并行读、到期限就收；du 只给可清理的 worktree 算，等不完的留在后台。
 */
export async function scanCleanup(
  ports: CleanupPorts,
  options: CleanupScanOptions = {}
): Promise<CleanupScan> {
  const now = ports.now();
  const projects = (await ports.projects()).filter(
    (project) => project.state === 'active' && (project.kind ?? 'local') === 'local'
  );
  const roots = ports.worktreeRoots();
  const deadline = timer(options.deadlineMs ?? CLEANUP_SCAN_DEADLINE_MS);
  const items: CleanupItem[] = [];
  const incomplete: string[] = [];
  const warnings: string[] = [];
  try {
    const readProject = async (project: ProjectAuthority) => {
      const repo = await readCleanupRepo(ports, project.canonicalPath);
      if (!repo) return null;
      const resolved = await Promise.all(
        repo.worktrees.map((worktree) => ports.realpath(worktree.path))
      );
      return { repo, items: repoItems(project, repo, resolved, roots) };
    };
    const read = await mapLimit(
      projects,
      CLEANUP_CONCURRENCY,
      (project) => Promise.race([readProject(project), deadline.promise.then(() => undefined)]),
      deadline.fired
    );
    read.forEach((entry, index) => {
      if (entry === undefined) {
        incomplete.push(projects[index]?.canonicalPath ?? '');
        return;
      }
      if (!entry) return;
      items.push(...entry.items);
      if (entry.repo.pullsUnknown)
        warnings.push(
          `GitHub merged PRs unavailable for ${entry.repo.root}: squash-merged branches show as not-merged`
        );
    });
  } finally {
    deadline.clear();
  }
  if (incomplete.length > 0)
    warnings.push(
      'Scan hit its time limit: repos in incomplete were skipped this time. Call cleanup_list again in a moment.'
    );
  const sizeTargets = items.filter((item) => item.kind === 'worktree' && !item.blocked);
  let measured = 0;
  if (options.sizeBudgetMs !== false && sizeTargets.length > 0) {
    const budget = timer(options.sizeBudgetMs ?? CLEANUP_SIZE_BUDGET_MS);
    // 不等的 du 继续在后台跑，生产端口按路径缓存，下次列清单就有
    const sized = mapLimit(sizeTargets, CLEANUP_CONCURRENCY, async (item) => {
      const size = await ports.size(item.path ?? '');
      if (budget.fired()) return;
      measured += 1;
      if (size !== null) item.sizeBytes = size;
    });
    await Promise.race([sized, budget.promise]);
    budget.clear();
  }
  const sizesPending = sizeTargets.length - measured;
  items.push(...(await collectCleanupSessions(ports, projects, now)));
  return { items, incomplete, sizesPending, warnings };
}

export async function collectCleanupItems(
  ports: CleanupPorts,
  options?: CleanupScanOptions
): Promise<CleanupItem[]> {
  return (await scanCleanup(ports, options)).items;
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

function clipName(name: string): string {
  return name.length > CLEANUP_NAME_MAX ? `${name.slice(0, CLEANUP_NAME_MAX - 1)}…` : name;
}

/** 扫描不完整、占用没算完、gh 不可用这些事实要原样告诉秘书 */
export interface CleanupScanNotes {
  incomplete?: string[];
  sizesPending?: number;
  warnings?: string[];
}

export function cleanupScanNotes(scan: CleanupScan): CleanupScanNotes {
  return {
    ...(scan.incomplete.length > 0 ? { incomplete: scan.incomplete } : {}),
    ...(scan.sizesPending > 0 ? { sizesPending: scan.sizesPending } : {}),
    ...(scan.warnings.length > 0 ? { warnings: scan.warnings } : {}),
  };
}

/**
 * 精简模式：数量摘要 + 每类前几条（只有 id、名字、大小）。
 * 可清理的排在前面，否则前几条全是 blocked，秘书看到的清单一条也用不上。
 */
export function summarizeCleanupItems(
  items: readonly CleanupItem[],
  notes: CleanupScanNotes = {}
): CleanupListSummary {
  const counts: Record<CleanupItemKind, number> = { branch: 0, worktree: 0, session: 0 };
  let cleanable = 0;
  let estimatedBytes = 0;
  for (const item of items) {
    counts[item.kind] += 1;
    if (item.blocked) continue;
    cleanable += 1;
    if (item.sizeBytes) estimatedBytes += item.sizeBytes;
  }
  const ordered = [...items].sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked));
  const picked: CleanupSummaryItem[] = [];
  for (const kind of CLEANUP_ITEM_KINDS) {
    let taken = 0;
    for (const item of ordered) {
      if (taken >= CLEANUP_SUMMARY_PER_KIND) break;
      if (item.kind !== kind) continue;
      taken += 1;
      picked.push({
        id: item.id,
        kind: item.kind,
        name: clipName(item.name),
        ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
        ...(item.blocked ? { blocked: item.blocked } : {}),
      });
    }
  }
  const summary: CleanupListSummary = {
    mode: 'summary',
    total: items.length,
    counts,
    cleanable,
    estimatedBytes,
    items: picked,
    hint: `Compact view: counts plus the first ${CLEANUP_SUMMARY_PER_KIND} per kind, names only. Pass these ids straight to cleanup_apply; ids with a blocked code are refused. For the full list pass detail: true (${CLEANUP_DETAIL_PAGE_SIZE} per page, add page to turn pages) and kind to filter by branch, worktree or session.`,
    ...notes,
  };
  // 名字已经截断；还超预算就从尾部丢条目：宁可少列几条，也不能让秘书只拿到一份回执
  while (JSON.stringify(summary).length > CLEANUP_SUMMARY_MAX_CHARS && summary.items.length > 0)
    summary.items.pop();
  return summary;
}

function detailPage(
  items: readonly CleanupItem[],
  page: number,
  pageSize: number,
  notes: CleanupScanNotes
): CleanupListDetail {
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    mode: 'detail',
    total: items.length,
    page,
    pageSize,
    hasMore: start + slice.length < items.length,
    items: slice.map((item) => ({ ...item, name: clipName(item.name) })),
    ...notes,
  };
}

/**
 * detail 模式的一页。每页条数按整份清单的最坏一页定：按页临时缩会
 * 让第 2 页比第 1 页多，翻页就会漏条目。
 */
export function cleanupDetailPage(
  items: readonly CleanupItem[],
  page: number,
  notes: CleanupScanNotes = {}
): CleanupListDetail {
  const pages = (size: number) => Math.max(1, Math.ceil(items.length / size));
  const fits = (size: number): boolean => {
    for (let index = 1; index <= pages(size); index += 1)
      if (JSON.stringify(detailPage(items, index, size, notes)).length > CLEANUP_DETAIL_MAX_CHARS)
        return false;
    return true;
  };
  let pageSize = Math.min(CLEANUP_DETAIL_PAGE_SIZE, Math.max(1, items.length));
  while (pageSize > 1 && !fits(pageSize)) pageSize -= 1;
  return detailPage(items, page, pageSize, notes);
}

function positiveInt(value: unknown): number | undefined {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 把 id 列表收窄回真实条目：未知 id、带 blocked 的、基线分支一律拒绝并说明。
 * 确认卡与执行都用同一份判定，卡片上看到的就是会发生的。
 * scan 是刚列过的清单快照；执行时 applyCleanup 还会按事实重新校验。
 */
export async function selectCleanupItems(
  ports: CleanupPorts,
  ids: readonly string[],
  scan?: CleanupScan
): Promise<CleanupSelectionResult> {
  if (ids.length === 0)
    return {
      ok: false,
      error:
        'ids is empty: pass the ids from cleanup_list, or all: true to clean everything cleanable',
    };
  if (ids.length > CLEANUP_MAX_ITEMS)
    return { ok: false, error: `too many ids: ${ids.length}, the limit is ${CLEANUP_MAX_ITEMS}` };
  const current = scan ?? (await scanCleanup(ports, { sizeBudgetMs: false }));
  const byId = new Map(current.items.map((item) => [item.id, item]));
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
  if (unknown.length > 0)
    return {
      ok: false,
      error: `unknown cleanup id: ${unknown.join(', ')}${
        current.incomplete.length > 0
          ? `. The scan did not finish for ${current.incomplete.join(', ')}; try again in a moment.`
          : ''
      }`,
    };
  if (refused.length > 0)
    return {
      ok: false,
      error: `refused, nothing was deleted: ${refused.join('; ')}. A branch is only deleted when it is merged into ${CLEANUP_BASE_BRANCHES.join(' or ')}, is not the current branch, and no worktree uses it.`,
    };
  if (selected.length === 0) return { ok: false, error: 'nothing to clean up' };
  return { ok: true, items: selected };
}

/** all: true 的选择：当前所有可清理项，仍然受 CLEANUP_MAX_ITEMS 约束 */
export async function selectAllCleanupItems(
  ports: CleanupPorts,
  projectId = '',
  scan?: CleanupScan
): Promise<CleanupSelectionResult> {
  const current = scan ?? (await scanCleanup(ports, { sizeBudgetMs: false }));
  const items = current.items.filter(
    (item) => !item.blocked && (!projectId || item.projectId === projectId)
  );
  if (items.length === 0) return { ok: false, error: 'nothing to clean up' };
  if (items.length > CLEANUP_MAX_ITEMS)
    return {
      ok: false,
      error: `too many items to clean at once: ${items.length}, the limit is ${CLEANUP_MAX_ITEMS}. Pass ids from cleanup_list detail: true in batches instead.`,
    };
  return { ok: true, items };
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

/** 每次执行清理都加一，handler 缓存的扫描按它判断是否作废 */
let cleanupEpoch = 0;

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
  try {
    return await applyCleanupItems(ports, draft, secretaryConversationId);
  } finally {
    // 删过东西，之前缓存的扫描结果都作废
    cleanupEpoch += 1;
  }
}

async function applyCleanupItems(
  ports: CleanupPorts,
  draft: CleanupDraft,
  secretaryConversationId: string | null
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

  // worktree 已经删完，这时再读一次仓库就是执行时的事实；删一条分支不影响别的分支的判定，
  // 所以同一个仓库只读一次
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
    const merged = repo.merged.get(item.name) ?? [];
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
  /** 落一条待确认的清理提案；同类同参的卡已经在等就复用，不再叠一张 */
  saveProposal(
    items: CleanupItem[],
    secretaryConversationId: string | null
  ): Promise<SavedProposal>;
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

export interface CleanupHandlerOptions {
  scanDeadlineMs?: number;
  sizeBudgetMs?: number;
}

export function createSecretaryCleanupHandlers(
  ports: CleanupHandlerPorts,
  options: CleanupHandlerOptions = {}
): {
  cleanup_list: SecretaryOpHandler;
  cleanup_apply: SecretaryOpHandler;
} {
  // 最近一次完整扫描：cleanup_apply 紧跟 cleanup_list 时直接用它，不重扫。
  // 复用只影响确认卡上的清单，真正删除前 applyCleanup 仍按事实重新校验
  let cached: { at: number; epoch: number; scan: CleanupScan } | null = null;
  const fresh = (needSizes: boolean): CleanupScan | null => {
    if (!cached || cached.epoch !== cleanupEpoch) return null;
    if (ports.now() - cached.at > CLEANUP_SCAN_TTL_MS) return null;
    if (cached.scan.incomplete.length > 0) return null;
    if (needSizes && cached.scan.sizesPending > 0) return null;
    return cached.scan;
  };
  const scan = async (needSizes: boolean): Promise<CleanupScan> => {
    const reused = fresh(needSizes);
    if (reused) return reused;
    const epoch = cleanupEpoch;
    const result = await scanCleanup(ports, {
      ...(options.scanDeadlineMs !== undefined ? { deadlineMs: options.scanDeadlineMs } : {}),
      sizeBudgetMs: needSizes ? (options.sizeBudgetMs ?? CLEANUP_SIZE_BUDGET_MS) : false,
    });
    cached = { at: ports.now(), epoch, scan: result };
    return result;
  };
  return {
    async cleanup_list(params, ctx): Promise<SecretaryOpResult> {
      const projectId = typeof params.projectId === 'string' ? params.projectId.trim() : '';
      const kind = typeof params.kind === 'string' ? params.kind.trim() : '';
      if (kind && !(CLEANUP_ITEM_KINDS as readonly string[]).includes(kind))
        return {
          ok: false,
          error: `unknown kind: ${kind}, expected one of ${CLEANUP_ITEM_KINDS.join(', ')}`,
        };
      const detail = params.detail === true;
      const page = positiveInt(params.page) ?? 1;
      const scanned = await scan(true);
      const items = scanned.items.filter(
        (item) =>
          (!projectId || item.projectId === projectId) &&
          (!kind || item.kind === (kind as CleanupItemKind))
      );
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'cleanup_list',
        ok: true,
        detail: `${items.length} items ${detail ? `page ${page}` : 'summary'}`,
      });
      return {
        ok: true,
        result: detail
          ? cleanupDetailPage(items, page, cleanupScanNotes(scanned))
          : summarizeCleanupItems(items, cleanupScanNotes(scanned)),
      };
    },

    async cleanup_apply(params, ctx): Promise<SecretaryOpResult> {
      // all: true 表示"现在就清理所有可清理项"：id 由 Main 按同一套规则重新取，
      // 秘书不用翻页拼几十个长 id，确认卡照旧拦一道
      const all = params.all === true;
      const projectId = typeof params.projectId === 'string' ? params.projectId.trim() : '';
      const ids = parseIds(params.ids);
      // 空列表与超量不用扫就能拒
      const scanned =
        all || (ids.length > 0 && ids.length <= CLEANUP_MAX_ITEMS) ? await scan(false) : undefined;
      const selection: CleanupSelectionResult = all
        ? await selectAllCleanupItems(ports, projectId, scanned)
        : await selectCleanupItems(ports, ids, scanned);
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
      const saved = await ports.saveProposal(selection.items, ctx.secretaryConversationId);
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'cleanup_apply',
        targetId: saved.proposalId,
        ok: true,
        detail: saved.reused ? 'awaiting_confirmation (existing)' : 'awaiting_confirmation',
      });
      return {
        ok: true,
        result: {
          status: 'awaiting_confirmation',
          proposalId: saved.proposalId,
          total: selection.items.length,
          // 清单在确认卡上；这里只回前几条，几十条 id 会把工具结果撑大
          items: selection.items
            .slice(0, CLEANUP_SUMMARY_PER_KIND)
            .map((item) => ({ id: item.id, kind: item.kind, name: item.name })),
          ...(saved.reused ? { reused: true } : {}),
          ...(saved.otherPendingId ? { otherPendingId: saved.otherPendingId } : {}),
          ...(saved.note ? { note: saved.note } : {}),
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

/**
 * 按 key 缓存异步结果：同一个 key 正在算就共用，算完的按 ttl 留着。
 * du 与 gh 都慢，列清单时等不完的在后台继续，下一次直接取。
 */
export function memoizeAsync<T>(
  run: (key: string) => Promise<T>,
  ttlMs: (value: T) => number,
  now: () => number = Date.now
): (key: string) => Promise<T> {
  const done = new Map<string, { until: number; value: T }>();
  const pending = new Map<string, Promise<T>>();
  return (key) => {
    const hit = done.get(key);
    if (hit && now() < hit.until) return Promise.resolve(hit.value);
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const promise = run(key).finally(() => pending.delete(key));
    pending.set(key, promise);
    void promise.then(
      (value) => done.set(key, { until: now() + ttlMs(value), value }),
      () => undefined
    );
    return promise;
  };
}

/** `gh pr list --json headRefOid,baseRefName` 的输出；格式不对返回 null */
export function parseMergedPulls(stdout: string): MergedPull[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const pulls: MergedPull[] = [];
  for (const entry of parsed as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const { headRefOid, baseRefName } = entry as Record<string, unknown>;
    if (typeof headRefOid === 'string' && headRefOid && typeof baseRefName === 'string')
      pulls.push({ headRefOid, baseRefName });
  }
  return pulls;
}

const GH_TIMEOUT_MS = 6_000;
const GH_PULL_LIMIT = 1000;

export const runMergedPulls = (repoRoot: string): Promise<MergedPull[] | null> =>
  new Promise((resolve) => {
    execFile(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'merged',
        '--limit',
        String(GH_PULL_LIMIT),
        '--json',
        'headRefOid,baseRefName',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? null : parseMergedPulls(stdout))
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
    size: cachedDu,
    mergedPulls: cachedMergedPulls,
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

// 进程级缓存：清单与执行用的端口各建一份，du 与 gh 的结果要共用
const cachedDu = memoizeAsync(runDu, (size) => (size === null ? 60_000 : 10 * 60_000));
const cachedMergedPulls = memoizeAsync(runMergedPulls, (pulls) =>
  pulls === null ? 60_000 : 5 * 60_000
);

export const secretaryCleanupHandlers = createSecretaryCleanupHandlers({
  ...realCleanupPorts(),
  // 提案落盘在派发模块里：这里动态取，避免 cleanup ↔ dispatch 的静态环
  saveProposal: async (items, secretaryConversationId) => {
    const { saveCleanupProposal } = await import('./dispatch');
    return saveCleanupProposal(items, secretaryConversationId);
  },
});

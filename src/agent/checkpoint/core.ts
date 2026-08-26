/**
 * 工作树 checkpoint 的纯 git 操作(零 pi 依赖,可独立测试)。
 *
 * Vendored & adapted from pi-rewind v0.5.0 (https://github.com/arpagon/pi-rewind, MIT License,
 * Copyright (c) arpagon; lineage: prateekmedia/checkpoint-pi, nicobailon/pi-rewind-hook).
 * 改动:ref 前缀 refs/enso-checkpoints;checkpoint 关联 session entry(id+时间戳)而非轮序号;
 * 移除 TUI/diff 相关部分。
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ZEROS = '0'.repeat(40);
export const REF_BASE = 'refs/enso-checkpoints';

/** 未跟踪文件纳入快照的大小上限(10 MiB) */
export const MAX_UNTRACKED_FILE_SIZE = 10 * 1024 * 1024;
/** 未跟踪目录纳入快照的文件数上限(达到即整目录跳过) */
export const MAX_UNTRACKED_DIR_FILES = 200;
/** 每会话 checkpoint 上限,超出裁剪最旧的 */
export const DEFAULT_MAX_CHECKPOINTS = 50;

/** 快照排除的目录名(命中任一路径分量即跳过) */
export const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.venv',
  'venv',
  'env',
  '.env',
  'dist',
  'build',
  '.pytest_cache',
  '.mypy_cache',
  '.cache',
  '.tox',
  '__pycache__',
]);

export interface CheckpointData {
  /** 唯一 id,即 ref 名 */
  id: string;
  sessionId: string;
  trigger: 'tool' | 'before-restore';
  /** 触发快照的工具名 */
  toolName?: string;
  /** 本轮 user 消息的 session entry id(还原时精确匹配) */
  entryId?: string;
  /** 该 entry 的时间戳(ms;还原降级匹配用) */
  entryTimestamp?: number;
  /** 快照时的 git 分支(跨分支还原保护) */
  branch: string;
  headSha: string;
  /** 真实 index 的树 sha(还原暂存区用) */
  indexTreeSha: string;
  /** 完整工作树(index + 未跟踪)的树 sha */
  worktreeTreeSha: string;
  timestamp: number;
  /** 快照时已存在的未跟踪文件(safe-clean 保护名单) */
  preexistingUntrackedFiles?: string[];
  skippedLargeFiles?: string[];
  skippedLargeDirs?: string[];
}

/** 经 spawn 跑 git(无 shell 注入),cmd 按引号感知拆参 */
export function git(
  cmd: string,
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = parseArgs(cmd);
    const proc = spawn('git', args, { cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `git ${args[0]} failed (code ${code})`));
    });
    proc.on('error', reject);
    if (opts.input && proc.stdin) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    } else {
      proc.stdin?.end();
    }
  });
}

function parseArgs(cmd: string): string[] {
  const args: string[] = [];
  let cur = '';
  let sq = false;
  let dq = false;
  for (const c of cmd) {
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (c === ' ' && !sq && !dq) {
      if (cur) {
        args.push(cur);
        cur = '';
      }
    } else cur += c;
  }
  if (cur) args.push(cur);
  return args;
}

export const getRepoRoot = (cwd: string): Promise<string> => git('rev-parse --show-toplevel', cwd);

/** 任一路径分量命中排除目录名即忽略 */
export function shouldIgnoreForSnapshot(path: string): boolean {
  return path.split(/[/\\]/).some((c) => IGNORED_DIR_NAMES.has(c));
}

function normalizeGitPath(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (n.startsWith('./')) n = n.slice(2);
  return n.replace(/\/$/, '');
}

function isPathWithin(path: string, dir: string): boolean {
  if (!dir || dir === '.') return true;
  if (path === dir) return true;
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  return path.startsWith(prefix);
}

function isPathWithinAny(path: string, dirs: Set<string>): boolean {
  for (const d of dirs) if (isPathWithin(path, d)) return true;
  return false;
}

interface StatusSnapshot {
  trackedPaths: string[];
  untrackedFiles: string[];
  untrackedFilesForIndex: string[];
  untrackedDirs: string[];
  skippedLargeFiles: string[];
}

async function captureStatusSnapshot(root: string): Promise<StatusSnapshot> {
  const snap: StatusSnapshot = {
    trackedPaths: [],
    untrackedFiles: [],
    untrackedFilesForIndex: [],
    untrackedDirs: [],
    skippedLargeFiles: [],
  };
  const output = await git('status --porcelain=2 -z --untracked-files=all', root).catch(() => '');
  if (!output) return snap;

  const entries = output.split('\0').filter(Boolean);
  let expectRename = false;
  for (const entry of entries) {
    if (expectRename) {
      const n = normalizeGitPath(entry);
      if (n) snap.trackedPaths.push(n);
      expectRename = false;
      continue;
    }
    const tag = entry[0];
    if (tag === '?' || tag === '!') {
      const sp = entry.indexOf(' ');
      if (sp === -1) continue;
      const raw = normalizeGitPath(entry.slice(sp + 1));
      if (!raw || shouldIgnoreForSnapshot(raw)) continue;
      let st: ReturnType<typeof statSync> | null = null;
      try {
        st = statSync(join(root, raw));
      } catch {
        st = null;
      }
      if (st?.isDirectory()) {
        snap.untrackedDirs.push(raw);
        continue;
      }
      snap.untrackedFiles.push(raw);
      const large = st?.isFile() ? st.size > MAX_UNTRACKED_FILE_SIZE : false;
      if (large) snap.skippedLargeFiles.push(raw);
      else snap.untrackedFilesForIndex.push(raw);
    } else if (tag === '1') {
      const p = extractField(entry, 8);
      if (p) snap.trackedPaths.push(normalizeGitPath(p));
    } else if (tag === '2') {
      const p = extractField(entry, 9);
      if (p) snap.trackedPaths.push(normalizeGitPath(p));
      expectRename = true;
    } else if (tag === 'u') {
      const p = extractField(entry, 10);
      if (p) snap.trackedPaths.push(normalizeGitPath(p));
    }
  }
  return snap;
}

function extractField(record: string, n: number): string | null {
  let spaces = 0;
  for (let i = 0; i < record.length; i++) {
    if (record[i] === ' ' && ++spaces === n) {
      const p = record.slice(i + 1);
      return p.length > 0 ? p : null;
    }
  }
  return null;
}

/** 找出未跟踪文件数达到阈值的目录(整目录跳过) */
function detectLargeDirs(files: string[], dirs: string[], threshold: number): string[] {
  if (threshold <= 0 || files.length === 0) return [];
  const counts = new Map<string, number>();
  const sortedDirs = [...dirs].sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    return da !== db ? db - da : a.localeCompare(b);
  });
  for (const f of files) {
    let bucket: string | null = null;
    for (const d of sortedDirs) {
      if (isPathWithin(f, d)) {
        bucket = d;
        break;
      }
    }
    if (!bucket) {
      const parts = f.split('/');
      bucket = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    }
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([k, v]) => v >= threshold && k !== '.')
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

async function getFilesToAdd(root: string): Promise<{
  filtered: string[];
  allUntracked: string[];
  skippedLargeFiles: string[];
  skippedLargeDirs: string[];
}> {
  const status = await captureStatusSnapshot(root);
  const largeDirs = detectLargeDirs(
    status.untrackedFiles,
    status.untrackedDirs,
    MAX_UNTRACKED_DIR_FILES
  );
  const largeDirsSet = new Set(largeDirs);
  const untrackedForIndex = status.untrackedFilesForIndex.filter(
    (p) => !isPathWithinAny(p, largeDirsSet)
  );
  const skippedLargeFiles = status.skippedLargeFiles.filter(
    (p) => !isPathWithinAny(p, largeDirsSet)
  );
  const all = new Set<string>();
  for (const p of status.trackedPaths) all.add(p);
  for (const p of untrackedForIndex) all.add(p);
  return {
    filtered: [...all],
    allUntracked: status.untrackedFiles,
    skippedLargeFiles,
    skippedLargeDirs: largeDirs,
  };
}

export interface CreateCheckpointOpts {
  root: string;
  id: string;
  sessionId: string;
  trigger: CheckpointData['trigger'];
  toolName?: string;
  entryId?: string;
  entryTimestamp?: number;
}

/**
 * 把 HEAD + index + 工作树快照进一个 git ref(commit-tree,不动 HEAD/index/分支)。
 * 元数据存 commit message,重启后可从 ref 复原。
 */
export async function createCheckpoint(opts: CreateCheckpointOpts): Promise<CheckpointData> {
  const { root, id, sessionId, trigger, toolName, entryId, entryTimestamp } = opts;
  const timestamp = Date.now();
  const iso = new Date(timestamp).toISOString();

  const headSha = await git('rev-parse HEAD', root).catch(() => ZEROS);
  const branch = await git('rev-parse --abbrev-ref HEAD', root).catch(() => 'unknown');
  const indexTreeSha = await git('write-tree', root);

  const tmpDir = await mkdtemp(join(tmpdir(), 'enso-checkpoint-'));
  const tmpIndex = join(tmpDir, 'index');
  try {
    const tmpEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const { filtered, allUntracked, skippedLargeFiles, skippedLargeDirs } =
      await getFilesToAdd(root);
    const largeDirsSet = new Set(skippedLargeDirs);
    const largeFilesSet = new Set(skippedLargeFiles);
    const preexistingUntrackedFiles = allUntracked.filter((f) => {
      if (shouldIgnoreForSnapshot(f)) return false;
      if (largeFilesSet.has(f)) return false;
      if (isPathWithinAny(f, largeDirsSet)) return false;
      return true;
    });

    // 临时 index 以 HEAD 为底,叠加改动与未跟踪文件后 write-tree
    if (headSha !== ZEROS) {
      await git(`read-tree ${headSha}`, root, { env: tmpEnv });
    }
    const BATCH = 100;
    for (let i = 0; i < filtered.length; i += BATCH) {
      const paths = filtered
        .slice(i, i + BATCH)
        .map((f) => `"${f}"`)
        .join(' ');
      await git(`add --all -- ${paths}`, root, { env: tmpEnv });
    }
    const worktreeTreeSha = await git('write-tree', root, { env: tmpEnv });

    const msg = [
      `enso-checkpoint:${id}`,
      `sessionId ${sessionId}`,
      `trigger ${trigger}`,
      toolName ? `toolName ${toolName}` : null,
      entryId ? `entryId ${entryId}` : null,
      entryTimestamp ? `entryTimestamp ${entryTimestamp}` : null,
      `branch ${branch}`,
      `head ${headSha}`,
      `index-tree ${indexTreeSha}`,
      `worktree-tree ${worktreeTreeSha}`,
      `created ${iso}`,
      `untracked ${JSON.stringify(preexistingUntrackedFiles)}`,
      `largeFiles ${JSON.stringify(skippedLargeFiles)}`,
      `largeDirs ${JSON.stringify(skippedLargeDirs)}`,
    ]
      .filter(Boolean)
      .join('\n');

    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'enso-code',
      GIT_AUTHOR_EMAIL: 'checkpoint@enso',
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_NAME: 'enso-code',
      GIT_COMMITTER_EMAIL: 'checkpoint@enso',
      GIT_COMMITTER_DATE: iso,
    };
    const commitSha = await git(`commit-tree ${worktreeTreeSha}`, root, {
      input: msg,
      env: commitEnv,
    });
    await git(`update-ref ${REF_BASE}/${id} ${commitSha}`, root);

    return {
      id,
      sessionId,
      trigger,
      toolName,
      entryId,
      entryTimestamp,
      branch,
      headSha,
      indexTreeSha,
      worktreeTreeSha,
      timestamp,
      preexistingUntrackedFiles,
      skippedLargeFiles: skippedLargeFiles.length > 0 ? skippedLargeFiles : undefined,
      skippedLargeDirs: skippedLargeDirs.length > 0 ? skippedLargeDirs : undefined,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 把工作树 + index 还原到 checkpoint。只清理快照后新出现的未跟踪文件,
 * 快照前已有的未跟踪文件、被过滤的大文件/目录一律保留。
 */
export async function restoreCheckpoint(root: string, cp: CheckpointData): Promise<void> {
  // 跨 git 分支还原会用旧分支内容覆盖当前分支,直接拒绝
  if (cp.branch) {
    const currentBranch = await git('rev-parse --abbrev-ref HEAD', root).catch(() => 'unknown');
    if (currentBranch !== cp.branch) {
      throw new Error(
        `checkpoint was created on git branch "${cp.branch}" but current is "${currentBranch}"`
      );
    }
  }
  if (cp.headSha !== ZEROS) {
    await git(`reset --hard ${cp.headSha}`, root);
  }
  await git(`read-tree --reset -u ${cp.worktreeTreeSha}`, root);
  await safeClean(
    root,
    cp.preexistingUntrackedFiles || [],
    cp.skippedLargeFiles || [],
    cp.skippedLargeDirs || []
  );
  // 恢复暂存区状态,不再动文件
  await git(`read-tree --reset ${cp.indexTreeSha}`, root);
}

async function safeClean(
  root: string,
  preexisting: string[],
  skippedFiles: string[],
  skippedDirs: string[]
): Promise<void> {
  const output = await git('ls-files --others --exclude-standard', root).catch(() => '');
  const current = output.split('\n').filter(Boolean);
  if (current.length === 0) return;
  const preSet = new Set(preexisting);
  const sfSet = new Set(skippedFiles);
  const sdSet = new Set(skippedDirs);
  const toRemove = current.filter((f) => {
    if (preSet.has(f)) return false;
    if (shouldIgnoreForSnapshot(f)) return false;
    if (sfSet.has(f)) return false;
    if (isPathWithinAny(f, sdSet)) return false;
    return true;
  });
  const BATCH = 100;
  for (let i = 0; i < toRemove.length; i += BATCH) {
    const paths = toRemove
      .slice(i, i + BATCH)
      .map((f) => `"${f}"`)
      .join(' ');
    await git(`clean -f -- ${paths}`, root).catch(() => {});
  }
}

/** 从 ref 复原 checkpoint 元数据 */
export async function loadCheckpointFromRef(
  root: string,
  refName: string
): Promise<CheckpointData | null> {
  try {
    const commitSha = await git(`rev-parse --verify ${REF_BASE}/${refName}`, root);
    const msg = await git(`cat-file commit ${commitSha}`, root);
    const get = (key: string) => msg.match(new RegExp(`^${key} (.+)$`, 'm'))?.[1]?.trim();
    const sid = get('sessionId');
    const head = get('head');
    const idx = get('index-tree');
    const wt = get('worktree-tree');
    if (!sid || !head || !idx || !wt) return null;
    const parseJson = (key: string): string[] | undefined => {
      const raw = get(key);
      if (!raw) return undefined;
      try {
        const arr = JSON.parse(raw) as string[];
        return arr.length > 0 ? arr : undefined;
      } catch {
        return undefined;
      }
    };
    const created = get('created');
    const entryTs = get('entryTimestamp');
    return {
      id: refName,
      sessionId: sid,
      trigger: get('trigger') === 'before-restore' ? 'before-restore' : 'tool',
      toolName: get('toolName'),
      entryId: get('entryId'),
      entryTimestamp: entryTs ? Number(entryTs) : undefined,
      branch: get('branch') || 'unknown',
      headSha: head,
      indexTreeSha: idx,
      worktreeTreeSha: wt,
      timestamp: created ? new Date(created).getTime() : 0,
      preexistingUntrackedFiles: parseJson('untracked'),
      skippedLargeFiles: parseJson('largeFiles'),
      skippedLargeDirs: parseJson('largeDirs'),
    };
  } catch {
    return null;
  }
}

export async function listCheckpointRefs(root: string): Promise<string[]> {
  try {
    const prefix = `${REF_BASE}/`;
    const out = await git(`for-each-ref --format=%(refname) ${prefix}`, root);
    return out
      .split('\n')
      .filter(Boolean)
      .map((r) => r.replace(prefix, ''));
  } catch {
    return [];
  }
}

export async function loadAllCheckpoints(
  root: string,
  sessionId?: string
): Promise<CheckpointData[]> {
  const refs = await listCheckpointRefs(root);
  const results = await Promise.all(refs.map((r) => loadCheckpointFromRef(root, r)));
  return results.filter(
    (cp): cp is CheckpointData => cp !== null && (!sessionId || cp.sessionId === sessionId)
  );
}

export async function deleteCheckpoint(root: string, id: string): Promise<void> {
  await git(`update-ref -d ${REF_BASE}/${id}`, root).catch(() => {});
}

/** 裁剪某会话最旧的 checkpoint,保留至多 max 个;before-restore 安全快照不裁 */
export async function pruneCheckpoints(
  root: string,
  sessionId: string,
  max: number = DEFAULT_MAX_CHECKPOINTS
): Promise<number> {
  const all = await loadAllCheckpoints(root, sessionId);
  all.sort((a, b) => a.timestamp - b.timestamp);
  const prunable = all.filter((cp) => cp.trigger !== 'before-restore');
  if (prunable.length <= max) return 0;
  const toDelete = prunable.slice(0, prunable.length - max);
  for (const cp of toDelete) {
    await deleteCheckpoint(root, cp.id);
  }
  return toDelete.length;
}

/** 清理过期 checkpoint(spawn 时调用)。
 *  不能按「非当前会话」清:同一 repo 下多个会话并存,互相 spawn 会把对方的快照全抹掉 */
export async function pruneStaleCheckpoints(
  root: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): Promise<number> {
  const all = await loadAllCheckpoints(root);
  const cutoff = Date.now() - maxAgeMs;
  let deleted = 0;
  for (const cp of all) {
    if (cp.timestamp >= cutoff) continue;
    await deleteCheckpoint(root, cp.id);
    deleted++;
  }
  return deleted;
}

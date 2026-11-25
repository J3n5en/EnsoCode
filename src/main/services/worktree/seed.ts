/**
 * worktree 依赖播种：把主检出的 node_modules 以零拷贝种进新 worktree，
 * agent 首次 pnpm install 退化为校验快路径（实测 37s → 1.3s）。
 *
 * 核心机制：macOS 的 clonefile(2) 对目录是递归克隆——整棵 node_modules 一次 syscall，
 * 1.6G / 7 万文件的依赖树约 2s 完成，数据块 copy-on-write 不占额外磁盘。
 * Node 的 fs.copyFile 不支持目录，因此 macOS 上通过 python3 ctypes 调 libc（python3 是
 * macOS 标配，ctypes/libSystem 随系统）；失败回退逐文件 clonefile，再退硬链接。
 * 硬链接与 pnpm 全局 store 的链接语义相同，pnpm install 只增删链接、从不原地改写。
 *
 * best-effort：任何失败只记数不抛错，worktree 创建绝不被播种阻断——
 * 没有种子，agent 的 pnpm install 就是原来的冷路径。
 *
 * 不播种构建产物：构建产物目录（out/dist/build）没有跨项目通用约定，
 * 且 vite/electron-vite 无增量缓存语义，实测拷贝后构建反而更慢。
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, type Dirent, readdirSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, readlink, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 目录扫描最深 4 层（约覆盖 packages/x/y），再深的 node_modules 不值得为它扫全树 */
const SCAN_MAX_DEPTH = 4;
/** 逐文件复制的并发上限（仅回退路径使用） */
const COPY_CONCURRENCY = 16;

/**
 * 扫描仓库里所有 node_modules 目录，返回相对仓库根的路径（如 node_modules、packages/x/node_modules）。
 * 同步扫描：遍历的是浅层目录树（不进 node_modules 内部），通常几十到几百个目录，毫秒级。
 */
export function scanDependencyDirs(repoPath: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name === 'node_modules') {
        found.push(relative(repoPath, join(dir, name)));
        continue;
      }
      // 不进隐藏目录（.git/.cache）和 node_modules 内部
      if (name.startsWith('.')) continue;
      if (depth < SCAN_MAX_DEPTH) {
        walk(join(dir, name), depth + 1);
      }
    }
  };
  walk(repoPath, 0);
  return found;
}

export interface SeedResult {
  /** 成功播种的 node_modules 相对路径 */
  seeded: string[];
  /** 跳过及原因（已存在 / 平台不支持） */
  skipped: { dir: string; reason: 'exists' | 'unsupported' }[];
  /** 播种过程中失败的文件数（best-effort，不阻断） */
  errors: number;
  /** 复制的文件总数（整树克隆时记 0，不代表没复制） */
  files: number;
  /** 走的复制路径：clonefile 整树 / 逐文件 / 混合（部分目录回退） */
  method: 'tree-clone' | 'per-file' | 'mixed' | 'none';
  durationMs: number;
}

interface SeedOptions {
  repoPath: string;
  worktreePath: string;
}

/** win32 没有可用的零拷贝语义（ReFS 罕见且 Node 无暴露），直接不播种 */
const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux';

export async function seedWorktreeDependencies(options: SeedOptions): Promise<SeedResult> {
  const started = Date.now();
  const result: SeedResult = {
    seeded: [],
    skipped: [],
    errors: 0,
    files: 0,
    method: 'none',
    durationMs: 0,
  };
  if (!SUPPORTED) {
    return finish(result, started);
  }
  const dirs = scanDependencyDirs(options.repoPath);
  let usedTreeClone = false;
  let usedPerFile = false;
  await Promise.all(
    dirs.map(async (dir) => {
      const source = join(options.repoPath, dir);
      const target = join(options.worktreePath, dir);
      if (exists(target)) {
        result.skipped.push({ dir, reason: 'exists' });
        return;
      }
      // 快路径：macOS 整树递归 clonefile，一次 syscall 完成整棵依赖树
      if (await cloneTreeRecursive(source, target)) {
        usedTreeClone = true;
        result.seeded.push(dir);
        return;
      }
      // 回退：逐文件 clonefile/硬链接
      const copied = await copyTreeZeroCopy(source, target);
      usedPerFile = true;
      result.files += copied.files;
      result.errors += copied.errors;
      if (copied.files > 0 || copied.errors === 0) {
        result.seeded.push(dir);
      }
    })
  );
  result.method = usedTreeClone
    ? usedPerFile
      ? 'per-file'
      : 'tree-clone'
    : usedPerFile
      ? 'per-file'
      : 'none';
  return finish(result, started);
}

function finish(result: SeedResult, started: number): SeedResult {
  result.durationMs = Date.now() - started;
  return result;
}

function exists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * macOS：clonefile(2) 递归克隆整棵目录树。经 python3 ctypes 调 libc——
 * python3 是 macOS 标配，比编译 C helper 或维护预编译二进制简单。
 * 目标路径的父目录可能不存在，先建好（clonefile 只要求最后一级不存在）。
 * 返回 false 表示不可用（非 macOS / python3 缺失 / 文件系统不支持），调用方走回退路径。
 */
async function cloneTreeRecursive(source: string, target: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await mkdir(dirname(target), { recursive: true });
    // os.environ 清空避免 PATH 差异；ctypes 只用标准库
    await execFileAsync(
      '/usr/bin/python3',
      [
        '-c',
        'import ctypes,sys;' +
          'libc=ctypes.CDLL("/usr/lib/libSystem.B.dylib");' +
          'rc=libc.clonefile(sys.argv[1].encode(),sys.argv[2].encode(),0);' +
          'sys.exit(0 if rc==0 else 1)',
        source,
        target,
      ],
      { timeout: 60_000 }
    );
    return exists(target);
  } catch {
    return false;
  }
}

interface CopyStats {
  files: number;
  errors: number;
}

/**
 * 并行递归复制一棵树（回退路径）：常规文件走 clonefile→硬链接，符号链接原样重建。
 * 单文件失败记数跳过，整体永不抛错。
 */
async function copyTreeZeroCopy(source: string, target: string): Promise<CopyStats> {
  const stats: CopyStats = { files: 0, errors: 0 };
  interface Entry {
    src: string;
    dst: string;
    kind: 'file' | 'symlink' | 'dir';
  }
  const entries: Entry[] = [];
  const collect = async (srcDir: string, dstDir: string): Promise<void> => {
    let dirents: Dirent[];
    try {
      dirents = await readdir(srcDir, { withFileTypes: true });
    } catch {
      stats.errors++;
      return;
    }
    entries.push({ src: srcDir, dst: dstDir, kind: 'dir' });
    const subdirs: Promise<void>[] = [];
    for (const dirent of dirents) {
      const src = join(srcDir, dirent.name);
      const dst = join(dstDir, dirent.name);
      if (dirent.isDirectory()) {
        subdirs.push(collect(src, dst));
      } else if (dirent.isSymbolicLink()) {
        entries.push({ src, dst, kind: 'symlink' });
      } else if (dirent.isFile()) {
        entries.push({ src, dst, kind: 'file' });
      }
      // FIFO/socket/设备文件跳过
    }
    await Promise.all(subdirs);
  };
  await collect(source, target);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        // 并发池下 mkdir 不保证先于复制完成，复制前自建父目录（幂等）
        await mkdir(entry.kind === 'dir' ? entry.dst : dirname(entry.dst), { recursive: true });
        if (entry.kind === 'dir') continue;
        if (entry.kind === 'symlink') {
          const linkTarget = await readlink(entry.src);
          await symlink(linkTarget, entry.dst);
        } else {
          await copyZeroCopy(entry.src, entry.dst);
          stats.files++;
        }
      } catch {
        stats.errors++;
      }
    }
  };
  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, worker));
  return stats;
}

/** 零拷贝复制单文件：优先 clonefile（copy-on-write），回退硬链接 */
async function copyZeroCopy(src: string, dst: string): Promise<void> {
  try {
    await copyFile(src, dst, constants.COPYFILE_FICLONE);
    return;
  } catch {
    // 文件系统不支持 clonefile（非 APFS/btrfs/xfs）：退硬链接。
    // 与 pnpm store 的链接语义一致，依赖文件不会被原地改写。
  }
  await link(src, dst);
}

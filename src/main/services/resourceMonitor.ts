import { execFile } from 'node:child_process';
import { readdir, rm, rmdir, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Worker } from 'node:worker_threads';
import { app, processMetrics, session } from '@platform';
import { projectDisplayName } from '@shared/projectName';
import {
  AGENT_SERVICE_NAME,
  type ChromiumPidKinds,
  chromiumRole,
  commandLabel,
  cpuPercent,
  descendantPids,
  type PsRow,
  parsePs,
  parsePsArgs,
  parseWinProcesses,
  type ResourceProcess,
  type ResourceSnapshot,
  type SessionFileRef,
  type SessionStorageEntry,
  type StorageCategoryId,
  type StorageCleanResult,
  type StorageRoot,
  type StorageScanProgress,
  type StorageSnapshot,
} from '@shared/resources';
import { resolveWorktreeRoot } from '@shared/worktreeRoot';
import { readSettings } from '../ipc/settings';
import { partitionName } from './browserPartition';
import { getSecretaryImageStore } from './secretary/inboundImages';
import { getSecretaryReportStore } from './secretary/reportImages';
import type { ScanRootSpec, StorageWorkerData, StorageWorkerMessage } from './storageScanWorker';
import { localUi } from './uiHost';

const execFileAsync = promisify(execFile);

let prevSystem: { idle: number; total: number } | null = null;
let prevPs: { at: number; cpu: Map<number, number> } | null = null;
let listing: Promise<PsRow[]> | null = null;

function systemCpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function sampleSystemCpu(): number {
  const next = systemCpuTimes();
  const prev = prevSystem;
  prevSystem = next;
  if (!prev || next.total <= prev.total) return 0;
  return (1 - (next.idle - prev.idle) / (next.total - prev.total)) * 100;
}

const PS_OPTIONS = { maxBuffer: 32 * 1024 * 1024, windowsHide: true };
const WIN_PS =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime,Name,CommandLine | ConvertTo-Json -Compress';

async function listUnix(): Promise<PsRow[]> {
  const [stats, args] = await Promise.all([
    execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,cputime=,comm='], PS_OPTIONS),
    execFileAsync('ps', ['-axww', '-o', 'pid=,args='], PS_OPTIONS),
  ]);
  const argMap = parsePsArgs(args.stdout);
  return parsePs(stats.stdout).map((row) => ({ ...row, args: argMap.get(row.pid) ?? row.name }));
}

async function listWindows(): Promise<PsRow[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WIN_PS],
    PS_OPTIONS
  );
  return parseWinProcesses(stdout);
}

/** 进程表采样较慢（Windows 走 PowerShell）：同一时刻只跑一份 */
function listProcesses(): Promise<PsRow[]> {
  listing ??= (process.platform === 'win32' ? listWindows() : listUnix())
    .then((rows) =>
      rows.filter((row) => row.ppid !== process.pid || !/^(ps|powershell)/i.test(row.name))
    )
    .catch(() => [])
    .finally(() => {
      listing = null;
    });
  return listing;
}

function chromiumKinds(): { kinds: ChromiumPidKinds; titles: Map<number, string> } {
  const info = localUi()?.chromiumRenderers();
  return {
    kinds: {
      main: new Set(info?.mainPids ?? []),
      settings: new Set(info?.settingsPids ?? []),
      browser: new Set(info?.browserPids ?? []),
    },
    titles: new Map(info?.titles ?? []),
  };
}

export async function sampleResources(): Promise<ResourceSnapshot> {
  const cores = Math.max(1, os.cpus().length);
  const metrics = processMetrics();
  const { kinds, titles } = chromiumKinds();
  const rows = await listProcesses();
  const now = Date.now();

  const processes: ResourceProcess[] = metrics.map((m) => {
    const role = chromiumRole(m, kinds);
    const name =
      role === 'agent'
        ? 'Agent worker'
        : role === 'main'
          ? app.getName()
          : role === 'gpu'
            ? 'GPU'
            : kinds.main.has(m.pid)
              ? 'Main window'
              : kinds.settings.has(m.pid)
                ? 'Settings'
                : (titles.get(m.pid) ?? m.name ?? m.serviceName ?? m.type);
    return {
      pid: m.pid,
      name,
      group: role === 'agent' ? 'agent' : 'app',
      role,
      cpu: Math.min(100, m.cpu.percentCPUUsage / cores),
      memory: m.memory.workingSetSize * 1024,
    };
  });

  const appPids = new Set(metrics.map((m) => m.pid));
  const agentPids = metrics
    .filter((m) => m.serviceName === AGENT_SERVICE_NAME || m.name === AGENT_SERVICE_NAME)
    .map((m) => m.pid);
  const agentTree = descendantPids(rows, agentPids);
  const children = descendantPids(rows, appPids);
  const nextCpu = new Map<number, number>();
  for (const row of rows) {
    if (!children.has(row.pid)) continue;
    nextCpu.set(row.pid, row.cpuSeconds);
    const prev = prevPs?.cpu.get(row.pid);
    const inAgent = agentTree.has(row.pid);
    processes.push({
      pid: row.pid,
      name: commandLabel(row.name, row.args ?? row.name),
      ...(row.args ? { command: row.args } : {}),
      group: inAgent ? 'agent' : 'child',
      role: inAgent ? 'tool' : 'child',
      cpu:
        prev === undefined || !prevPs
          ? 0
          : cpuPercent(prev, row.cpuSeconds, now - prevPs.at, cores),
      memory: row.rss,
    });
  }
  prevPs = { at: now, cpu: nextCpu };

  const total = os.totalmem();
  return {
    cpu: {
      app: Math.min(
        100,
        processes.reduce((sum, p) => sum + p.cpu, 0)
      ),
      system: sampleSystemCpu(),
    },
    memory: {
      app: processes.reduce((sum, p) => sum + p.memory, 0),
      system: total - os.freemem(),
      total,
    },
    processes,
  };
}

function browserPartitionDir(): string {
  return `Partitions/${partitionName(app.isPackaged).replace(/^persist:/, '')}`;
}

const toPosix = (value: string) => value.split(path.sep).join('/');

function worktreeRootPath(): string {
  const state = (
    readSettings()?.['enso-settings'] as { state?: Record<string, unknown> } | undefined
  )?.state;
  return resolveWorktreeRoot(state?.worktreeRoot, path.join(app.getPath('userData'), 'worktrees'));
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 扫描的根：userData，加上设置在其外的 worktree 根 */
function scanRoots(): ScanRootSpec[] {
  const data = app.getPath('userData');
  const roots: ScanRootSpec[] = [{ id: 'data', path: data, follow: true }];
  const worktrees = worktreeRootPath();
  if (!isInside(data, worktrees)) roots.push({ id: 'worktrees', path: worktrees, follow: false });
  return roots;
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** 从持久化会话元数据得到根会话列表与文件归属；只读 settings.json，不碰 renderer。 */
function sessionIndex(): {
  sessions: Map<string, SessionStorageEntry>;
  refs: SessionFileRef[];
  ready: boolean;
} {
  const root = app.getPath('userData');
  const settings = readSettings() ?? {};
  const projectNames = new Map<string, string>();
  const projects = record(record(settings['enso-settings'])?.state)?.projects;
  for (const project of Array.isArray(projects) ? projects : []) {
    const row = record(project);
    const id = str(row?.id);
    if (!row || !id) continue;
    projectNames.set(
      id,
      projectDisplayName({
        name: str(row.name) ?? '',
        path: str(row.path) ?? '',
        alias: str(row.alias),
      })
    );
  }
  // userData 内用相对路径，外部 worktree 用绝对 posix 路径（与扫描 worker 的归属键一致）
  const toKey = (abs: string | undefined, allowExternal: boolean) => {
    if (!abs || !path.isAbsolute(abs)) return undefined;
    if (isInside(root, abs)) {
      const rel = path.relative(root, abs);
      return rel ? toPosix(rel) : undefined;
    }
    return allowExternal ? toPosix(abs) : undefined;
  };
  const conversations = record(
    record(record(settings['enso-conversations'])?.state)?.conversations
  );
  const refs: SessionFileRef[] = [];
  const sessions = new Map<string, SessionStorageEntry>();
  for (const [id, value] of Object.entries(conversations ?? {})) {
    const c = record(value);
    if (!c) continue;
    const parentId = str(c.parentId);
    refs.push({
      id,
      ...(parentId ? { parentId } : {}),
      sessionRel: toKey(str(c.sessionFile), false),
      worktreeRel: toKey(str(record(c.worktree)?.path), true),
    });
    if (parentId || str(c.btwParentId)) continue;
    const archivedAt = num(c.archivedAt);
    sessions.set(id, {
      id,
      title: str(c.title) ?? '',
      projectId: str(c.projectId) ?? '',
      projectName: projectNames.get(str(c.projectId) ?? '') ?? '',
      archived: c.archived === true,
      pinned: c.pinned === true,
      ...(archivedAt !== undefined ? { archivedAt } : {}),
      lastActiveAt: num(c.lastActiveAt) ?? num(c.createdAt) ?? 0,
      bytes: 0,
    });
  }
  // 空会话表更可能是半截写入：孤儿清理据此整类跳过
  return { sessions, refs, ready: refs.length > 0 };
}

class ScanCancelled extends Error {
  constructor() {
    super('Scan cancelled');
  }
}

interface WorkerRun<T> {
  promise: Promise<T>;
  cancel: () => void;
}

async function spawnStorageWorker(data: StorageWorkerData): Promise<Worker> {
  const { default: spawn } = await import('./storageScanWorker?nodeWorker');
  return spawn({ workerData: data });
}

function runWorker<T>(
  data: StorageWorkerData,
  pick: (message: StorageWorkerMessage) => T | undefined,
  onProgress?: (progress: StorageScanProgress) => void
): WorkerRun<T> {
  let worker: Worker | null = null;
  let cancelled = false;
  let rejectRun: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    rejectRun = reject;
    spawnStorageWorker(data).then((w) => {
      worker = w;
      if (cancelled) {
        void w.terminate();
        return;
      }
      w.on('message', (message: StorageWorkerMessage) => {
        if (message.type === 'progress') onProgress?.(message.progress);
        else if (message.type === 'error') reject(new Error(message.message));
        else {
          const value = pick(message);
          if (value !== undefined) resolve(value);
        }
        if (message.type !== 'progress') void w.terminate();
      });
      w.once('error', reject);
      w.once('exit', () =>
        reject(cancelled ? new ScanCancelled() : new Error('Storage worker exited'))
      );
    }, reject);
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      rejectRun(new ScanCancelled());
      void worker?.terminate();
    },
  };
}

async function volumeOf(root: string): Promise<Pick<StorageRoot, 'volumeId' | 'volume'>> {
  const [st, fs] = await Promise.all([
    stat(root).catch(() => null),
    statfs(root).catch(() => null),
  ]);
  return {
    volumeId: st ? String(st.dev) : root,
    volume: fs ? { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize } : null,
  };
}

let currentScan: WorkerRun<StorageSnapshot> | null = null;
let lastSnapshot: StorageSnapshot | null = null;
const progressListeners = new Set<(progress: StorageScanProgress) => void>();

function startScan(): WorkerRun<StorageSnapshot> {
  const started = Date.now();
  const roots = scanRoots();
  const index = sessionIndex();
  const run = runWorker(
    { mode: 'scan', roots, browserDir: browserPartitionDir(), refs: index.refs },
    (message) => (message.type === 'scan-done' ? message.result : undefined),
    (progress) => {
      for (const listener of progressListeners) listener(progress);
    }
  );
  const promise = run.promise.then(async (result) => {
    for (const [id, bytes] of result.sessionBytes) {
      const entry = index.sessions.get(id);
      if (entry) entry.bytes = bytes;
    }
    const storageRoots: StorageRoot[] = await Promise.all(
      roots.map(async (root) => ({
        id: root.id,
        path: root.path,
        bytes: result.rootBytes[root.id] ?? 0,
        ...(await volumeOf(root.path)),
      }))
    );
    const snapshot: StorageSnapshot = {
      roots: storageRoots,
      totalBytes: storageRoots.reduce((sum, r) => sum + r.bytes, 0),
      categories: result.categories,
      sessions: [...index.sessions.values()].sort((a, b) => b.bytes - a.bytes),
      scannedAt: Date.now(),
      durationMs: Date.now() - started,
      errorCount: result.errorCount,
      errors: result.errors,
    };
    lastSnapshot = snapshot;
    return snapshot;
  });
  return { promise, cancel: run.cancel };
}

/** 同时只有一次扫描；并发调用共享结果。onProgress 在本次扫描期间接收进度。 */
export async function scanStorage(
  onProgress?: (progress: StorageScanProgress) => void
): Promise<StorageSnapshot> {
  if (onProgress) progressListeners.add(onProgress);
  try {
    if (!currentScan) {
      const run = startScan();
      currentScan = run;
      void run.promise
        .catch(() => undefined)
        .finally(() => {
          if (currentScan === run) currentScan = null;
        });
    }
    return await currentScan.promise;
  } finally {
    if (onProgress) progressListeners.delete(onProgress);
  }
}

export function cancelStorageScan(): void {
  currentScan?.cancel();
  currentScan = null;
}

export function lastStorageSnapshot(): StorageSnapshot | null {
  return lastSnapshot;
}

async function removeFiles(
  category: StorageCategoryId
): Promise<{ freed: number; removed: number; skipped: number; failed: number }> {
  const index = sessionIndex();
  const { targets, skipped } = await runWorker(
    {
      mode: 'collect',
      root: app.getPath('userData'),
      browserDir: browserPartitionDir(),
      refs: index.refs,
      indexReady: index.ready,
      category,
      now: Date.now(),
    },
    (message) => (message.type === 'collect-done' ? message : undefined)
  ).promise;
  let freed = 0;
  let removed = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i += 64) {
    await Promise.all(
      targets.slice(i, i + 64).map(async (target) => {
        try {
          await rm(target.abs, { force: true });
          freed += target.bytes;
          removed += 1;
        } catch {
          failed += 1;
        }
      })
    );
  }
  return { freed, removed, skipped, failed };
}

/** 工具输出按文件清掉后留下的空目录顺带收掉（rmdir 只删空目录） */
async function pruneEmptyToolOutputDirs(): Promise<void> {
  const root = path.join(app.getPath('userData'), 'agent', 'sessions', 'tool-output');
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(names.map((name) => rmdir(path.join(root, name)).catch(() => undefined)));
}

const categoryBytes = (snapshot: StorageSnapshot | null, id: StorageCategoryId) =>
  snapshot?.categories.find((c) => c.id === id)?.bytes ?? 0;

export async function cleanStorage(category: StorageCategoryId): Promise<StorageCleanResult> {
  const before = lastSnapshot;
  let stats = { freed: 0, removed: 0, skipped: 0, failed: 0 };
  switch (category) {
    case 'cache':
      // Chromium 缓存由运行中的进程持有，走 session API；usage-cache 是可重建的解析缓存
      await session.defaultSession.clearCache();
      await session.defaultSession.clearCodeCaches({});
      await rm(path.join(app.getPath('userData'), 'agent', 'usage-cache'), {
        recursive: true,
        force: true,
      });
      break;
    case 'browser': {
      const browser = session.fromPartition(partitionName(app.isPackaged));
      await browser.clearCache();
      await browser.clearStorageData();
      break;
    }
    case 'logs':
    case 'backups':
    case 'coworkers':
      stats = await removeFiles(category);
      break;
    case 'toolOutputs':
      stats = await removeFiles(category);
      await pruneEmptyToolOutputDirs();
      break;
    case 'secretaryImages': {
      // 与启动清理同一套规则：仍被消息引用的不删
      const store = getSecretaryImageStore();
      if (!store) throw new Error('Secretary image store is not ready');
      stats = await store.sweep();
      break;
    }
    case 'secretaryReports': {
      // 只删截图副本，报告文字留着
      const store = getSecretaryReportStore();
      if (!store) throw new Error('Secretary report store is not ready');
      stats = await store.clear();
      break;
    }
    default:
      throw new Error(`Category ${category} is not cleanable`);
  }
  cancelStorageScan();
  const snapshot = await scanStorage();
  const measured = Math.max(0, categoryBytes(before, category) - categoryBytes(snapshot, category));
  return {
    freedBytes: before ? measured : stats.freed,
    removed: stats.removed,
    skipped: stats.skipped,
    failed: stats.failed,
    snapshot,
  };
}

export type ResourceProcessGroup = 'app' | 'agent' | 'child';
/** main/window/browser/gpu/service 归 app；agent 与其子进程归 agent。 */
export type ResourceProcessRole =
  | 'main'
  | 'window'
  | 'browser'
  | 'gpu'
  | 'service'
  | 'agent'
  | 'tool'
  | 'child';

export interface ResourceProcess {
  pid: number;
  name: string;
  group: ResourceProcessGroup;
  role: ResourceProcessRole;
  /** 外部进程的完整命令行 */
  command?: string;
  /** 占整机 CPU 的百分比（0–100）。 */
  cpu: number;
  memory: number;
}

export interface ResourceSnapshot {
  cpu: { app: number; system: number };
  memory: { app: number; system: number; total: number };
  processes: ResourceProcess[];
}

export const STORAGE_CATEGORY_IDS = [
  'sessions',
  'coworkers',
  'toolOutputs',
  'secretaryImages',
  'secretaryReports',
  'memory',
  'models',
  'runtimes',
  'worktrees',
  'snapshots',
  'browser',
  'cache',
  'logs',
  'backups',
  'config',
  'other',
] as const;
export type StorageCategoryId = (typeof STORAGE_CATEGORY_IDS)[number];
export type StorageCleanability = 'none' | 'safe' | 'confirm';

export const STORAGE_CLEANABILITY: Record<StorageCategoryId, StorageCleanability> = {
  sessions: 'none',
  coworkers: 'safe',
  toolOutputs: 'safe',
  secretaryImages: 'safe',
  // 未过期的截图也会删，要确认
  secretaryReports: 'confirm',
  memory: 'none',
  models: 'none',
  runtimes: 'none',
  worktrees: 'none',
  snapshots: 'none',
  browser: 'confirm',
  cache: 'safe',
  logs: 'safe',
  backups: 'confirm',
  config: 'none',
  other: 'none',
};

export function isCleanableStorageCategory(id: unknown): id is StorageCategoryId {
  return (
    typeof id === 'string' &&
    (STORAGE_CATEGORY_IDS as readonly string[]).includes(id) &&
    STORAGE_CLEANABILITY[id as StorageCategoryId] !== 'none'
  );
}

export type StorageRootId = 'data' | 'worktrees';

export interface StorageEntry {
  root: StorageRootId;
  /** 相对所属根目录的 posix 路径 */
  path: string;
  bytes: number;
}

export interface StorageCategory {
  id: StorageCategoryId;
  bytes: number;
  files: number;
  entries: StorageEntry[];
}

export interface StorageVolume {
  total: number;
  free: number;
}

export interface StorageRoot {
  id: StorageRootId;
  path: string;
  bytes: number;
  /** 同一卷上的根共享同一 volumeId */
  volumeId: string;
  volume: StorageVolume | null;
}

export interface StorageSnapshot {
  sessions: SessionStorageEntry[];
  roots: StorageRoot[];
  totalBytes: number;
  categories: StorageCategory[];
  scannedAt: number;
  durationMs: number;
  errorCount: number;
  /** 最多几条不可读路径样例 */
  errors: string[];
}

export interface StorageScanProgress {
  root: StorageRootId;
  files: number;
  bytes: number;
}

export interface StorageCleanResult {
  freedBytes: number;
  removed: number;
  skipped: number;
  failed: number;
  snapshot: StorageSnapshot;
}

export interface PsRow {
  pid: number;
  ppid: number;
  rss: number;
  cpuSeconds: number;
  name: string;
  args?: string;
}

/** ps cputime：mac `M:SS.cc`，linux `[DD-]HH:MM:SS`。 */
export function parseCpuTime(value: string): number | null {
  const m = /^(?:(\d+)-)?(\d+(?::\d+){0,2}(?:\.\d+)?)$/.exec(value.trim());
  if (!m) return null;
  const seconds = m[2].split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  return Number(m[1] ?? 0) * 86400 + seconds;
}

/** 解析 `ps -axo pid=,ppid=,rss=,cputime=,comm=`。 */
export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    const cpuSeconds = m ? parseCpuTime(m[4]) : null;
    if (!m || cpuSeconds === null) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rss: Number(m[3]) * 1024,
      cpuSeconds,
      name: m[5].split('/').pop() || m[5],
    });
  }
  return rows;
}

/** 解析 `ps -axww -o pid=,args=`。 */
export function parsePsArgs(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

const INTERPRETERS = /^(node|bun|deno|python[\d.]*|ruby|perl|php|java)$/;
const LAUNCHERS = /^(npx|bunx|uvx|pnpm|npm|yarn|uv)$/;
const SHELLS = /^(bash|sh|zsh|fish|dash|pwsh|powershell|cmd)$/;
const LABEL_MAX = 80;

const baseName = (value: string) => (value.split(/[\\/]/).pop() || value).replace(/\.exe$/i, '');

/** 可读的进程名：解释器取脚本/模块、启动器取包名、shell 取 -c 命令。 */
export function commandLabel(exe: string, args: string): string {
  const base = baseName(exe);
  const trimmed = args.trim();
  // 去掉命令行里的可执行文件本身（可能带引号或空格）
  let tail: string;
  if (trimmed.startsWith('"')) tail = trimmed.slice(trimmed.indexOf('"', 1) + 1);
  else if (exe.includes('/') && trimmed.startsWith(exe)) tail = trimmed.slice(exe.length);
  else tail = trimmed.replace(/^\S+/, '');
  const tokens = tail.trim().split(/\s+/).filter(Boolean);
  const key = base.toLowerCase();
  if (SHELLS.test(key)) {
    const flag = tokens.findIndex((t) => /^(-\w*c|\/c|-command)$/i.test(t));
    if (flag < 0) return base;
    const cmd = tokens.slice(flag + 1).join(' ');
    const label = `${base}: ${cmd}`;
    return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX)}…` : label;
  }
  if (INTERPRETERS.test(key)) {
    const target = tokens.find((t, i) => !t.startsWith('-') || tokens[i - 1] === '-m');
    const moduleIndex = tokens.indexOf('-m');
    const pick = moduleIndex >= 0 ? tokens[moduleIndex + 1] : target;
    return pick ? `${base} ${baseName(pick)}` : base;
  }
  if (LAUNCHERS.test(key)) {
    const pkg = tokens.find(
      (t) => !t.startsWith('-') && !['dlx', 'exec', 'x', 'run', 'tool'].includes(t)
    );
    return pkg ? `${base} ${pkg}` : base;
  }
  return base;
}

/** 解析 `Get-CimInstance Win32_Process | ConvertTo-Json`；时间单位 100ns。 */
export function parseWinProcesses(json: string): PsRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const rows: PsRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const pid = int(v.ProcessId);
    const ppid = int(v.ParentProcessId);
    if (pid === undefined || ppid === undefined) continue;
    const name = typeof v.Name === 'string' ? v.Name : String(pid);
    rows.push({
      pid,
      ppid,
      rss: int(v.WorkingSetSize) ?? 0,
      cpuSeconds: ((int(v.UserModeTime) ?? 0) + (int(v.KernelModeTime) ?? 0)) / 1e7,
      name,
      args: typeof v.CommandLine === 'string' && v.CommandLine ? v.CommandLine : name,
    });
  }
  return rows;
}

export interface ChromiumPidKinds {
  main: ReadonlySet<number>;
  browser: ReadonlySet<number>;
}

export const AGENT_SERVICE_NAME = 'enso-agent-worker';

export function chromiumRole(
  metric: { pid: number; type: string; serviceName?: string; name?: string },
  kinds: ChromiumPidKinds
): ResourceProcessRole {
  if (metric.serviceName === AGENT_SERVICE_NAME || metric.name === AGENT_SERVICE_NAME) {
    return 'agent';
  }
  if (metric.type === 'Browser') return 'main';
  if (metric.type === 'GPU') return 'gpu';
  if (metric.type === 'Tab') return kinds.browser.has(metric.pid) ? 'browser' : 'window';
  return 'service';
}

export function descendantPids(
  rows: ReadonlyArray<{ pid: number; ppid: number }>,
  roots: Iterable<number>
): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const rootSet = new Set(roots);
  const result = new Set<number>();
  const stack = [...rootSet];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop() as number) ?? []) {
      if (rootSet.has(child) || result.has(child)) continue;
      result.add(child);
      stack.push(child);
    }
  }
  return result;
}

export function cpuPercent(
  prevSeconds: number,
  nextSeconds: number,
  elapsedMs: number,
  cores: number
): number {
  if (elapsedMs <= 0 || cores <= 0) return 0;
  const pct = ((nextSeconds - prevSeconds) * 1000 * 100) / (elapsedMs * cores);
  return Math.min(100, Math.max(0, pct));
}

const CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Shared Dictionary',
  'agent/usage-cache',
];
const LOG_DIRS = ['agent/pi-agent/task-logs'];
const MODEL_DIRS = ['memory/models', 'memory/chat-models'];
const RUNTIME_DIRS = ['llama-gpu-backends', 'agent/pi-agent/bin', 'agent/pi-agent/rtk'];
const MEMORY_DIRS = ['memory', 'agent/pi-agent/memories'];
const SESSION_DIRS = ['agent/sessions', 'agent/usage-ledger', 'agent/source-registry.json'];
const CONFIG_DIRS = ['instructions', 'system-prompts', 'agent/workflows', 'agent/pi-agent/ssh'];
export const TOOL_OUTPUT_REL = 'agent/sessions/tool-output';
export const SECRETARY_IMAGES_REL = 'bot-chats/secretary-images';
export const SECRETARY_REPORTS_REL = 'secretary-reports';

function underAny(rel: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

/** rel 为相对 userData 的 posix 路径；browserDir 为浏览器分区目录的相对路径。 */
export function classifyStoragePath(rel: string, browserDir: string): StorageCategoryId {
  if (underAny(rel, CACHE_DIRS)) return 'cache';
  if (underAny(rel, [browserDir])) return 'browser';
  if (underAny(rel, [TOOL_OUTPUT_REL])) return 'toolOutputs';
  if (/^agent\/sessions\/enso-[^/]*__cw-[^/]*$/.test(rel)) return 'coworkers';
  if (underAny(rel, [SECRETARY_IMAGES_REL])) return 'secretaryImages';
  if (underAny(rel, [SECRETARY_REPORTS_REL])) return 'secretaryReports';
  // Chromium 的 leveldb 也用 .log 作 WAL，只认我们自己写的日志
  const ownLog = rel.endsWith('.log') && (!rel.includes('/') || rel.startsWith('agent/'));
  if (underAny(rel, LOG_DIRS) || ownLog) return 'logs';
  const ownFile = !rel.includes('/') || rel.startsWith('agent/');
  if (ownFile && /\.bak(?:$|[-.])/.test(rel.split('/').pop() ?? '')) return 'backups';
  if (underAny(rel, MODEL_DIRS)) return 'models';
  if (underAny(rel, RUNTIME_DIRS)) return 'runtimes';
  if (underAny(rel, MEMORY_DIRS)) return 'memory';
  if (underAny(rel, SESSION_DIRS)) return 'sessions';
  if (underAny(rel, ['worktrees'])) return 'worktrees';
  if (underAny(rel, ['changes-snapshots'])) return 'snapshots';
  if (
    underAny(rel, CONFIG_DIRS) ||
    (!rel.includes('/') && rel.endsWith('.json')) ||
    /^agent\/(?:pi-agent\/)?[^/]+\.json$/.test(rel)
  ) {
    return 'config';
  }
  return 'other';
}

export interface CleanCandidateFile {
  rel: string;
  abs: string;
  bytes: number;
  mtimeMs: number;
}

export const RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * 按文件清理的类别选目标：一律保留 24h 内写过的；工具输出 / coworker 记录只删已无会话归属的，
 * 会话索引不可用时整类跳过，避免把活会话的文件当孤儿删掉。
 */
export function pickCleanTargets(
  files: readonly CleanCandidateFile[],
  options: {
    category: StorageCategoryId;
    now: number;
    owner: (rel: string) => string | undefined;
    classify: (rel: string) => StorageCategoryId;
    indexReady: boolean;
  }
): { targets: { abs: string; bytes: number }[]; skipped: number } {
  const orphanOnly = options.category === 'toolOutputs' || options.category === 'coworkers';
  const cutoff = options.now - RECENT_MS;
  const targets: { abs: string; bytes: number }[] = [];
  let skipped = 0;
  for (const file of files) {
    if (options.classify(file.rel) !== options.category) continue;
    const keep =
      file.mtimeMs >= cutoff ||
      (orphanOnly && (!options.indexReady || options.owner(file.rel) !== undefined));
    if (keep) skipped += 1;
    else targets.push({ abs: file.abs, bytes: file.bytes });
  }
  return { targets, skipped };
}

export function storageEntryKey(rel: string): string {
  return rel.split('/').slice(0, 2).join('/');
}

export interface SessionStorageEntry {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  archived: boolean;
  pinned: boolean;
  archivedAt?: number;
  lastActiveAt: number;
  bytes: number;
}

export type SessionCleanRequest =
  | { kind: 'stale'; days: number; includeUnarchived: boolean; projectId?: string }
  | { kind: 'one'; id: string };

export const SESSION_CLEAN_DAYS = [7, 15, 30] as const;

export function parseSessionCleanRequest(input: unknown): SessionCleanRequest | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = input as Record<string, unknown>;
  if (value.kind === 'one') {
    return typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200
      ? { kind: 'one', id: value.id }
      : null;
  }
  if (value.kind !== 'stale') return null;
  const { days, includeUnarchived, projectId } = value;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 36_500) return null;
  if (typeof includeUnarchived !== 'boolean') return null;
  if (projectId === undefined) return { kind: 'stale', days, includeUnarchived };
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 200)
    return null;
  return { kind: 'stale', days, includeUnarchived, projectId };
}

export interface SessionCleanCandidate {
  id: string;
  projectId?: string;
  archived?: boolean;
  archivedAt?: number;
  pinned?: boolean;
  lastActiveAt: number;
}

/** 与侧栏「清理归档」同语义；includeUnarchived 追加超期未置顶的普通会话。days=0 为全部；projectId 限定项目。 */
export function sessionCleanIds(
  items: readonly SessionCleanCandidate[],
  request: SessionCleanRequest,
  now: number
): string[] {
  if (request.kind === 'one') return items.some((i) => i.id === request.id) ? [request.id] : [];
  const cutoff = now - request.days * 86_400_000;
  return items
    .filter(
      (item) =>
        (request.projectId === undefined || item.projectId === request.projectId) &&
        (item.archived
          ? (item.archivedAt ?? item.lastActiveAt) <= cutoff
          : request.includeUnarchived && !item.pinned && item.lastActiveAt <= cutoff)
    )
    .map((item) => item.id);
}

export interface SessionFileRef {
  id: string;
  parentId?: string;
  /** 相对 userData 的 posix 路径 */
  sessionRel?: string;
  worktreeRel?: string;
}

const SESSIONS_DIR = 'agent/sessions/';
const TOOL_OUTPUT_DIR = `${SESSIONS_DIR}tool-output/`;

/** 把 userData 内的文件归到所属根会话（coworker 归父会话）。 */
export function sessionStorageOwner(
  refs: readonly SessionFileRef[]
): (rel: string) => string | undefined {
  const bySession = new Map<string, string>();
  const worktrees: [string, string][] = [];
  const roots = new Set<string>();
  const coworkerPrefix = new Map<string, string>();
  for (const ref of refs) {
    const owner = ref.parentId ?? ref.id;
    if (ref.sessionRel) bySession.set(ref.sessionRel, owner);
    if (ref.worktreeRel) worktrees.push([`${ref.worktreeRel}/`, owner]);
    if (!ref.parentId) {
      roots.add(ref.id);
      // 与 sessionFileCleanup 的 coworker journal 命名一致
      coworkerPrefix.set(`enso-${`${ref.id}::cw-`.replace(/[^A-Za-z0-9._-]/g, '_')}`, ref.id);
    }
  }
  const toolOwner = new Map<string, string | undefined>();
  return (rel) => {
    const direct = bySession.get(rel);
    if (direct) return direct;
    if (rel.startsWith(TOOL_OUTPUT_DIR)) {
      const seg = rel.slice(TOOL_OUTPUT_DIR.length).split('/')[0] ?? '';
      if (!toolOwner.has(seg)) {
        const root = [...roots].find(
          (id) => seg === id || seg.startsWith(`${id}-`) || seg.startsWith(`${id}::`)
        );
        toolOwner.set(seg, root);
      }
      return toolOwner.get(seg);
    }
    if (rel.startsWith(SESSIONS_DIR) && !rel.slice(SESSIONS_DIR.length).includes('/')) {
      for (const [prefix, id] of coworkerPrefix) {
        if (rel.startsWith(SESSIONS_DIR + prefix)) return id;
      }
      return undefined;
    }
    const snapshot = /^changes-snapshots\/([^/]+)\.json$/.exec(rel)?.[1];
    if (snapshot) return roots.has(snapshot) ? snapshot : undefined;
    return worktrees.find(([prefix]) => rel.startsWith(prefix))?.[1];
  };
}

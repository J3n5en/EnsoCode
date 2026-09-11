import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ChildSessionIdentity, SessionIdentity } from '@shared/builtinAgents';
import { normalizeMemoryModelIdleMinutes } from '@shared/memory/modelIdle';
import type { MemoryOp } from '@shared/types/agent';
import { hasProviderCredentials, type ModelProvider } from '@shared/types/llm';
import type Database from 'better-sqlite3';
import { app } from 'electron';
import { holdLocalChat, syncLocalChatFromSettings } from './llama/chat';
import { executeMemoryOp } from './memory/bridge';
import { openMemoryDb } from './memory/db';
import {
  buildTranscript,
  type Complete,
  type DistillJob,
  type DistillPayload,
  distillFingerprint,
  ensureDistillJob,
  listDistillJobs,
  listResumableDistillJobs,
  runDistillJob,
  type TranscriptMessage,
} from './memory/distill';
import { type DownloadProgress, downloadModel, isModelReady } from './memory/embedding/downloader';
import { createEmbeddingProvider, toEmbedder } from './memory/embedding/provider';
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  embeddingModelDirName,
  resolveEmbeddingModelSpec,
} from './memory/embedding/registry';
import type { RemoteEmbeddingOptions } from './memory/embedding/remote';
import type { EmbeddingModelSpec, EmbeddingProvider } from './memory/embedding/types';
import { ensureKgJob, type KgJob, listKgJobs, listResumableKgJobs, runKgJob } from './memory/kg';
import { getReembedJob, type ReembedJob, runReembedJob } from './memory/reembed';
import { type Embedder, GLOBAL_SPACE, type Memory, projectSpaceId } from './memory/types';

// electron 只出现在这层接线：services/memory/* 保持纯 Node 以便测试注入路径
let db: Database.Database | null = null;

export interface MemoryEmbeddingConfig {
  /** 注册表 id；`none` 纯 FTS。默认 potion-multilingual-128M */
  modelId: string;
  /**
   * 模型未就绪时是否后台下载；下载期间检索降级纯 FTS，完成后自动接入。
   * 默认关：默认模型约 530MB，没有进度 UI 前不能在一次 memory_search 里静默拉起；由设置页显式开启。
   */
  autoDownload: boolean;
  onProgress?: (p: DownloadProgress) => void;
  /** `remote:*` 模型的凭证解析：由接线层从既有 ModelProvider（baseUrl/apiKey）取，这里不新增 key 存储 */
  remoteCredentials?: () => RemoteEmbeddingOptions | null;
}

let config: MemoryEmbeddingConfig = { modelId: DEFAULT_EMBEDDING_MODEL_ID, autoDownload: false };
let provider: EmbeddingProvider | null = null;
let embedder: Embedder | null = null;
/**
 * 最近一次 embedding 失败的原因。整条链路以前是 `.catch(() => null)` 全吞，
 * 表现成「向量数一直是 0，点补齐没反应」而无从排查——把它留下来给设置页显示。
 */
let lastEmbeddingError: string | null = null;
// 只缓存本代订阅；文件互斥与取消由 downloader 的同目录共享任务负责。
let download: Promise<void> | null = null;
// provider 构造是异步的（GGUF 加载 / 建 context）；失败后置 null 让下次调用重试
let providerInit: Promise<Embedder | null> | null = null;
let embeddingGeneration = 0;
let embeddingClose: Promise<void> = Promise.resolve();
let memoryModelIdleMinutes = 10;

function invalidateMemoryEmbedding(): void {
  embeddingGeneration += 1;
  reembedAbort?.abort();
  const previous = provider;
  const previousInit = providerInit;
  const previousClose = embeddingClose;
  provider = null;
  embedder = null;
  providerInit = null;
  download = null;
  lastEmbeddingError = null;
  const closing = (async () => {
    await previous?.close?.();
  })();
  embeddingClose = Promise.allSettled([previousClose, previousInit, closing]).then(() => {});
}

export function awaitMemoryEmbeddingClose(): Promise<void> {
  return embeddingClose;
}

/**
 * 设置层调用；切换模型立即作用于之后的写入/查询，旧向量由后台滚动重嵌（持久化 jobs 表，可中断续跑）；
 * 重嵌完成前旧行仍能由 FTS 搜到。任何配置变化都重新调度：没有待处理行时 ensureReembedJob 是空操作。
 */
export function configureMemoryEmbedding(next: Partial<MemoryEmbeddingConfig>): void {
  config = { ...config, ...next };
  invalidateMemoryEmbedding();
  scheduleReembed();
}

/** settings.json 的 state 按 unknown 收窄；非法 id 回默认模型，按实际凭证去重（API key 不离开 Main） */
export function syncMemoryEmbeddingFromSettings(state: Record<string, unknown>): void {
  memoryModelIdleMinutes = normalizeMemoryModelIdleMinutes(state.memoryModelIdleMinutes);
  syncLocalChatFromSettings({ ...state, memoryModelIdleMinutes });
  provider?.setIdleMinutes?.(memoryModelIdleMinutes);
  const rawModel = state.memoryEmbeddingModel;
  const modelId =
    typeof rawModel === 'string' && resolveEmbeddingModelSpec(rawModel)
      ? rawModel
      : DEFAULT_EMBEDDING_MODEL_ID;
  const autoDownload = state.memoryEmbeddingAutoDownload === true;
  const providerId =
    typeof state.memoryEmbeddingRemoteProviderId === 'string'
      ? state.memoryEmbeddingRemoteProviderId
      : null;
  const providers = Array.isArray(state.providers) ? (state.providers as unknown[]) : [];
  const remoteCredentials = (): RemoteEmbeddingOptions | null => {
    const p = providers.find(
      (x): x is ModelProvider =>
        Boolean(x) && typeof x === 'object' && (x as ModelProvider).id === providerId
    );
    if (!p || typeof p.baseUrl !== 'string' || !hasProviderCredentials(p) || !p.apiKey) return null;
    return { baseUrl: p.baseUrl, apiKey: p.apiKey };
  };
  const credentials = remoteCredentials();
  const previous = config.remoteCredentials?.();
  const sameCredentials =
    resolveEmbeddingModelSpec(modelId)?.runtime !== 'openai-compatible' ||
    (credentials?.baseUrl === previous?.baseUrl && credentials?.apiKey === previous?.apiKey);
  // 保存值快照而非 providers 引用：原地编辑也能识别变更，且无关设置不释放本地大模型。
  const next = { modelId, autoDownload, remoteCredentials: () => credentials };
  if (modelId === config.modelId && autoDownload === config.autoDownload && sameCredentials) {
    config = { ...config, ...next };
    return;
  }
  configureMemoryEmbedding(next);
}

function memoryRoot(): string {
  return path.join(app.getPath('userData'), 'memory');
}

function memoryDb(): Database.Database {
  if (!db) {
    db = openMemoryDb(path.join(memoryRoot(), 'memory.db'));
    // 上次进程退出时可能留下 pending 任务，或有旧行从未拿到当前模型的向量；开库后统一调度
    scheduleReembed();
    resumeMemoryDistill();
    resumeMemoryKg();
  }
  return db;
}

/**
 * LLM 后台任务（蒸馏 / KG 抽取）共用一条 FIFO 串行链：同一时刻只有一个后台 LLM 调用，先到先跑，
 * 两类任务不会互相饿死也不会同时打满 provider。重嵌走独立链（embedder 资源，逐行短事务）。
 */
let llmJobRun: Promise<void> = Promise.resolve();
const enqueueLlmJob = (task: () => Promise<void>): Promise<void> => {
  const release = holdLocalChat();
  const run = llmJobRun
    .then(task)
    .catch(() => {})
    .finally(release);
  llmJobRun = run;
  return run;
};

// ---------------------------------------------------------------------------
// 会话结束后的异步蒸馏。任务落 memory_jobs，重启后续跑；任何失败只吞掉，不影响会话本身。
// ---------------------------------------------------------------------------

export interface MemoryDistillConfig {
  /** 独立开关：只想手动记忆的用户保持关闭；缺省关 */
  enabled: boolean;
  /**
   * 一次性文本补全的获取器；worker 不在线 / 没有可用模型时返回 null，任务保留 pending 等下次机会。
   * 由接线层（ipc/agent）注入，模型与凭证由 Main 从设置自读。
   */
  complete: (() => Complete | null | Promise<Complete | null>) | null;
  /** 从权威 jsonl 读出对话；缺省用 pi SessionManager，测试注入 */
  readTranscript: (sessionFile: string) => Promise<TranscriptMessage[]>;
  /** 记忆输出语言（settings.memoryLanguage）；缺省英文 */
  language: string;
}

let distillConfig: MemoryDistillConfig = {
  enabled: false,
  complete: null,
  readTranscript: readSessionTranscript,
  language: 'en',
};

export function configureMemoryDistill(next: Partial<MemoryDistillConfig>): void {
  distillConfig = { ...distillConfig, ...next };
}

export function syncMemoryDistillFromSettings(state: Record<string, unknown>): void {
  configureMemoryDistill({
    enabled: state.memoryDistillEnabled === true,
    language: typeof state.memoryLanguage === 'string' ? state.memoryLanguage : 'en',
  });
}

/** 缺省读取器：与 readParentHistoryTail 同源（SessionManager 当前分支），只取 user/assistant 的文本片段 */
async function readSessionTranscript(sessionFile: string): Promise<TranscriptMessage[]> {
  const sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions');
  const root = path.resolve(sessionDir);
  const resolved = path.resolve(sessionFile);
  if (!resolved.startsWith(`${root}${path.sep}`)) return [];
  const [{ SessionManager, sessionEntryToContextMessages }, { projectMessage }] = await Promise.all(
    [import('@earendil-works/pi-coding-agent'), import('../../agent/projection')]
  );
  const branch = SessionManager.open(resolved, sessionDir).getBranch();
  const out: TranscriptMessage[] = [];
  for (const raw of branch.flatMap(sessionEntryToContextMessages)) {
    const m = projectMessage(raw);
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    if (text.trim()) out.push({ role: m.role, text });
  }
  return out;
}

/**
 * 会话结束 / 闲置回收时调用。读权威 jsonl → 打码拼接 → 建幂等任务（同会话同内容只一次）→ 后台跑。
 * 开关关闭直接返回，不建库也不建任务。绝不抛。
 */
export function scheduleMemoryDistill(payload: DistillPayload): Promise<void> {
  if (!distillConfig.enabled) return Promise.resolve();
  return runDistill(payload);
}

/**
 * 设置页手动提炼：**绕过 memoryDistillEnabled**。自动开关只决定「会话结束时要不要自己跑」，
 * 用户显式点击本身就是意图；否则开关打开前的历史会话永远无法被提炼，冷启动库总是空的。
 * 返回是否真的跑了一轮（同会话同内容已提炼过会被指纹跳过）。
 */
export async function distillSessionNow(
  payload: DistillPayload,
  opts: { force?: boolean } = {}
): Promise<boolean> {
  const overallStartedAt = performance.now();
  let started = false;
  await runDistill(
    payload,
    () => {
      started = true;
    },
    opts.force,
    true
  );
  console.info('[memory-distill] manual overall', {
    sessionId: payload.sessionId,
    durationMs: Math.round(performance.now() - overallStartedAt),
    started,
  });
  return started;
}

function runDistill(
  payload: DistillPayload,
  onStarted?: () => void,
  force?: boolean,
  manual = false
): Promise<void> {
  const queuedAt = performance.now();
  return enqueueLlmJob(async () => {
    if (manual)
      console.info('[memory-distill] manual background queue wait', {
        sessionId: payload.sessionId,
        durationMs: Math.round(performance.now() - queuedAt),
      });
    const messages = await distillConfig.readTranscript(payload.sessionFile);
    const transcript = buildTranscript(messages);
    if (!transcript) return;
    // 语言写进 payload 并进指纹：改完语言再提炼不会被当成「已提炼」跳过，
    // 续跑旧任务时也用它自己的语言复算，不受之后的设置变更影响
    const stamped = { ...payload, language: distillConfig.language };
    const job = ensureDistillJob(
      memoryDb(),
      stamped,
      distillFingerprint(stamped.sessionId, transcript, stamped.language),
      { force }
    );
    if (!job) return;
    onStarted?.();
    await runOneDistill(job, transcript);
  });
}

async function runOneDistill(job: DistillJob, transcript: string): Promise<void> {
  const complete = await distillConfig.complete?.();
  if (!complete || !db) return;
  // 项目会话蒸馏进项目 space，与 memory_capture 的缺省归属一致
  await runDistillJob(db, job, {
    transcript,
    complete,
    embedder: await memoryEmbedder(),
    spaceId: job.payload.projectId ? projectSpaceId(job.payload.projectId) : GLOBAL_SPACE,
    onCreated: onMemoryCreated,
  });
  // 一条都没写入时（全部低重要度 / 撞去重）也要通知：任务状态和丢弃原因变了
  notifyMemoryChanged();
}

/** 开库时把上次没跑完的任务接上（pending / 半路 running）；内容已变的由 runDistillJob 标 cancelled */
function resumeMemoryDistill(): void {
  if (!distillConfig.enabled || !db) return;
  const jobs = listResumableDistillJobs(db);
  if (jobs.length === 0) return;
  void enqueueLlmJob(async () => {
    for (const job of jobs) {
      try {
        const transcript = buildTranscript(
          await distillConfig.readTranscript(job.payload.sessionFile)
        );
        await runOneDistill(job, transcript);
      } catch {
        /* 单个任务失败不影响其余 */
      }
    }
  });
}

/** 设置页出口：最近蒸馏任务及逐条丢弃原因；库未打开不为此建库 */
export function getMemoryDistillJobs(limit?: number): DistillJob[] {
  return db ? listDistillJobs(db, limit) : [];
}

/** 等后台蒸馏收尾（测试 / 退出前用）；与 KG 共链，所以也等到排在前面的 KG 任务 */
export async function awaitMemoryDistill(): Promise<void> {
  await awaitLlmJobs();
}

// 任务跑完可能又排了新任务（蒸馏写入 → KG 排队），循环到链真正空闲
async function awaitLlmJobs(): Promise<void> {
  let seen: Promise<void>;
  do {
    seen = llmJobRun;
    await seen;
  } while (seen !== llmJobRun);
}

// ---------------------------------------------------------------------------
// 记忆创建后的异步实体抽取。任务落 memory_jobs(kind='kg')，重启后续跑；绝不进 create 热路径。
// ---------------------------------------------------------------------------

export interface MemoryKgConfig {
  /** 独立开关（设置 memoryKgEnabled），缺省关；与蒸馏开关无联动 */
  enabled: boolean;
  /** 与蒸馏同源的一次性补全获取器；接线层不单独注入时回落到 distillConfig.complete */
  complete: (() => Complete | null | Promise<Complete | null>) | null;
}

let kgConfig: MemoryKgConfig = { enabled: false, complete: null };

export function configureMemoryKg(next: Partial<MemoryKgConfig>): void {
  kgConfig = { ...kgConfig, ...next };
}

export function syncMemoryKgFromSettings(state: Record<string, unknown>): void {
  configureMemoryKg({ enabled: state.memoryKgEnabled === true });
}

/**
 * 记忆库发生写入时通知界面。由接线层注入（Main 不直接依赖 BrowserWindow）：
 * 不这么做的话，agent 通过工具写记忆时设置页完全不会刷新，只能靠用户手动关开。
 */
let onMemoryChanged: (() => void) | null = null;

export function setMemoryChangeListener(listener: (() => void) | null): void {
  onMemoryChanged = listener;
}

/**
 * 合并窗口：批量提炼会连续写很多条记忆、排很多个 KG 任务，
 * 每次都广播会让渲染层反复重算整张图谱。只取 trailing 边，
 * 保证「最后一次写入之后」一定有一次通知。
 */
const CHANGE_NOTIFY_DEBOUNCE_MS = 150;
let changeNotifyTimer: NodeJS.Timeout | null = null;

/** 写入路径统一从这里通知；失败不能影响写入本身 */
export function notifyMemoryChanged(): void {
  if (changeNotifyTimer) return;
  changeNotifyTimer = setTimeout(() => {
    changeNotifyTimer = null;
    try {
      onMemoryChanged?.();
    } catch {}
  }, CHANGE_NOTIFY_DEBOUNCE_MS);
  // 不让这个定时器拖住进程退出
  changeNotifyTimer.unref?.();
}

/** createMemory 的 onCreated hook：只排队，不在这里调 LLM；开关关闭时连任务都不建 */
function onMemoryCreated(memory: Memory): void {
  notifyMemoryChanged();
  if (!kgConfig.enabled || !db) return;
  const job = ensureKgJob(db, memory.id);
  if (job) void enqueueLlmJob(() => runOneKg(job));
}

async function runOneKg(job: KgJob): Promise<void> {
  const complete = await (kgConfig.complete ?? distillConfig.complete)?.();
  if (!complete || !db) return;
  await runKgJob(db, job, { complete });
  // 图谱数据是这一步才落库的。记忆写入时那次通知发生在抽取之前，
  // 界面当时刷新也看不到实体；不在这里再通知一次，图谱就永远是空的。
  notifyMemoryChanged();
}

/** 开库时把上次没跑完的抽取接上；内容已变 / 已删除的由 runKgJob 标 cancelled */
function resumeMemoryKg(): void {
  if (!kgConfig.enabled || !db) return;
  const jobs = listResumableKgJobs(db);
  if (jobs.length === 0) return;
  void enqueueLlmJob(async () => {
    for (const job of jobs) await runOneKg(job);
  });
}

/** 设置页出口；库未打开不为此建库 */
export function getMemoryKgJobs(limit?: number): KgJob[] {
  return db ? listKgJobs(db, limit) : [];
}

/** 等后台 KG 抽取收尾（测试 / 退出前用） */
export async function awaitMemoryKg(): Promise<void> {
  await awaitLlmJobs();
}

let reembedAbort: AbortController | null = null;
let reembedRun: Promise<void> | null = null;

// 后台重嵌：同时只跑一份，再次触发先打断前一份（它会把任务回到 pending，下一份接着跑）。
// 触发点：配置变化、开库、embedder 首次就绪、模型下载完成（3b Major 2：只在切模型时触发会让
// “先有记忆、后启用 embedding”的旧行永远拿不到向量）。embedder 未就绪（模型未下载 / none）则不建任务；
// 任何失败都吞掉，不影响前台读写
function scheduleReembed(): void {
  reembedAbort?.abort();
  const ac = new AbortController();
  reembedAbort = ac;
  const prev = reembedRun ?? Promise.resolve();
  reembedRun = prev
    .then(async () => {
      if (ac.signal.aborted) return;
      if (!db) {
        lastEmbeddingError = 'memory database is not open yet';
        return;
      }
      const e = await memoryEmbedder();
      if (!e || ac.signal.aborted || !db) return;
      const job = await runReembedJob(db, e, { signal: ac.signal });
      if (ac.signal.aborted) return;
      // 任务层自己把逐行失败吞进 failed 计数，这里把它提上来
      lastEmbeddingError =
        job?.error ?? (job && job.failed > 0 ? `${job.failed} rows failed` : null);
    })
    .catch((error: unknown) => {
      if (!ac.signal.aborted) {
        lastEmbeddingError = error instanceof Error ? error.message : String(error);
      }
    })
    .finally(() => {
      if (reembedAbort === ac) reembedAbort = null;
    });
}

// embedder 就绪 / 下载完成时调用；已有调度在等它就绪时不重复调度（否则会把那份打断后再重跑）
function scheduleReembedIfIdle(): void {
  if (!reembedAbort) scheduleReembed();
}

/**
 * 设置页手动下载 / 删除模型后调用（memoryModels 那条路径不经过本模块的 autoDownload）。
 * 丢掉 provider 缓存让下次解析重新探测磁盘；库文件已存在就顺带打开，
 * 否则 memoryHost 的 db 一直是 null（它只在 agent 用记忆时才懒开），重嵌永远不会跑。
 */
export function refreshMemoryEmbedding(opts: { reembed?: boolean } = {}): void {
  invalidateMemoryEmbedding();
  // 删除模型仅失效缓存；主动重嵌会在 autoDownload 开启时立即把它下回来。
  if (opts.reembed === false) return;
  if (!db && existsSync(path.join(memoryRoot(), 'memory.db'))) memoryDb();
  scheduleReembed();
}

/** 设置页轮询用；库未打开时不为此建库 */
export function getMemoryReembedProgress(): ReembedJob | null {
  return db ? getReembedJob(db) : null;
}

/** 等当前后台重嵌收尾（测试 / 退出前用）；没有在跑的立即返回 */
export async function awaitMemoryReembed(): Promise<void> {
  // 重嵌结束时可能又被就绪钩子调度了一轮，循环到真正空闲
  while (reembedAbort) await reembedRun;
  await reembedRun;
}

/**
 * 知识视图（解读 / 结晶）的一次性补全；复用提炼那条模型链。
 * worker 不在线 / 没有可用模型时返回 null，由调用方告诉用户，不静默失败。
 */
export async function getMemoryCompletion(): Promise<Complete | null> {
  return (await (kgConfig.complete ?? distillConfig.complete)?.()) ?? null;
}

/** 解读 / 结晶要写库，走与 agent 同一个连接（同一进程内串行） */
export function memoryDatabase(): Database.Database {
  return memoryDb();
}

/** 记忆输出语言，给解读 / 结晶的提示词用 */
export function memoryLanguage(): string {
  return distillConfig.language;
}

/** 管理页语义搜索用；未就绪返回 null，调用方自行降级，不在这里触发下载 */
export function getMemoryEmbedder(): Promise<Embedder | null> {
  return memoryEmbedder();
}

/** 设置页出口：为什么没有向量。null = 没出过错（可能只是模型没下载） */
export function getMemoryEmbeddingError(): string | null {
  return lastEmbeddingError;
}

// embedding 任何环节失败都只让 embedder 为 null（§12：不得阻止落库），绝不向调用方抛错
async function memoryEmbedder(): Promise<Embedder | null> {
  if (embedder) return embedder;
  if (providerInit) return providerInit;
  const spec = resolveEmbeddingModelSpec(config.modelId);
  if (!spec) {
    lastEmbeddingError = `unknown embedding model: ${config.modelId}`;
    return null;
  }
  if (spec.runtime === 'none') {
    lastEmbeddingError = null;
    return null;
  }
  const generation = embeddingGeneration;
  const dir = path.join(memoryRoot(), 'models', embeddingModelDirName(spec));
  if (spec.files.length > 0 && !isModelReady(dir, spec)) {
    lastEmbeddingError = config.autoDownload ? 'model is downloading' : 'model is not downloaded';
    if (config.autoDownload && !download) {
      const onProgress = config.onProgress;
      const pending = downloadModel(spec, dir, {
        onProgress: (progress) => {
          if (generation === embeddingGeneration) onProgress?.(progress);
        },
      })
        // 下载完成就能给已有记忆补向量，不等下一次前台读写
        .then(() => {
          if (generation === embeddingGeneration) scheduleReembedIfIdle();
        })
        .catch(() => {})
        .finally(() => {
          if (download === pending) download = null;
        });
      download = pending;
    }
    return null;
  }
  const init = createEmbeddingProvider(spec, {
    modelDir: dir,
    remote: remoteOptions(spec),
    idleMinutes: memoryModelIdleMinutes,
  })
    .then(async (p) => {
      if (generation !== embeddingGeneration) {
        await p?.close?.();
        return null;
      }
      p?.setIdleMinutes?.(memoryModelIdleMinutes);
      provider = p;
      embedder = p ? toEmbedder(p) : null;
      lastEmbeddingError = p ? null : 'embedding provider could not be created';
      if (embedder) scheduleReembedIfIdle();
      return embedder;
    })
    .catch((error: unknown) => {
      if (generation === embeddingGeneration) {
        lastEmbeddingError = error instanceof Error ? error.message : String(error);
      }
      return null;
    })
    .finally(() => {
      if (providerInit === init) providerInit = null;
    });
  providerInit = init;
  return init;
}

function remoteOptions(spec: EmbeddingModelSpec): RemoteEmbeddingOptions | undefined {
  if (spec.runtime !== 'openai-compatible') return undefined;
  return config.remoteCredentials?.() ?? undefined;
}

export function closeMemoryDb(): void {
  invalidateMemoryEmbedding();
  reembedAbort = null;
  db?.close();
  db = null;
}

/** 子会话（coworker `${parentId}::cw-x` / enso child）归属父会话所在项目。 */
export function rootSessionId(identity: SessionIdentity | ChildSessionIdentity): string {
  const parent = (identity as ChildSessionIdentity).parent?.sessionId;
  const id = parent ?? identity.sessionId;
  const sep = id.indexOf('::');
  return sep === -1 ? id : id.slice(0, sep);
}

export async function invokeMemory(
  op: MemoryOp,
  params: unknown,
  projectId: string | null
): Promise<unknown> {
  return executeMemoryOp(memoryDb(), op, params, {
    projectId,
    embedder: await memoryEmbedder(),
    onCreated: onMemoryCreated,
    complete: () => getMemoryCompletion(),
  });
}

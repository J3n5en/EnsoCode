import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import type { ChildSessionIdentity, SessionIdentity } from '@shared/builtinAgents';
import { normalizeLocale, translate } from '@shared/i18n';
import type { UnitType } from '@shared/memory/constants';
import { normalizeMemoryDistillWindowMinutes } from '@shared/memory/distillWindow';
import {
  DEFAULT_FORGETTING_SETTINGS,
  type ForgettingSettings,
  normalizeForgettingSettings,
} from '@shared/memory/forgetting';
import { normalizeMemoryModelIdleMinutes } from '@shared/memory/modelIdle';
import { remoteEmbeddingIssue, remoteEmbeddingIssueMessage } from '@shared/memory/remoteEmbedding';
import { effectiveDisabledBuiltinTools } from '@shared/types';
import type { MemoryOp } from '@shared/types/agent';
import type { ModelProvider } from '@shared/types/llm';
import type Database from 'better-sqlite3';
import { holdLocalChat, syncLocalChatFromSettings } from './llama/chat';
import { appendMemoryAudit } from './memory/audit';
import { executeMemoryOp } from './memory/bridge';
import { openMemoryDb } from './memory/db';
import {
  buildTranscript,
  type Complete,
  type DistillBatchMember,
  type DistillJob,
  type DistillPayload,
  distillFingerprint,
  ensureDistillJob,
  lastDistillWatermark,
  listDistillJobs,
  listResumableDistillJobs,
  runDistillJob,
  sliceTranscript,
  type TranscriptMessage,
} from './memory/distill';
import {
  buildBatchTranscript,
  claimDistillQueue,
  type DistillUnit,
  distillUnits,
  dueDistillGroups,
  enqueueDistill,
  nextDistillDueAt,
  planDistillBatches,
} from './memory/distillQueue';
import { type DownloadProgress, downloadModel, isModelReady } from './memory/embedding/downloader';
import { createEmbeddingProvider, toEmbedder } from './memory/embedding/provider';
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  embeddingModelDirName,
  resolveEmbeddingModelSpec,
} from './memory/embedding/registry';
import { type RemoteEmbeddingOptions, remoteModelName } from './memory/embedding/remote';
import type { EmbeddingModelSpec, EmbeddingProvider } from './memory/embedding/types';
import {
  type ForgettingRunSummary,
  lastForgettingRunAt,
  runForgettingPass,
} from './memory/forgetting';
import {
  countFailedKgJobs,
  ensureKgJob,
  ensurePendingKgJobs,
  type KgJob,
  listKgJobs,
  listResumableKgJobs,
  retryFailedKgJobs,
  runKgJob,
} from './memory/kg';
import { runVecCompaction } from './memory/maintenance';
import { applyManualEdit, type ManualEditResult } from './memory/manual';
import { approvePendingWrite } from './memory/pending';
import { type ReconcileSummary, runReconcile } from './memory/reconcile';
import { getReembedJob, type ReembedJob, runReembedJob } from './memory/reembed';
import { sanitizeMemoryWrite } from './memory/safety';
import { distillSpaces, type MemorySpaceContext } from './memory/space';
import { getMemory } from './memory/store';
import type { Embedder, Memory } from './memory/types';

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
  /** 远程凭证 / 模型不可用的面向用户原因；有值时不构造 provider，直接作为 lastEmbeddingError */
  remoteIssue?: string | null;
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
  const spec = resolveEmbeddingModelSpec(modelId);
  const remote = spec?.runtime === 'openai-compatible';
  const selected = providerId
    ? providers.find(
        (x): x is ModelProvider =>
          Boolean(x) && typeof x === 'object' && (x as ModelProvider).id === providerId
      )
    : undefined;
  const model = remote ? remoteModelName(spec) : null;
  const issue = remote
    ? remoteEmbeddingIssue({ providerId, provider: selected, modelId: model })
    : null;
  const locale = normalizeLocale(typeof state.language === 'string' ? state.language : undefined);
  const remoteIssue = issue
    ? remoteEmbeddingIssueMessage(
        issue,
        { provider: selected?.name || providerId || '', model: model ?? '' },
        (key, params) => translate(locale, key, params)
      )
    : null;
  const credentials =
    remote && !issue && selected ? { baseUrl: selected.baseUrl, apiKey: selected.apiKey } : null;
  const previous = config.remoteCredentials?.();
  const sameCredentials =
    !remote ||
    (credentials?.baseUrl === previous?.baseUrl &&
      credentials?.apiKey === previous?.apiKey &&
      remoteIssue === (config.remoteIssue ?? null));
  // 保存值快照而非 providers 引用：原地编辑也能识别变更，且无关设置不释放本地大模型。
  const next = { modelId, autoDownload, remoteCredentials: () => credentials, remoteIssue };
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
    scheduleMemoryMaintenance();
    scheduleForgetting();
  }
  return db;
}

// 向量表瘦身 + 空间回收：迁移本身在 openMemoryDb 里同步做完（只是重建虚拟表），
// 但把空闲页还给文件系统要 VACUUM，不能在迁移事务里跑，也不该卡在开库那一刻。
// 延后执行避开启动时的重嵌 / 蒸馏抢锁；撞锁或进程被杀都停在 memory_maintenance 的断点上，下次启动续跑。
const MAINTENANCE_DELAY_MS = 20_000;
let maintenanceScheduled = false;

function scheduleMemoryMaintenance(): void {
  if (maintenanceScheduled || !db) return;
  maintenanceScheduled = true;
  const conn = db;
  const timer = setTimeout(() => {
    try {
      runVecCompaction(conn, path.join(memoryRoot(), 'memory.db'));
    } catch {
      /* 维护失败不影响前台读写，下次启动从断点重试 */
    }
  }, MAINTENANCE_DELAY_MS);
  timer.unref?.();
}

let forgettingConfig: ForgettingSettings = DEFAULT_FORGETTING_SETTINGS;

/** 设置层调用；改了间隔 / 开关后重新排一次巡检（已排过的不重复排） */
export function syncMemoryForgettingFromSettings(state: Record<string, unknown>): void {
  forgettingConfig = normalizeForgettingSettings(state);
  if (db) scheduleForgetting();
}

export function forgettingSettings(): ForgettingSettings {
  return forgettingConfig;
}

/** 审计落 userData/memory/audit.jsonl；写失败由 appendMemoryAudit 自己吞掉 */
const auditSink = (entry: Parameters<typeof appendMemoryAudit>[1]): void => {
  appendMemoryAudit(memoryRoot(), entry);
};

// 遗忘巡检：不另起定时器，只在开库后按 intervalDays 判断是否到期。
// 延后执行避开启动时的重嵌 / 蒸馏抢锁；进程被杀不影响正确性——下次开库重新算（巡检本身幂等）。
const FORGETTING_DELAY_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
let forgettingScheduled = false;

function scheduleForgetting(): void {
  if (forgettingScheduled || !db) return;
  forgettingScheduled = true;
  const conn = db;
  const timer = setTimeout(() => {
    forgettingScheduled = false;
    try {
      if (!forgettingConfig.enabled) return;
      const last = lastForgettingRunAt(conn);
      if (last && Date.now() - new Date(last).getTime() < forgettingConfig.intervalDays * DAY_MS) {
        return;
      }
      const summary = runForgettingPass(conn, forgettingConfig, { audit: auditSink });
      if (summary.archived > 0) notifyMemoryChanged();
    } catch {
      /* 巡检失败不影响前台读写，下次开库重试 */
    }
  }, FORGETTING_DELAY_MS);
  timer.unref?.();
}

/** 设置页「立即运行」：用共享连接跑一轮，返回本次摘要 */
export function runMemoryForgettingNow(): ForgettingRunSummary {
  const conn = memoryDb();
  const summary = runForgettingPass(conn, forgettingConfig, { audit: auditSink });
  if (summary.archived > 0) notifyMemoryChanged();
  return summary;
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
  /** 聚合窗口（settings.memoryDistillWindowMinutes）；0 = 会话结束立即提炼 */
  windowMinutes: number;
  /** 时钟；测试注入 */
  now: () => number;
}

let distillConfig: MemoryDistillConfig = {
  enabled: false,
  complete: null,
  readTranscript: readSessionTranscript,
  language: 'en',
  windowMinutes: normalizeMemoryDistillWindowMinutes(undefined),
  now: Date.now,
};

export function configureMemoryDistill(next: Partial<MemoryDistillConfig>): void {
  distillConfig = { ...distillConfig, ...next };
}

export function syncMemoryDistillFromSettings(state: Record<string, unknown>): void {
  configureMemoryDistill({
    // 内置工具关掉后记忆分页会隐藏，自动蒸馏必须一起停，否则会话结束仍会写库。
    enabled:
      state.memoryDistillEnabled === true &&
      !effectiveDisabledBuiltinTools(state.disabledBuiltinTools).includes('memory'),
    language: typeof state.memoryLanguage === 'string' ? state.memoryLanguage : 'en',
    windowMinutes: normalizeMemoryDistillWindowMinutes(state.memoryDistillWindowMinutes),
  });
  // 开关重新打开时把库里的待办接上；关着时 armDistillQueue 会撤掉定时器
  armDistillQueue();
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
  for (const entry of branch) {
    for (const raw of sessionEntryToContextMessages(entry)) {
      const m = projectMessage(raw);
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const text = m.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      if (text.trim()) out.push({ role: m.role, text, entryId: entry.id });
    }
  }
  return out;
}

/**
 * 会话结束 / 闲置回收 / Bot「新对话」时调用。读权威 jsonl → 按 fromEntryId 切出增量 → 打码拼接 →
 * 建幂等任务（同会话同内容只一次）→ 后台跑。返回新水位（下次的 fromEntryId），由调用方保存；
 * 读失败 / 开关关闭时原样返回起点。开关关闭不建库也不建任务。绝不抛。
 */
export async function scheduleMemoryDistill(
  payload: DistillPayload,
  /** continueFromLastJob：未给 fromEntryId 时从该会话最近一次任务的终点续作（Code 会话无外部水位） */
  opts: { continueFromLastJob?: boolean } = {}
): Promise<string | undefined> {
  if (!distillConfig.enabled) return payload.fromEntryId;
  let watermark = payload.fromEntryId;
  const onWatermark = (next: string | undefined) => {
    watermark = next;
  };
  const continueFromLastJob = opts.continueFromLastJob === true;
  // Bot 会话不聚合：它的水位与 onDistilled（整理 bot 笔记）依赖本次提炼真正跑完
  if (distillConfig.windowMinutes > 0 && !payload.botId) {
    await queueDistill(payload, onWatermark, continueFromLastJob);
  } else {
    await runDistill(payload, undefined, undefined, false, onWatermark, continueFromLastJob);
  }
  return watermark;
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
  manual = false,
  onWatermark?: (watermark: string | undefined) => void,
  continueFromLastJob = false
): Promise<void> {
  const queuedAt = performance.now();
  return enqueueLlmJob(async () => {
    if (manual)
      console.info('[memory-distill] manual background queue wait', {
        sessionId: payload.sessionId,
        durationMs: Math.round(performance.now() - queuedAt),
      });
    const { stamped, transcript, watermark, fingerprint } = await sliceForDistill(
      payload,
      continueFromLastJob
    );
    if (!transcript) {
      onWatermark?.(watermark);
      return;
    }
    const job = ensureDistillJob(memoryDb(), stamped, fingerprint, { force });
    // 任务已落 memory_jobs（或同内容已提炼过）才推进水位：之后失败可续跑，不丢增量
    onWatermark?.(watermark);
    if (!job) return;
    onStarted?.();
    await runOneDistill(job, transcript);
  });
}

/** 读权威 jsonl 切出本次增量并盖章；必须在串行队列里调用（见续作水位） */
async function sliceForDistill(payload: DistillPayload, continueFromLastJob: boolean) {
  // 在串行队列里读水位：压缩触发与会话结束触发先后到达时，后者能看到前者盖的终点
  if (continueFromLastJob && payload.fromEntryId === undefined) {
    const fromEntryId = lastDistillWatermark(memoryDb(), payload.sessionId);
    if (fromEntryId) payload = { ...payload, fromEntryId };
  }
  const { messages, watermark } = sliceTranscript(
    await distillConfig.readTranscript(payload.sessionFile),
    payload.fromEntryId
  );
  const transcript = buildTranscript(messages);
  // 语言写进 payload 并进指纹：改完语言再提炼不会被当成「已提炼」跳过，
  // 续跑旧任务时也用它自己的语言复算，不受之后的设置变更影响
  const stamped: DistillPayload = {
    ...payload,
    language: distillConfig.language,
    ...(watermark !== undefined ? { toEntryId: watermark } : {}),
  };
  const fingerprint = distillFingerprint(stamped.sessionId, transcript, stamped.language);
  return { stamped, transcript, watermark, fingerprint };
}

// ---------------------------------------------------------------------------
// 会话聚合：窗口内同项目的会话合并成一次提炼。待办落 memory_jobs(kind='distill-queue')，
// 区间在排队时就盖章，水位立即推进；到期后（或下次开库时已过期）由串行队列出队建任务。
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
let distillQueueTimer: NodeJS.Timeout | null = null;

function queueDistill(
  payload: DistillPayload,
  onWatermark: (watermark: string | undefined) => void,
  continueFromLastJob: boolean
): Promise<void> {
  return enqueueLlmJob(async () => {
    const { stamped, transcript, watermark, fingerprint } = await sliceForDistill(
      payload,
      continueFromLastJob
    );
    if (transcript) {
      const now = distillConfig.now();
      enqueueDistill(
        memoryDb(),
        stamped,
        fingerprint,
        new Date(now + distillConfig.windowMinutes * MINUTE_MS),
        new Date(now)
      );
      armDistillQueue();
    }
    // 待办已落库才推进水位：进程随后退出，下次开库按盖章的区间补跑
    onWatermark(watermark);
  });
}

/** 按库里最早的到期时间排一个定时器；已过期的直接进串行队列 */
function armDistillQueue(): void {
  if (distillQueueTimer) clearTimeout(distillQueueTimer);
  distillQueueTimer = null;
  if (!db || !distillConfig.enabled) return;
  const next = nextDistillDueAt(db);
  if (!next) return;
  const delay = Date.parse(next) - distillConfig.now();
  if (!(delay > 0)) {
    void flushMemoryDistillQueue();
    return;
  }
  distillQueueTimer = setTimeout(() => {
    distillQueueTimer = null;
    void flushMemoryDistillQueue();
  }, delay);
  distillQueueTimer.unref?.();
}

/** 把已到期的待办出队提炼（定时器 / 开库时调用；测试直接调）。重复调用是安全的：认领是原子的 */
export function flushMemoryDistillQueue(): Promise<void> {
  return enqueueLlmJob(async () => {
    await flushDueDistill();
    armDistillQueue();
  });
}

async function flushDueDistill(): Promise<void> {
  if (!distillConfig.enabled || !db) return;
  const conn = db;
  for (const items of dueDistillGroups(conn, new Date(distillConfig.now()))) {
    const units: (DistillUnit & { ids: number[] })[] = [];
    const gone: number[] = [];
    for (const unit of distillUnits(items)) {
      const transcript = await readMemberTranscript(unit.member).catch(() => '');
      if (transcript) units.push({ ...unit, transcript });
      else gone.push(...unit.ids);
    }
    // 读不到 / 内容已没了：作废，避免它永远到期、定时器空转
    claimDistillQueue(conn, gone, 'cancelled');
    const { projectId, language } = items[0].payload;
    for (const plan of planDistillBatches(units, { projectId, language })) {
      let job: DistillJob | null = null;
      try {
        const claim = claimDistillQueue(conn, plan.ids, 'done', () =>
          ensureDistillJob(conn, plan.payload, plan.fingerprint)
        );
        job = claim.claimed ? (claim.value ?? null) : null;
      } catch {
        claimDistillQueue(conn, plan.ids, 'cancelled');
      }
      if (job) await runOneDistill(job, plan.transcript);
    }
  }
}

async function readMemberTranscript(member: DistillBatchMember): Promise<string> {
  const { messages } = sliceTranscript(
    await distillConfig.readTranscript(member.sessionFile),
    member.fromEntryId,
    member.toEntryId
  );
  return buildTranscript(messages);
}

/** 聚合任务续跑：按成员盖章的区间重读，拼接规则与建任务时相同，原文没变则指纹一致 */
async function readBatchTranscript(members: readonly DistillBatchMember[]): Promise<string> {
  const units: DistillUnit[] = [];
  for (const member of members) {
    const transcript = await readMemberTranscript(member);
    if (transcript) units.push({ member, transcript });
  }
  return buildBatchTranscript(units);
}

async function runOneDistill(job: DistillJob, transcript: string): Promise<void> {
  const complete = await distillConfig.complete?.();
  if (!complete || !db) return;
  // 与 memory_capture 的缺省归属一致：bot 会话进 bot space，项目会话进项目 space
  const { projectId, botId, chatId } = job.payload;
  const spaces = distillSpaces({
    projectId,
    ...(botId ? { botId } : {}),
    ...(chatId ? { chatId } : {}),
  });
  await runDistillJob(db, job, {
    transcript,
    complete,
    embedder: await memoryEmbedder(),
    spaceId: spaces.self,
    ...(spaces.chat ? { chatSpaceId: spaces.chat } : {}),
    onCreated: onMemoryCreated,
  });
  // 一条都没写入时（全部低重要度 / 撞去重）也要通知：任务状态和丢弃原因变了
  notifyMemoryChanged();
}

/** 开库时把上次没跑完的任务接上（pending / 半路 running）；内容已变的由 runDistillJob 标 cancelled */
function resumeMemoryDistill(): void {
  if (!distillConfig.enabled || !db) return;
  const jobs = listResumableDistillJobs(db);
  if (jobs.length > 0) {
    void enqueueLlmJob(async () => {
      for (const job of jobs) {
        try {
          const { sessions } = job.payload;
          const transcript = sessions?.length
            ? await readBatchTranscript(sessions)
            : await readMemberTranscript({ ...job.payload, endedAt: job.createdAt });
          await runOneDistill(job, transcript);
        } catch {
          /* 单个任务失败不影响其余 */
        }
      }
    });
  }
  // 聚合待办：已过期的排在续跑之后补跑，没到期的按库里的到期时间重新排期
  armDistillQueue();
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
  const enabled = state.memoryKgEnabled === true;
  const turningOn = enabled && !kgConfig.enabled;
  configureMemoryKg({ enabled });
  if (turningOn && db) resumeMemoryKg();
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

/** createMemory 的 onCreated hook：只排队，不在这里调 LLM；开关关闭时连任务都不建。rerunKg 见 ensureKgJob */
function onMemoryCreated(memory: Memory, rerunKg = false): void {
  notifyMemoryChanged();
  scheduleAutoReconcile();
  if (!kgConfig.enabled || !db) return;
  const job = ensureKgJob(db, memory.id, { rerun: rerunKg });
  if (job) void enqueueLlmJob(() => runOneKg(job));
}

// ---------------------------------------------------------------------------
// 矛盾复核：找「新记忆推翻旧结论」的配对，只写 challenges（待审）。与蒸馏 / KG 共用 LLM 串行链。
// ---------------------------------------------------------------------------

/** 设置 memoryReconcileEnabled，缺省关（每轮最多 RECONCILE_MAX_PAIRS 次模型调用）；只管自动触发 */
let reconcileEnabled = false;
/** 已排进队列、尚未开跑的自动复核：一批写入只排一轮 */
let reconcileQueued = false;

export function syncMemoryReconcileFromSettings(state: Record<string, unknown>): void {
  reconcileEnabled =
    state.memoryReconcileEnabled === true &&
    !effectiveDisabledBuiltinTools(state.disabledBuiltinTools).includes('memory');
}

function scheduleAutoReconcile(): void {
  if (!reconcileEnabled || reconcileQueued || !db) return;
  reconcileQueued = true;
  void enqueueLlmJob(async () => {
    reconcileQueued = false;
    await reconcileOnce();
  });
}

async function reconcileOnce(): Promise<ReconcileSummary | null> {
  const complete = await getMemoryCompletion();
  if (!complete || !db) return null;
  const summary = await runReconcile(db, { complete });
  if (summary.challenges > 0) notifyMemoryChanged();
  console.info('[memory-reconcile] run', summary);
  return summary;
}

/** 设置页「立即复核」：绕过开关（显式点击即意图），排进同一条串行链；没有可用模型返回 null */
export async function runMemoryReconcileNow(): Promise<ReconcileSummary | null> {
  memoryDb();
  let summary: ReconcileSummary | null = null;
  await enqueueLlmJob(async () => {
    summary = await reconcileOnce();
  });
  return summary;
}

/** 等后台复核收尾（测试 / 退出前用）；与蒸馏 / KG 共链 */
export async function awaitMemoryReconcile(): Promise<void> {
  await awaitLlmJobs();
}

/**
 * 用户手动编辑（原地改，id 不变）：与工具写入同样过注入扫描与脱敏；标题或正文变了当场重嵌、清掉失效的实体提及并重抽。
 * 不存在或已删除返回 null
 */
export async function editMemory(
  id: string,
  patch: { title: string; content: string; unitType?: UnitType; importance?: number }
): Promise<ManualEditResult | null> {
  const database = memoryDb();
  const current = getMemory(database, id);
  if (!current || current.lifecycleState === 'deleted') return null;
  const safe = sanitizeMemoryWrite({ title: patch.title, content: patch.content });
  const result = await applyManualEdit(
    database,
    id,
    {
      title: safe.title ?? '',
      content: safe.content,
      unitType: patch.unitType,
      importance: patch.importance,
    },
    await memoryEmbedder()
  );
  if (!result) return null;
  if (result.semanticChanged) {
    if (!result.embedded) scheduleReembed();
    // 抽取输入含标题，但正文没变时指纹不变、不会自动重抽，只改标题要显式要求重抽
    onMemoryCreated(result.memory, result.memory.content === result.before.content);
  } else {
    notifyMemoryChanged();
  }
  return result;
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
  ensurePendingKgJobs(db);
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

export function getMemoryKgFailedCount(): number {
  return db ? countFailedKgJobs(db) : 0;
}

/** 把 kg 失败终态放回 pending，并在开关开着时立刻续跑。返回重置条数 */
export function retryFailedMemoryKg(): number {
  if (!db) return 0;
  const jobs = retryFailedKgJobs(db);
  if (jobs.length > 0 && kgConfig.enabled) {
    void enqueueLlmJob(async () => {
      for (const job of jobs) await runOneKg(job);
    });
  }
  return jobs.length;
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
      if (!db) return; // 库是懒打开的：这里不报错也不开库，等 memoryDb() 首次打开时会再调度
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
  // 校验阶段拦下注定失败的远程配置（缺凭证 / 对话模型）：不外发，原因直接给设置页
  if (spec.runtime === 'openai-compatible' && config.remoteIssue) {
    lastEmbeddingError = config.remoteIssue;
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
  if (distillQueueTimer) clearTimeout(distillQueueTimer);
  distillQueueTimer = null;
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

/** scope：会话记忆上下文（memorySpaceContext 推导）；兼容旧调用传 projectId 字符串 / null */
export async function invokeMemory(
  op: MemoryOp,
  params: unknown,
  scope: MemorySpaceContext | string | null
): Promise<unknown> {
  const space = scope !== null && typeof scope === 'object' ? scope : { projectId: scope };
  return executeMemoryOp(memoryDb(), op, params, {
    ...space,
    embedder: await memoryEmbedder(),
    onCreated: onMemoryCreated,
    onDeleted: notifyMemoryChanged,
    onPending: notifyMemoryChanged,
    complete: () => getMemoryCompletion(),
  });
}

/** 批准 Bot 成员写共享空间的待审批记忆：走与工具写入同一条创建链路（向量、KG 排队、变更通知） */
export async function approvePendingMemoryWrite(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const result = await approvePendingWrite(memoryDb(), id, {
    embedder: await memoryEmbedder(),
    onCreated: onMemoryCreated,
  });
  notifyMemoryChanged();
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

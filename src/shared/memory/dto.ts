import { isUnitType, type UnitType } from './constants';
import type { SearchAssistReason, SearchAssistState } from './searchAssist';
import type { TemporalPrecision } from './temporal';

export type MemoryLifecycleState = 'active' | 'archived' | 'deleted';
export type EvolvesRelationDto = 'replaces' | 'enriches' | 'confirms' | 'challenges';
export type EvolvesReviewStateDto = 'pending' | 'accepted' | 'rejected';

export interface MemoryListItem {
  id: string;
  title: string;
  contentSummary: string;
  unitType: UnitType;
  spaceId: string;
  /** 人可读的归属：项目名或 Global；spaceId 是 `proj:<uuid>`，不能直接给用户看 */
  spaceLabel: string;
  importance: number;
  isCrystal: boolean;
  isLatest: boolean;
  lifecycleState: MemoryLifecycleState;
  createdAt: string;
  updatedAt: string;
  /** 被检索返回的次数；不代表被真正用上 */
  appearances: number;
  /** 最后一次被检索返回的时间；只给维护筛选用，不参与排序 */
  lastHitAt: string | null;
  /** 被检索返回的累计次数（与 appearances 同源，语义更直白）；只给维护筛选用 */
  hitCount: number;
  /** 遗忘巡检标上的「建议归档」时间；null = 不是候选。归档要用户确认或显式开启自动归档 */
  archiveCandidateAt: string | null;
}

export interface EvolvesEdgeDto {
  id: string;
  olderId: string;
  newerId: string;
  relation: EvolvesRelationDto;
  confidence: number;
  reason: string | null;
  reviewState: EvolvesReviewStateDto;
  reviewedAt: string | null;
  createdAt: string;
}

/**
 * 待审阅的矛盾关系：只给 id 无法判断，两端记忆的标题与摘要必须一起给。
 * 任一端已删除的边不出现（删除时关系边一并清掉，这里只是兜底）。
 */
export interface PendingEvolvesReviewDto {
  edge: EvolvesEdgeDto;
  older: MemoryListItem;
  newer: MemoryListItem;
}

export interface CrystalSourceDto extends MemoryListItem {
  contributionWeight: number;
}

export interface MemoryDetail extends MemoryListItem {
  content: string;
  eventStart: string | null;
  eventEnd: string | null;
  temporalPrecision: TemporalPrecision | null;
  embeddingModel: string | null;
  evolves: EvolvesEdgeDto[];
  entityNames: string[];
  crystalSources: CrystalSourceDto[];
}

export type MemorySearchMode = 'exact' | 'fast' | 'deep';

export function isMemoryRetrievalMode(mode: unknown): mode is 'fast' | 'deep' {
  return mode === 'fast' || mode === 'deep';
}

export interface MemoryListQuery {
  spaceId?: string | null;
  /** 按一组空间筛选（如「全部项目」「秘书」）；与 spaceId 同时给时以 spaceId 为准，空数组 = 无结果 */
  spaceIds?: string[];
  query?: string;
  unitType?: UnitType;
  includeArchived?: boolean;
  /**
   * 维护筛选：只列超过这么多天没被检索命中的记忆（从未命中的按创建时间算）。
   * 只读筛选，不改任何状态；exact 模式可精确分页，语义模式在结果上后过滤。
   */
  staleDays?: number;
  /** 只看遗忘巡检标出的归档候选（与 staleDays 独立：候选还要求重要度低、且不受保护规则保护） */
  archiveCandidate?: boolean;
  limit: number;
  offset: number;
  /**
   * exact（缺省）= FTS 全文，可精确分页；
   * fast / deep = 与 agent 同一条检索路径（FTS ∪ 向量 ∪ 实体 → RRF → decay），只返回 top-N。
   */
  mode?: MemorySearchMode;
}

export interface MemoryListResult {
  items: MemoryListItem[];
  total: number;
  /** fast/deep 模式下 total 只是本次返回条数，不能用于深分页 */
  approximate?: boolean;
  /** fast/deep 模式实际是否用上了向量（模型未就绪时自动降级为 FTS + 实体） */
  vectorsUsed?: boolean;
  /** off=fast 或无模型；llm=deep 至少一步成功；fallback=超时、报错、不可解析或退避 */
  assist?: SearchAssistState;
  assistReason?: SearchAssistReason;
}

export interface DistillJobDto {
  id: number;
  sessionId: string;
  /** 多会话聚合任务的成员会话；普通任务没有 */
  sessionIds?: string[];
  /** 会话标题；取不到时为 null，UI 回退到短 id */
  sessionTitle?: string | null;
  projectId: string | null;
  projectName?: string | null;
  status: 'pending' | 'running' | 'done' | 'cancelled';
  attempts: number;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  notes: {
    kind: 'low_importance' | 'candidates_found' | 'deduplicated' | 'rejected';
    title: string | null;
    detail: string;
  }[];
  createdAt: string;
  updatedAt: string;
}

export interface KgJobDto {
  id: number;
  memoryId: string;
  /** 记忆标题；记忆已删时为 null */
  memoryTitle?: string | null;
  status: 'pending' | 'running' | 'done' | 'cancelled';
  attempts: number;
  total: number;
  done: number;
  /** 1 = 抽取失败终态；成功为 0 */
  failed: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReembedJobDto {
  id: number;
  target: string;
  status: 'pending' | 'running' | 'done' | 'cancelled';
  cursor: number;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryJobsSnapshot {
  distill: DistillJobDto[];
  kg: KgJobDto[];
  reembed: ReembedJobDto | null;
  /** kind=kg 的失败终态条数，不受任务列表 limit 截断 */
  kgFailed: number;
}

export interface MemoryStats {
  total: number;
  bySpace: Record<string, number>;
  /** space id → 项目名 / Global；缺失的 space（项目已删）不在表里 */
  spaceLabels: Record<string, string>;
  /** space id → 空间类别（Main 按项目注册表判定秘书私有空间） */
  spaceKinds?: Record<string, MemorySpaceKind>;
  crystals: number;
  entities: number;
  embedded: number;
  databaseBytes: number;
  /** 从未被检索命中的条数（hit_count = 0），供用户判断要不要整理 */
  neverHit: number;
  /** 最近 7 天新增条数 */
  addedLast7Days: number;
  /** 为什么没有向量；null = 没出过错 */
  embeddingError?: string | null;
  /** 遗忘巡检状态；库未启用 / 未开过库时缺省 */
  forgetting?: MemoryForgettingStateDto;
}

export type MemorySpaceKind = 'global' | 'project' | 'secretary' | 'bot' | 'chat';

/** 遗忘巡检的一次运行摘要（memory_maintenance 里 kind=decay 的 detail） */
export interface MemoryDecayRunDto {
  ranAt: string;
  scored: number;
  candidates: number;
  archived: number;
  staleDays: number;
  maxImportance: number;
  autoArchive: boolean;
  durationMs: number;
}

/** 一轮矛盾复核的摘要；没有可用模型时 IPC 返回 null */
export interface MemoryReconcileRunDto {
  sources: number;
  pairs: number;
  judged: number;
  challenges: number;
  failed: number;
  capped: boolean;
  durationMs: number;
}

export interface MemoryForgettingStateDto {
  lastRunAt: string | null;
  lastRun: MemoryDecayRunDto | null;
  /** 当前候选条数（实时统计） */
  candidates: number;
}

export interface MemoryArchiveCandidatesResult {
  items: MemoryListItem[];
  total: number;
}

export interface MemoryArchiveConfirmResult {
  archived: number;
  /** 期间被检索到 / 重要度被调高 / 已归档而跳过的条数 */
  skipped: number;
}

export interface DistillableSessionDto {
  sessionId: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  /** 已经提炼过（存在该会话的任务）；正文变了仍可再提炼一次 */
  distilled: boolean;
  /** 会话 jsonl 的最后修改时间，用于排序与展示 */
  updatedAt: string | null;
}

export type EmbeddingModelState = 'ready' | 'missing' | 'downloading' | 'unavailable';

export interface EmbeddingModelDto {
  id: string;
  /** 运行时分档：model2vec 查表 / gguf 走 llama.cpp / 远程 / 不用向量 */
  runtime: 'model2vec' | 'gguf' | 'openai-compatible' | 'none';
  /** 入库向量维度；远程模型首次响应前未知 */
  dim: number | null;
  approxBytes: number;
  /** 已落盘字节数，用于断点续传进度展示 */
  downloadedBytes: number;
  state: EmbeddingModelState;
  /** 需要下载文件的模型才为 true；none / remote 为 false */
  downloadable: boolean;
}

export interface ChatModelDto {
  id: string;
  label: string;
  params: string;
  contextSize: number;
  approxBytes: number;
  downloadedBytes: number;
  state: EmbeddingModelState;
  downloadable: boolean;
}

export interface EmbeddingDownloadProgressDto {
  modelId: string;
  file: string;
  fileIndex: number;
  fileCount: number;
  received: number;
  total: number | null;
  done?: boolean;
  error?: string;
}

export interface MemoryMutationResult {
  ok: boolean;
  memory?: MemoryDetail;
  edge?: EvolvesEdgeDto;
  impact?: MemoryDeletionImpact;
  error?: string;
}

/** 删除前的影响说明；执行时按同一规则在事务里重算 */
export interface MemoryDeletionImpact {
  /** target = 用户选中的；history = 被它替换掉、一起删的历史版本 */
  deleted: { id: string; title: string; spaceId: string; role: 'target' | 'history' }[];
  /** 删中间版本后重新接上的版本链 */
  bridges: { olderId: string; newerId: string }[];
  /** 只解除关系、本身保留的记忆 */
  relations: { memoryId: string; title: string; relation: string }[];
  /** 失去部分来源、仍是 crystal 的 */
  crystalsUpdated: { id: string; title: string; remaining: number }[];
  /** 来源不足、降为普通记忆的 crystal */
  crystalsDemoted: { id: string; title: string; remaining: number }[];
  /** 被删的 crystal 解除的来源边数（来源记忆保留） */
  releasedSources: number;
}

/** Bot 成员写 project / global 记忆的待审批项（批准前不在 memories 里） */
export interface PendingMemoryWriteDto {
  id: string;
  kind: 'capture' | 'crystallize';
  spaceId: string;
  spaceLabel: string;
  /** 发起写入的成员（Main 解析的显示名） */
  originLabel: string;
  title: string | null;
  content: string;
  botId: string | null;
  chatId: string | null;
  /** 写入前已把密钥替换成 [REDACTED] */
  redacted: boolean;
  createdAt: string;
}

export type PendingMemoryWriteDecision = 'approve' | 'reject';

/** 手动编辑记忆；title 为空沿用原标题；unitType / importance 不给则不改 */
export interface MemoryEditPatch {
  title: string;
  content: string;
  unitType?: UnitType;
  importance?: number;
}

export function isMemoryEditPatch(value: unknown): value is MemoryEditPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ['title', 'content', 'unitType', 'importance'];
  return (
    Object.keys(row).every((key) => keys.includes(key)) &&
    typeof row.title === 'string' &&
    typeof row.content === 'string' &&
    row.content.trim().length > 0 &&
    (row.unitType === undefined ||
      (typeof row.unitType === 'string' && isUnitType(row.unitType))) &&
    (row.importance === undefined ||
      (typeof row.importance === 'number' &&
        Number.isFinite(row.importance) &&
        row.importance >= 0 &&
        row.importance <= 1))
  );
}

export function isPendingMemoryWriteDecision(value: unknown): value is PendingMemoryWriteDecision {
  return value === 'approve' || value === 'reject';
}

export function isMemoryListQuery(value: unknown): value is MemoryListQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.limit) || (row.limit as number) < 1 || (row.limit as number) > 200)
    return false;
  if (!Number.isSafeInteger(row.offset) || (row.offset as number) < 0) return false;
  if (row.spaceId !== undefined && row.spaceId !== null && typeof row.spaceId !== 'string')
    return false;
  if (
    row.spaceIds !== undefined &&
    (!Array.isArray(row.spaceIds) ||
      row.spaceIds.length > 1000 ||
      !row.spaceIds.every((id) => typeof id === 'string' && id.length > 0))
  )
    return false;
  if (row.query !== undefined && typeof row.query !== 'string') return false;
  if (row.unitType !== undefined && (typeof row.unitType !== 'string' || !isUnitType(row.unitType)))
    return false;
  if (row.includeArchived !== undefined && typeof row.includeArchived !== 'boolean') return false;
  if (
    row.staleDays !== undefined &&
    (typeof row.staleDays !== 'number' || !Number.isFinite(row.staleDays) || row.staleDays < 0)
  )
    return false;
  if (row.archiveCandidate !== undefined && typeof row.archiveCandidate !== 'boolean') return false;
  if (row.mode !== undefined && row.mode !== 'exact' && row.mode !== 'fast' && row.mode !== 'deep')
    return false;
  return true;
}

export function isEvolvesReviewState(
  value: unknown
): value is Exclude<EvolvesReviewStateDto, 'pending'> {
  return value === 'accepted' || value === 'rejected';
}

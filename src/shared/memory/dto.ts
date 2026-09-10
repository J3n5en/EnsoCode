import { isUnitType, type UnitType } from './constants';
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
  accessCount: number;
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
  query?: string;
  unitType?: UnitType;
  includeArchived?: boolean;
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
}

export interface DistillJobDto {
  id: number;
  sessionId: string;
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
}

export interface MemoryStats {
  total: number;
  bySpace: Record<string, number>;
  /** space id → 项目名 / Global；缺失的 space（项目已删）不在表里 */
  spaceLabels: Record<string, string>;
  crystals: number;
  entities: number;
  embedded: number;
  databaseBytes: number;
  /** 为什么没有向量；null = 没出过错 */
  embeddingError?: string | null;
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
  error?: string;
}

export function isMemoryListQuery(value: unknown): value is MemoryListQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.limit) || (row.limit as number) < 1 || (row.limit as number) > 200)
    return false;
  if (!Number.isSafeInteger(row.offset) || (row.offset as number) < 0) return false;
  if (row.spaceId !== undefined && row.spaceId !== null && typeof row.spaceId !== 'string')
    return false;
  if (row.query !== undefined && typeof row.query !== 'string') return false;
  if (row.unitType !== undefined && (typeof row.unitType !== 'string' || !isUnitType(row.unitType)))
    return false;
  if (row.includeArchived !== undefined && typeof row.includeArchived !== 'boolean') return false;
  if (row.mode !== undefined && row.mode !== 'exact' && row.mode !== 'fast' && row.mode !== 'deep')
    return false;
  return true;
}

export function isEvolvesReviewState(
  value: unknown
): value is Exclude<EvolvesReviewStateDto, 'pending'> {
  return value === 'accepted' || value === 'rejected';
}

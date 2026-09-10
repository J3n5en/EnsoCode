import type { UnitTypeSource } from '@shared/memory/classify';
import type { EvolvesRelation, UnitType } from '@shared/memory/constants';
import type { SearchAnalysis } from '@shared/memory/searchAssist';
import type { TemporalPrecision } from '@shared/memory/temporal';

export const GLOBAL_SPACE = 'global';
const PROJECT_SPACE_PREFIX = 'proj:';

/** 项目层 space 用 Main 权威的 Project.id（worktree 切换不变），不是路径 hash。 */
export function projectSpaceId(projectId: string): string {
  return `${PROJECT_SPACE_PREFIX}${projectId}`;
}

export function isSpaceId(value: string): boolean {
  return (
    value === GLOBAL_SPACE ||
    (value.startsWith(PROJECT_SPACE_PREFIX) && value.length > PROJECT_SPACE_PREFIX.length)
  );
}

export type LifecycleState = 'active' | 'archived' | 'deleted';
export type TemporalContext = 'past' | 'present' | 'future' | 'timeless';
export type TemporalType = 'exact' | 'range' | 'unknown';
export type MemorySource = 'manual' | 'agent' | 'distill' | 'import';

export type { EvolvesRelation } from '@shared/memory/constants';
export type EvolvesReviewState = 'pending' | 'accepted' | 'rejected';

export interface Evolves {
  id: string;
  olderId: string;
  newerId: string;
  relation: EvolvesRelation;
  confidence: number;
  reason: string | null;
  reviewState: EvolvesReviewState;
  reviewedAt: string | null;
  createdAt: string;
}

export interface Memory {
  id: string;
  title: string;
  content: string;
  unitType: UnitType;
  unitTypeSource: UnitTypeSource;
  importance: number;
  confidence: number;
  spaceId: string;
  source: MemorySource;
  isLatest: boolean;
  version: number;
  isCrystal: boolean;
  /** 结晶标题；非 crystal 为 null */
  crystalTitle: string | null;
  /** CRYSTALLIZED_FROM 源记忆数；非 crystal 为 0 */
  sourceUnitCount: number;
  lifecycleState: LifecycleState;
  temporalContext: TemporalContext;
  temporalType: TemporalType | null;
  eventStart: string | null;
  eventEnd: string | null;
  temporalPrecision: TemporalPrecision | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  appearances: number;
  clicks: number;
  embeddingModel: string | null;
  embeddingDim: number | null;
  embeddingVersion: number | null;
  idempotencyKey: string | null;
}

export interface CreateMemoryInput {
  content: string;
  title?: string | null;
  unitType?: UnitType | null;
  unitTypeSource?: UnitTypeSource;
  importance?: number;
  confidence?: number;
  spaceId: string;
  source?: MemorySource;
  eventStart?: string | null;
  eventEnd?: string | null;
  temporalContext?: TemporalContext;
  temporalType?: TemporalType | null;
  idempotencyKey?: string | null;
  /** 已看过候选，仍要插入 */
  force?: boolean;
  /** 与 evolvesRelation 成对出现：显式声明与已有记忆的关系，跳过候选网 */
  evolvesFromId?: string | null;
  evolvesRelation?: EvolvesRelation | null;
  evolvesReason?: string | null;
  evolvesConfidence?: number;
}

export interface DedupCandidate {
  memory: Memory;
  /** 余弦相似度（向量已 L2 归一化） */
  similarity: number;
  /** 同 space 内 FTS 第一名；只作返回字段，不参与准入 */
  bm25Top1: boolean;
}

export type CreateMemoryResult =
  /** `deduplicated`：content_hash 命中，返回已有行，未写入 */
  | { status: 'inserted'; memory: Memory; deduplicated?: true; evolves?: Evolves }
  | { status: 'candidates_found'; candidates: DedupCandidate[] };

export interface UpdateMemoryPatch {
  title?: string;
  content?: string;
  unitType?: UnitType;
  importance?: number;
  lifecycleState?: LifecycleState;
  isLatest?: boolean;
}

export type EmbedKind = 'query' | 'passage';

export interface Embedder {
  model: string;
  /** onnx / remote 首次推理前未知（null），之后固定 */
  readonly dim: number | null;
  embed(text: string, kind: EmbedKind): Promise<Float32Array | null>;
}

export interface MemorySearchHit {
  memory: Memory;
  score: number;
  rrf: number;
  decay: number;
}

export interface SearchAssist {
  analyze(query: string): Promise<SearchAnalysis | null>;
  rerank(query: string, items: { title: string; content: string }[]): Promise<number[] | null>;
}

export interface SearchOptions {
  q: string;
  /** 参与检索的 space 集合；默认 global + 当前项目由调用方拼装 */
  spaceIds: string[];
  limit?: number;
  embedder?: Embedder | null;
  now?: Date;
  /** 事件何时发生（滤 event_start，按精度展开后相交）；与 recorded* 不能混用 */
  eventDateFrom?: string | null;
  eventDateTo?: string | null;
  /** 何时写入系统（滤 created_at） */
  recordedDateFrom?: string | null;
  recordedDateTo?: string | null;
  /** fast = 等权三通道（缺省）；deep = 意图加权 RRF，可选 LLM 辅助（失败回退）。不改写查询。 */
  mode?: 'fast' | 'deep';
  /** 只在 deep 使用；缺省则走本地正则意图，不调 LLM */
  assist?: SearchAssist | null;
  /** 最终排序后、截 limit 前用 MMR（λ=MMR_LAMBDA）去冗余；默认开（生产路径 bridge.ts 也显式传 true）。
   * 取舍：开启后页内顺序是贪心重排结果，不再是「分数 → RRF → updated_at → id」稳定排序；
   * 需要严格稳定排序的调用方传 false。无向量时 MMR 恒等，不影响排序。
   */
  mmr?: boolean;
}

export class MemoryValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MemoryValidationError';
    this.code = code;
  }
}

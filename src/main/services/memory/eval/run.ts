import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { MEMORY_SEARCH_DEFAULT_LIMIT } from '@shared/memory/toolParams';
import { openMemoryDb } from '../db';
import { createEmbeddingProvider, toEmbedder } from '../embedding/provider';
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  embeddingModelDirName,
  resolveEmbeddingModelSpec,
} from '../embedding/registry';
import { applyExtraction } from '../kg';
import { searchMemories } from '../search';
import { createMemory } from '../store';
import { type Embedder, GLOBAL_SPACE, projectSpaceId } from '../types';
import {
  BACKGROUND_MEMORIES,
  EVAL_CASES,
  EVAL_DIMENSIONS,
  EVAL_NOW,
  type EvalCase,
  type EvalDimension,
  type EvalMemory,
  type EvalSpace,
} from './cases';

export type EvalEmbedderKind = 'stub' | 'real';

const SPACE_IDS: Record<EvalSpace, string> = {
  global: GLOBAL_SPACE,
  project: projectSpaceId('enso-code'),
  otherProject: projectSpaceId('other-app'),
};
// 未指定 createdAt 的记忆从这里起按写入顺序每条 +1 分钟
const DEFAULT_CREATED_BASE = Date.parse('2025-10-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// stub embedder：词袋哈希。只编码字面重合，不懂同义、不跨语言
// ---------------------------------------------------------------------------

// 维度取大，让哈希碰撞（≈ 偶然的「相似」）低到可以忽略
const STUB_DIM = 4096;

function stubFeatures(text: string): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  for (const w of t.match(/[a-z0-9][a-z0-9_.-]*/g) ?? []) out.push(`w:${w}`);
  for (const run of t.match(/[\u3400-\u9fff]+/g) ?? []) {
    const chars = Array.from(run);
    if (chars.length === 1) out.push(`c:${chars[0]}`);
    for (let i = 0; i + 1 < chars.length; i++) out.push(`c:${chars[i]}${chars[i + 1]}`);
  }
  return out;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 英文按词、中文按字二元组哈希进计数向量；确定性，CI 用 */
export function createStubEmbedder(): Embedder {
  return {
    model: 'eval-stub-hash-ngram',
    dim: STUB_DIM,
    embed: async (text) => {
      const feats = stubFeatures(text);
      if (feats.length === 0) return null;
      const v = new Float32Array(STUB_DIM);
      for (const f of feats) v[fnv1a(f) % STUB_DIM] += 1;
      return v;
    },
  };
}

// ---------------------------------------------------------------------------
// real embedder：与生产同一条构造路径（createEmbeddingProvider → toEmbedder）
// ---------------------------------------------------------------------------

function defaultUserDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'enso-code');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
      'enso-code'
    );
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'enso-code');
}

export interface RealEmbedderHandle {
  embedder: Embedder;
  close: () => Promise<void>;
}

/**
 * ENSO_MEMORY_EVAL_MODEL：registry id，缺省为生产默认模型；
 * ENSO_MEMORY_EVAL_MODEL_DIR：模型目录，缺省为应用 userData/memory/models/<id>；
 * remote:* 另需 ENSO_MEMORY_EVAL_REMOTE_BASE_URL / ENSO_MEMORY_EVAL_REMOTE_API_KEY。
 */
export async function createRealEmbedder(
  env: NodeJS.ProcessEnv = process.env
): Promise<RealEmbedderHandle> {
  const id = env.ENSO_MEMORY_EVAL_MODEL || DEFAULT_EMBEDDING_MODEL_ID;
  const spec = resolveEmbeddingModelSpec(id);
  if (!spec || spec.runtime === 'none') throw new Error(`eval: unsupported embedding model ${id}`);
  const modelDir =
    env.ENSO_MEMORY_EVAL_MODEL_DIR ||
    path.join(defaultUserDataDir(), 'memory', 'models', embeddingModelDirName(spec));
  const remote =
    spec.runtime === 'openai-compatible'
      ? {
          baseUrl: env.ENSO_MEMORY_EVAL_REMOTE_BASE_URL ?? '',
          apiKey: env.ENSO_MEMORY_EVAL_REMOTE_API_KEY ?? '',
        }
      : undefined;
  const provider = await createEmbeddingProvider(spec, { modelDir, remote });
  if (!provider) throw new Error(`eval: embedding model ${id} produced no provider`);
  return { embedder: toEmbedder(provider), close: async () => provider.close?.() };
}

// ---------------------------------------------------------------------------
// 运行与指标
// ---------------------------------------------------------------------------

export interface Metrics {
  cases: number;
  recall5: number;
  recall10: number;
  mrr: number;
  /** 只在有 excluded 的用例上平均；没有这类用例时为 null */
  noise: number | null;
  /** 返回结果里已过期记忆的占比；只在有 stale 的用例上平均，没有这类用例时为 null */
  stale: number | null;
}

export interface CaseResult {
  id: string;
  dimension: EvalDimension;
  query: string;
  /** 与 expected 一一对应的名次（1 起），未返回为 null */
  expectedRanks: (number | null)[];
  /** 被返回的 excluded key 及名次 */
  excludedHits: { key: string; rank: number }[];
  /** 被返回的 stale key 及名次 */
  staleHits: { key: string; rank: number }[];
  returned: number;
  recall5: number;
  recall10: number;
  mrr: number;
  noise: number | null;
  stale: number | null;
}

export interface EvalReport {
  embedder: string;
  limit: number;
  overall: Metrics;
  byDimension: Record<EvalDimension, Metrics>;
  cases: CaseResult[];
}

function recallAt(ranks: (number | null)[], k: number): number {
  if (ranks.length === 0) return 0;
  return ranks.filter((r) => r !== null && r <= k).length / ranks.length;
}

function aggregate(results: CaseResult[]): Metrics {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const defined = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  const noisy = defined(results.map((r) => r.noise));
  const stale = defined(results.map((r) => r.stale));
  return {
    cases: results.length,
    recall5: mean(results.map((r) => r.recall5)),
    recall10: mean(results.map((r) => r.recall10)),
    mrr: mean(results.map((r) => r.mrr)),
    noise: noisy.length ? mean(noisy) : null,
    stale: stale.length ? mean(stale) : null,
  };
}

/** 背景库每条用例都要重写一遍；按 (kind, text) 缓存向量，real 模型下省掉重复推理，结果不变 */
function memoizeEmbedder(e: Embedder): Embedder {
  const cache = new Map<string, Promise<Float32Array | null>>();
  return {
    model: e.model,
    get dim() {
      return e.dim;
    },
    embed: (text, kind) => {
      const key = `${kind}\u0000${text}`;
      let v = cache.get(key);
      if (!v) {
        v = e.embed(text, kind);
        cache.set(key, v);
      }
      return v;
    },
  };
}

async function runCase(c: EvalCase, embedder: Embedder | null, limit: number): Promise<CaseResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-eval-'));
  const db = openMemoryDb(path.join(dir, 'memory.db'));
  try {
    const idByKey = new Map<string, string>();
    const all: EvalMemory[] = [...BACKGROUND_MEMORIES, ...c.memories];
    for (const [i, m] of all.entries()) {
      if (idByKey.has(m.key)) throw new Error(`eval case ${c.id}: duplicate memory key ${m.key}`);
      const now = new Date(m.createdAt ?? DEFAULT_CREATED_BASE + i * 60_000);
      // force：评测的是检索层，写入去重/候选网不能吞掉构造好的干扰项
      const r = await createMemory(
        db,
        {
          content: m.content,
          spaceId: SPACE_IDS[m.space],
          unitType: m.unitType,
          importance: m.importance,
          eventStart: m.eventStart ?? null,
          eventEnd: m.eventEnd ?? null,
          force: true,
          evolvesFromId: m.evolves ? idByKey.get(m.evolves.from) : undefined,
          evolvesRelation: m.evolves?.relation,
        },
        { embedder, now }
      );
      if (r.status !== 'inserted') throw new Error(`eval case ${c.id}: ${m.key} not inserted`);
      idByKey.set(m.key, r.memory.id);
      if (m.entities?.length) {
        applyExtraction(
          db,
          r.memory,
          {
            entities: m.entities.map((e) => ({
              name: e.name,
              type: e.type,
              description: null,
              confidence: 0.9,
              aliases: e.aliases ?? [],
            })),
            relations: [],
          },
          now
        );
      }
    }
    const keyById = new Map([...idByKey].map(([k, id]) => [id, k]));
    const staleKeys = c.stale ?? [];
    for (const k of [...c.expected, ...c.excluded, ...staleKeys]) {
      if (!c.memories.some((m) => m.key === k)) throw new Error(`eval case ${c.id}: unknown ${k}`);
    }

    // 与 agent 检索（bridge.ts）同参：fast + MMR + 默认 limit
    const hits = await searchMemories(db, {
      q: c.query,
      spaceIds: c.spaces.map((s) => SPACE_IDS[s]),
      limit,
      embedder,
      now: new Date(EVAL_NOW),
      mode: 'fast',
      mmr: true,
      eventDateFrom: c.eventDateFrom ?? null,
      eventDateTo: c.eventDateTo ?? null,
    });
    // 类型过滤没有下推到检索层，按 memoryAdmin 语义模式的做法在结果上后过滤
    const returned = hits
      .filter((h) => c.unitType === undefined || h.memory.unitType === c.unitType)
      .map((h) => keyById.get(h.memory.id) ?? h.memory.id);
    const rankOf = (key: string) => {
      const i = returned.indexOf(key);
      return i < 0 ? null : i + 1;
    };
    const expectedRanks = c.expected.map(rankOf);
    const hitsOf = (keys: string[]) =>
      keys.flatMap((key) => {
        const rank = rankOf(key);
        return rank === null ? [] : [{ key, rank }];
      });
    const excludedHits = hitsOf(c.excluded);
    const staleHits = hitsOf(staleKeys);
    const share = (keys: string[], n: number) =>
      keys.length === 0 ? null : returned.length === 0 ? 0 : n / returned.length;
    const found = expectedRanks.filter((r): r is number => r !== null);
    return {
      id: c.id,
      dimension: c.dimension,
      query: c.query,
      expectedRanks,
      excludedHits,
      staleHits,
      returned: returned.length,
      recall5: recallAt(expectedRanks, 5),
      recall10: recallAt(expectedRanks, 10),
      mrr: found.length ? 1 / Math.min(...found) : 0,
      noise: share(c.excluded, excludedHits.length),
      stale: share(staleKeys, staleHits.length),
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runEval(opts: {
  embedder: Embedder | null;
  label: string;
  cases?: EvalCase[];
  limit?: number;
}): Promise<EvalReport> {
  const limit = opts.limit ?? MEMORY_SEARCH_DEFAULT_LIMIT;
  const embedder = opts.embedder && memoizeEmbedder(opts.embedder);
  const results: CaseResult[] = [];
  for (const c of opts.cases ?? EVAL_CASES) results.push(await runCase(c, embedder, limit));
  const byDimension = Object.fromEntries(
    EVAL_DIMENSIONS.map((d) => [d, aggregate(results.filter((r) => r.dimension === d))])
  ) as Record<EvalDimension, Metrics>;
  return { embedder: opts.label, limit, overall: aggregate(results), byDimension, cases: results };
}

/** 按 kind 构造 embedder 跑全量用例；real 结束后释放模型 */
export async function runEvalWith(kind: EvalEmbedderKind): Promise<EvalReport> {
  if (kind === 'stub') return runEval({ embedder: createStubEmbedder(), label: 'stub' });
  const real = await createRealEmbedder();
  try {
    return await runEval({ embedder: real.embedder, label: `real (${real.embedder.model})` });
  } finally {
    await real.close();
  }
}

// ---------------------------------------------------------------------------
// Markdown 输出
// ---------------------------------------------------------------------------

const fmt = (x: number | null) => (x === null ? '—' : x.toFixed(3));

function metricsRow(name: string, m: Metrics): string {
  return `| ${name} | ${m.cases} | ${fmt(m.recall5)} | ${fmt(m.recall10)} | ${fmt(m.mrr)} | ${fmt(m.noise)} | ${fmt(m.stale)} |`;
}

export function formatReport(report: EvalReport): string {
  const head =
    '| 范围 | 用例数 | Recall@5 | Recall@10 | MRR | 噪声率 | staleRate |\n|---|---|---|---|---|---|---|';
  const dims = EVAL_DIMENSIONS.map((d) => metricsRow(d, report.byDimension[d]));
  const hitList = (hits: { key: string; rank: number }[]) =>
    hits.map((h) => `${h.key}@${h.rank}`).join(', ') || '—';
  const rows = report.cases.map((r) => {
    const ranks = r.expectedRanks.map((x) => (x === null ? '×' : String(x))).join(', ');
    return `| ${r.id} | ${r.dimension} | ${ranks} | ${hitList(r.excludedHits)} | ${hitList(r.staleHits)} | ${r.returned} | ${fmt(r.mrr)} |`;
  });
  return [
    `### embedder: ${report.embedder}（limit=${report.limit}，mode=fast，mmr=on）`,
    '',
    head,
    metricsRow('**overall**', report.overall),
    ...dims,
    '',
    '| 用例 | 维度 | 期望项名次 | 混入的排除项@名次 | 混入的过期项@名次 | 返回条数 | MRR |\n|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

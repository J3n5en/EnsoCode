import { createHash } from 'node:crypto';
import {
  DISTILL_CONSOLIDATE_MAX_TOKENS,
  DISTILL_EXTRACT_MAX_TOKENS,
  DISTILL_MAX_ATTEMPTS,
  DISTILL_MAX_CHUNK_CHARS,
  DISTILL_MAX_OUTPUT_TOKENS,
  DISTILL_MIN_IMPORTANCE,
  DISTILL_SINGLE_EXTRACT_MAX_TOKENS,
  isUnitType,
} from '@shared/memory/constants';
import {
  DISTILL_THREAD_PROMPT,
  distillChunkPrompt,
  distillConsolidatePrompt,
  withMemoryLanguage,
} from '@shared/memory/prompts';
import { normalizeTemporalDate } from '@shared/memory/temporal';
import type Database from 'better-sqlite3';
import { createMemory } from './store';
import type { CreateMemoryInput, Embedder, Memory } from './types';

/**
 * 会话结束后的异步蒸馏。
 * 本文件是纯逻辑层：不碰 electron / worker，LLM 调用以 `Complete` 注入，便于全部 mock。
 */

export interface CompleteOptions {
  maxTokens?: number;
  stage?: 'extract' | 'consolidate';
}

export type Complete = (
  systemPrompt: string,
  userText: string,
  options?: CompleteOptions
) => Promise<string>;

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** 解析后的蒸馏条目（尚未映射到写入输入） */
export interface DistilledMemory {
  title: string | null;
  content: string;
  importance: number;
  confidence: number | null;
  unitType: string | null;
  temporal: { start: string | null; end: string | null } | null;
}

// ---------------------------------------------------------------------------
// 敏感信息过滤
// ---------------------------------------------------------------------------

const REDACTED = '[REDACTED]';

/**
 * 蒸馏前的安全边界：会话正文里可能贴过密钥 / 口令，长期记忆一旦写入就会被检索回灌到后续会话。
 * 规则按「先整块、再已知前缀、再键值」的顺序，宁可误杀不可漏杀；键名保留以维持语义。
 */
const SECRET_PATTERNS: RegExp[] = [
  // PEM 私钥整块
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // OpenAI / Anthropic 等 sk- 前缀；GitHub ghp_/gho_/ghu_/ghs_/ghr_；Slack xox*；AWS AKIA；Google AIza
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Stripe 是下划线（sk_live_/sk_test_/rk_live_），上一条 sk- 挡不住
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}/g,
  // GitHub fine-grained PAT；HuggingFace token（本项目会下模型，用户很可能贴）
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // JWT 三段
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Authorization: Bearer <token>
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  // URL 里的 user:pass@
  /(\w+:\/\/[^\s/:@]+:)[^\s/@]+@/g,
];
// 引号值按完整字符串（含转义）打码；裸值至少 6 字符且不吞 JSON 边界，保留 null / false。
const KV_PATTERN =
  /\b((?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|refresh[_-]?token|token|passwd|password|pwd|authorization|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s"',;{}[\]]{6,})/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, group?: string) =>
      typeof group === 'string' && m.includes('://') ? `${group}${REDACTED}@` : REDACTED
    );
  }
  out = out.replace(KV_PATTERN, (_m, key: string, value: string) => {
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return `${key}${quote}${REDACTED}${quote}`;
  });
  return out;
}

// ---------------------------------------------------------------------------
// 对话文本与分块（大线程按块处理，块大小 min(requested, 4000)）
// ---------------------------------------------------------------------------

export { DISTILL_MAX_CHUNK_CHARS, DISTILL_MIN_IMPORTANCE };

const MESSAGE_SEP = '\n\n';

export function buildTranscript(messages: readonly TranscriptMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = m.text.trim();
    if (!text) continue;
    parts.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${redactSecrets(text)}`);
  }
  return parts.join(MESSAGE_SEP);
}

/** 按消息边界切块，每块 ≤ max；单条超长消息硬切。`chunks.join('\n\n')` 恒等于原文（单条硬切除外）。 */
export function chunkTranscript(
  transcript: string,
  max: number = DISTILL_MAX_CHUNK_CHARS
): string[] {
  if (transcript.length <= max) return [transcript];
  const messages = transcript.split(/\n\n(?=(?:User|Assistant): )/);
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };
  for (const m of messages) {
    if (m.length > max) {
      flush();
      for (let i = 0; i < m.length; i += max) chunks.push(m.slice(i, i + max));
      continue;
    }
    const joined = current ? `${current}${MESSAGE_SEP}${m}` : m;
    if (joined.length > max) {
      flush();
      current = m;
    } else {
      current = joined;
    }
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// 容错 JSON 解析
// ---------------------------------------------------------------------------

/** 去围栏、取最外层大括号、去尾逗号，仍失败则补全截断的引号 / 括号（模型输出被 max_tokens 截断很常见）。kg.ts 复用。 */
export function looseParse(raw: string): unknown {
  let text = raw.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0) return null;
  text = end > start ? text.slice(start, end + 1) : text.slice(start);
  const attempts = [text, stripTrailingCommas(text), stripTrailingCommas(closeTruncated(text))];
  for (const t of attempts) {
    try {
      return JSON.parse(t);
    } catch {
      /* next */
    }
  }
  return null;
}

const stripTrailingCommas = (t: string) => t.replace(/,\s*([}\]])/g, '$1');

function closeTruncated(t: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of t) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = t;
  if (inString) out += '"';
  // 截断处可能停在 `"key":` 或 `"key"` 后：补 null 让键值完整
  out = out.replace(/("(?:[^"\\]|\\.)*")\s*:?\s*$/, (_m, key: string) => `${key}: null`);
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 解析不出任何 JSON 结构时返回 null（模型异常 / 截断到无法修复），与“模型正常返回但没有值得记的东西”区分 */
function hasCompleteJsonObject(raw: string): boolean {
  const start = raw.indexOf('{');
  if (start < 0) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of raw.slice(start)) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

export function parseDistillResponse(raw: string): DistilledMemory[] | null {
  if (!hasCompleteJsonObject(raw)) return null;
  const parsed = looseParse(raw);
  if (parsed === null || typeof parsed !== 'object') return null;
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { memories?: unknown }).memories)
      ? (parsed as { memories: unknown[] }).memories
      : [];
  const out: DistilledMemory[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const content = str(o.content);
    const importance = num(o.importance);
    if (!content || importance === null) continue;
    const t =
      o.temporal && typeof o.temporal === 'object' ? (o.temporal as Record<string, unknown>) : null;
    const title = str(o.title);
    out.push({
      title: title === null ? null : redactSecrets(title),
      content: redactSecrets(content),
      importance,
      confidence: num(o.confidence),
      unitType: str(o.unit_type) ?? str(o.unitType),
      temporal: t && (str(t.start) || str(t.end)) ? { start: str(t.start), end: str(t.end) } : null,
    });
  }
  return out;
}

export function parseDistillOutput(raw: string): DistilledMemory[] {
  return parseDistillResponse(raw) ?? [];
}

// ---------------------------------------------------------------------------
// 写入映射
// ---------------------------------------------------------------------------

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * 蒸馏条目 → createMemory 输入。importance<0.5 丢弃（提示词明说 omit）；unit_type 不在闭集回退 fact+fallback，
 * 没给则留空让 createMemory 分类；日期只接受 normalizeTemporalDate 认的显式格式（不推测相对时间）。
 */
export function toCreateInput(m: DistilledMemory, spaceId: string): CreateMemoryInput | null {
  const content = m.content.trim();
  if (!content || m.importance < DISTILL_MIN_IMPORTANCE) return null;
  const unit = m.unitType
    ? isUnitType(m.unitType)
      ? { unitType: m.unitType, unitTypeSource: 'explicit' as const }
      : { unitType: 'fact' as const, unitTypeSource: 'fallback' as const }
    : { unitType: null };
  const [start] = normalizeTemporalDate(m.temporal?.start);
  const [end] = normalizeTemporalDate(m.temporal?.end);
  return {
    content,
    title: m.title,
    ...unit,
    importance: clamp01(m.importance),
    confidence: m.confidence === null ? undefined : clamp01(m.confidence),
    spaceId,
    source: 'distill',
    // 保留原始粒度，交由 createMemory 统一归一化并记录 precision。
    eventStart: start ? m.temporal!.start : null,
    eventEnd: start && end ? m.temporal!.end : null,
  };
}

// ---------------------------------------------------------------------------
// LLM 调用编排
// ---------------------------------------------------------------------------

const CONSOLIDATE_ABOVE = 3;

class DistillTruncatedError extends Error {
  override name = 'DistillTruncatedError';
}

/**
 * 小线程一次用 DISTILL_THREAD_PROMPT；大线程按块用 distillChunkPrompt，块结果 >3 条再 distillConsolidatePrompt 合并到 3 条。
 * 普通单块失败跳过、全部失败才抛；提取截断立即整轮上抛，合并失败则退回 importance 前 3。
 */
export async function distillTranscript(
  transcript: string,
  complete: Complete,
  opts: { maxChunkChars?: number; language?: unknown; extractMaxTokens?: number } = {}
): Promise<DistilledMemory[]> {
  const chunks = chunkTranscript(transcript, opts.maxChunkChars);
  const extractMaxTokens = opts.extractMaxTokens ?? DISTILL_SINGLE_EXTRACT_MAX_TOKENS;
  const systemPrompt = withMemoryLanguage(DISTILL_THREAD_PROMPT, opts.language);
  const infer = async (
    system: string,
    user: string,
    options: CompleteOptions,
    round: string
  ): Promise<string> => {
    const startedAt = performance.now();
    let ok = false;
    try {
      const raw = await complete(system, user, options);
      ok = true;
      return raw;
    } finally {
      console.info('[memory-distill] inference round', {
        stage: options.stage,
        round,
        durationMs: Math.round(performance.now() - startedAt),
        maxTokens: options.maxTokens,
        ok,
      });
    }
  };
  const parseWithTruncationRetry = async (
    system: string,
    user: string,
    options: CompleteOptions,
    round: string
  ): Promise<DistilledMemory[]> => {
    let raw = await infer(system, user, options, round);
    const retryableIncomplete = !raw.trim() || raw.includes('{');
    if (!hasCompleteJsonObject(raw) && retryableIncomplete) {
      if ((options.maxTokens ?? 0) >= DISTILL_MAX_OUTPUT_TOKENS)
        throw new DistillTruncatedError('model output is incomplete JSON');
      raw = await infer(system, user, { ...options, maxTokens: DISTILL_MAX_OUTPUT_TOKENS }, round);
      if (!hasCompleteJsonObject(raw))
        throw new DistillTruncatedError('model output is incomplete JSON');
    }
    const parsed = parseDistillResponse(raw);
    if (!parsed) throw new Error('model output is not parseable JSON');
    return parsed;
  };

  if (chunks.length === 1) {
    return parseWithTruncationRetry(
      systemPrompt,
      transcript,
      { maxTokens: extractMaxTokens, stage: 'extract' },
      '1/1'
    );
  }

  const collected: DistilledMemory[] = [];
  let lastError: unknown = null;
  let ok = 0;
  for (const [i, chunk] of chunks.entries()) {
    try {
      const parsed = await parseWithTruncationRetry(
        systemPrompt,
        distillChunkPrompt(i + 1, chunks.length, chunk),
        {
          maxTokens:
            opts.extractMaxTokens === DISTILL_MAX_OUTPUT_TOKENS
              ? DISTILL_MAX_OUTPUT_TOKENS
              : DISTILL_EXTRACT_MAX_TOKENS,
          stage: 'extract',
        },
        `${i + 1}/${chunks.length}`
      );
      collected.push(...parsed);
      ok++;
    } catch (error) {
      if (error instanceof DistillTruncatedError) throw error;
      lastError = error;
    }
  }
  if (ok === 0) throw lastError ?? new Error('all chunks failed');
  if (collected.length <= CONSOLIDATE_ABOVE) return collected;

  const listing = collected
    .map(
      (m, i) =>
        `${i + 1}. [${m.unitType ?? 'unknown'} | importance ${m.importance}] ${m.title ?? ''}\n${m.content}` +
        (m.temporal ? `\n(temporal: ${m.temporal.start ?? '?'} → ${m.temporal.end ?? '?'})` : '')
    )
    .join('\n\n');
  try {
    const merged = await parseWithTruncationRetry(
      DISTILL_THREAD_PROMPT,
      distillConsolidatePrompt(collected.length, listing),
      {
        maxTokens:
          opts.extractMaxTokens === DISTILL_MAX_OUTPUT_TOKENS
            ? DISTILL_MAX_OUTPUT_TOKENS
            : DISTILL_CONSOLIDATE_MAX_TOKENS,
        stage: 'consolidate',
      },
      '1/1'
    );
    if (merged.length > 0) return merged.slice(0, CONSOLIDATE_ABOVE);
  } catch {
    // 提取结果已完整；合并截断只放弃重写并回退 top-3，不应让整轮重跑。
  }
  return [...collected].sort((a, b) => b.importance - a.importance).slice(0, CONSOLIDATE_ABOVE);
}

// ---------------------------------------------------------------------------
// 任务表（复用 memory_jobs，kind='distill'）
// ---------------------------------------------------------------------------

const KIND = 'distill';
export type DistillStatus = 'pending' | 'running' | 'done' | 'cancelled';

export interface DistillPayload {
  sessionId: string;
  /**
   * 建任务时的记忆语言。必须跟着任务走而不是读当前设置：
   * 指纹含语言，续跑旧任务时若用「当前」语言复算，改过语言后老任务会被误判成「原文已变」而作废。
   */
  language?: string;
  /** 会话 jsonl 相对 sessions 根目录的路径（Main 权威）；重启续跑时据此重读 */
  sessionFile: string;
  projectId: string | null;
}

/** 每条被丢弃 / 未写入的蒸馏结果的结构化原因；设置页可直接展示 */
export interface DistillNote {
  kind: 'low_importance' | 'candidates_found' | 'deduplicated' | 'rejected';
  title: string | null;
  detail: string;
}

export interface DistillJob {
  id: number;
  /** `${sessionId}#${sha256(transcript)}` —— 幂等键 */
  fingerprint: string;
  payload: DistillPayload;
  status: DistillStatus;
  /** 已尝试次数（LLM 阶段暂时性失败会加一并保留 pending） */
  attempts: number;
  /** 蒸馏出的条目数 */
  total: number;
  /** 实际写入条数 */
  done: number;
  /** 丢弃条数（importance 不足 / 候选网命中 / 校验拒绝），逐条原因见 notes */
  failed: number;
  /** 最近一次暂时性失败的原因；成功收尾后为 null */
  error: string | null;
  notes: DistillNote[];
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: number;
  target: string;
  payload: string | null;
  status: DistillStatus;
  cursor: number;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toJob(r: JobRow): DistillJob {
  const payload: DistillPayload = {
    sessionId: r.target.split('#')[0] ?? '',
    sessionFile: '',
    projectId: null,
    ...parseJson<Partial<DistillPayload>>(r.payload, {}),
  };
  const notes = parseJson<unknown>(r.notes, []);
  return {
    id: r.id,
    fingerprint: r.target,
    payload,
    status: r.status,
    attempts: r.cursor,
    total: r.total,
    done: r.done,
    failed: r.failed,
    error: r.error,
    notes: Array.isArray(notes) ? (notes as DistillNote[]) : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 幂等键。语言必须进指纹：同一段对话用不同语言提炼是两份不同产出，
 * 只算 sessionId + 原文的话，改完语言再点会被当成「已提炼」直接跳过。
 */
export function distillFingerprint(
  sessionId: string,
  transcript: string,
  language?: string
): string {
  // language 为 undefined = 语言功能之前建的存量任务：必须沿用旧算法，
  // 否则它们续跑时指纹一律对不上，被误判成「原文已变」全部作废
  const seed = language === undefined ? transcript : `${language}\u0000${transcript}`;
  return `${sessionId}#${createHash('sha256').update(seed, 'utf8').digest('hex')}`;
}

/**
 * 幂等建任务：同指纹（同会话同内容）只建一次。已收尾（done / cancelled）返回 null；
 * 还没跑完的（pending，或上次进程死在 running）返回原任务，让调用方接着跑——暂时性失败靠这条路重试。
 */
export function ensureDistillJob(
  db: Database.Database,
  payload: DistillPayload,
  fingerprint: string,
  opts: { force?: boolean } = {}
): DistillJob | null {
  return db
    .transaction((): DistillJob | null => {
      const exists = db
        .prepare('SELECT * FROM memory_jobs WHERE kind = ? AND target = ? LIMIT 1')
        .get(KIND, fingerprint) as JobRow | undefined;
      // force = 用户显式「重新提炼」：忽略已收尾的同指纹任务，另建一条
      if (exists && !opts.force) {
        return exists.status === 'pending' || exists.status === 'running' ? toJob(exists) : null;
      }
      if (exists && (exists.status === 'pending' || exists.status === 'running')) {
        return toJob(exists);
      }
      const now = new Date().toISOString();
      const info = db
        .prepare(
          `INSERT INTO memory_jobs (kind, target, payload, status, cursor, total, done, failed, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, 0, 0, 0, ?, ?)`
        )
        .run(KIND, fingerprint, JSON.stringify(payload), now, now);
      return toJob(
        db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(info.lastInsertRowid) as JobRow
      );
    })
    .immediate();
}

/** 重启后要续跑的任务：pending 与上次进程死在半路的 running */
export function listResumableDistillJobs(db: Database.Database): DistillJob[] {
  return (
    db
      .prepare(
        `SELECT * FROM memory_jobs WHERE kind = ? AND status IN ('pending','running') ORDER BY id ASC`
      )
      .all(KIND) as JobRow[]
  ).map(toJob);
}

/** 设置页出口：最近的蒸馏任务（含结构化 notes），新在前 */
export function listDistillJobs(db: Database.Database, limit = 50): DistillJob[] {
  return (
    db
      .prepare('SELECT * FROM memory_jobs WHERE kind = ? ORDER BY id DESC LIMIT ?')
      .all(KIND, Math.max(1, Math.floor(limit))) as JobRow[]
  ).map(toJob);
}

export interface RunDistillOptions {
  /** 调用方从权威 jsonl 重建的对话文本（已打码）；与任务指纹不符则任务作废 */
  transcript: string;
  complete: Complete;
  embedder?: Embedder | null;
  now?: Date;
  spaceId?: string;
  /** 透传 createMemory 的 on_memory_created hook（蒸馏出的记忆同样要排 KG 抽取） */
  onCreated?: (memory: Memory) => void;
}

/**
 * 跑一个蒸馏任务：LLM → 解析 → 逐条走 createMemory 完整写路径（content_hash / 候选网 / evolves）。
 * LLM 阶段的失败（provider 不可用 / 超时 / 输出不可解析）是暂时性的：attempts+1、保留 pending 记 error，
 * 下次 parent-ended 或开库时重试，超过 DISTILL_MAX_ATTEMPTS 才标 done。模型正常返回但无产出是确定性的，直接 done。
 * 候选网返回 candidates_found 时保守放弃该条，原因进结构化 notes。绝不抛出。
 */
export async function runDistillJob(
  db: Database.Database,
  job: DistillJob,
  opts: RunDistillOptions
): Promise<DistillJob> {
  const set = db.prepare(
    `UPDATE memory_jobs SET status = ?, cursor = ?, total = ?, done = ?, failed = ?, error = ?, notes = ?, updated_at = ?
     WHERE id = ?`
  );
  const reread = () =>
    toJob(db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(job.id) as JobRow);
  const finish = (
    status: DistillStatus,
    attempts: number,
    counts: { total: number; done: number; failed: number },
    error: string | null,
    notes: DistillNote[]
  ) => {
    set.run(
      status,
      attempts,
      counts.total,
      counts.done,
      counts.failed,
      error,
      notes.length ? JSON.stringify(notes) : null,
      new Date().toISOString(),
      job.id
    );
    return reread();
  };
  const zero = { total: 0, done: 0, failed: 0 };

  // 用任务自己的语言复算，不看当前设置（见 DistillPayload.language）
  // 存量任务没有这个字段，原样传 undefined 走旧算法
  const jobLanguage = job.payload.language;
  if (distillFingerprint(job.payload.sessionId, opts.transcript, jobLanguage) !== job.fingerprint) {
    return finish(
      'cancelled',
      job.attempts,
      zero,
      'transcript changed since the job was created',
      []
    );
  }
  const attempts = job.attempts + 1;
  finish('running', attempts, zero, null, []);

  let distilled: DistilledMemory[];
  try {
    distilled = await distillTranscript(opts.transcript, opts.complete, {
      language: jobLanguage ?? 'en',
      extractMaxTokens: attempts >= 2 ? DISTILL_MAX_OUTPUT_TOKENS : undefined,
    });
  } catch (error) {
    const message = `distill failed: ${error instanceof Error ? error.message : String(error)}`;
    return finish(
      attempts >= DISTILL_MAX_ATTEMPTS ? 'done' : 'pending',
      attempts,
      zero,
      message,
      []
    );
  }

  const spaceId = opts.spaceId ?? 'global';
  const notes: DistillNote[] = [];
  const note = (kind: DistillNote['kind'], m: DistilledMemory, detail: string) =>
    notes.push({ kind, title: m.title ?? m.content.slice(0, 40), detail });
  let written = 0;
  for (const m of distilled) {
    const input = toCreateInput(m, spaceId);
    if (!input) {
      note('low_importance', m, `importance ${m.importance} < ${DISTILL_MIN_IMPORTANCE}`);
      continue;
    }
    try {
      const result = await createMemory(db, input, {
        embedder: opts.embedder ?? null,
        now: opts.now,
        onCreated: opts.onCreated,
      });
      if (result.status === 'inserted' && result.deduplicated) {
        note('deduplicated', m, `content_hash matches ${result.memory.id}`);
      } else if (result.status === 'inserted') written++;
      else {
        note(
          'candidates_found',
          m,
          `${result.candidates.length} near-duplicate(s): ${result.candidates.map((c) => c.memory.id).join(', ')}`
        );
      }
    } catch (error) {
      note('rejected', m, error instanceof Error ? error.message : String(error));
    }
  }
  return finish(
    'done',
    attempts,
    { total: distilled.length, done: written, failed: notes.length },
    null,
    notes
  );
}

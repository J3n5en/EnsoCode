import type { SearchIntent } from './searchIntent';
import type { TemporalIntent } from './temporalIntent';

export const SEARCH_LLM_TIMEOUT_MS = 1500;
export const SEARCH_LLM_RERANK_MAX = 8;
export const SEARCH_LLM_BACKOFF_MS = 30_000;

const LLM_INTENTS = [
  'concept_lookup',
  'factual_query',
  'conceptual_question',
  'relationship_query',
  'exploratory_search',
] as const;
type LlmIntent = (typeof LLM_INTENTS)[number];

export interface SearchAnalysis {
  intent: SearchIntent;
  entityTerms: string[];
  confidence: number;
  temporal: TemporalIntent | null;
}

export function mapLlmIntent(value: string): SearchIntent {
  if (value === 'relationship_query') return 'relationship';
  if (value === 'conceptual_question' || value === 'exploratory_search') return 'conceptual';
  return 'factual';
}

function asObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function querySubstrings(query: string, values: unknown, max: number): string[] {
  if (!Array.isArray(values)) return [];
  const lower = query.toLowerCase();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const term = value.trim();
    if (!term || !lower.includes(term.toLowerCase())) continue;
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

export function parseSearchAnalysis(raw: string, query: string): SearchAnalysis | null {
  const obj = asObject(raw);
  if (!obj || typeof obj.intent !== 'string') return null;
  if (!(LLM_INTENTS as readonly string[]).includes(obj.intent)) return null;
  const confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? Math.min(1, Math.max(0, obj.confidence))
      : 0.5;
  return {
    intent: mapLlmIntent(obj.intent as LlmIntent),
    entityTerms: querySubstrings(query, obj.entity_terms ?? obj.entityTerms, 3),
    confidence,
    temporal: parseTemporal(obj),
  };
}

function parseTemporal(obj: Record<string, unknown>): TemporalIntent | null {
  if (obj.has_temporal_intent !== true) return null;
  const confidence =
    typeof obj.temporal_confidence === 'number' && Number.isFinite(obj.temporal_confidence)
      ? Math.min(1, Math.max(0, obj.temporal_confidence))
      : 0.5;
  const type = obj.temporal_type;
  if (type === 'year') {
    const raw =
      typeof obj.temporal_value === 'string'
        ? obj.temporal_value
        : obj.temporal_value != null
          ? JSON.stringify(obj.temporal_value)
          : '';
    const year = /\b((?:19|20)\d{2})\b/.exec(raw);
    if (year) return { type: 'year', value: year[1], confidence };
  }
  if (type === 'relative' || type === 'range' || type === 'context' || type === 'reference') {
    return { type: 'relative', value: null, confidence };
  }
  return null;
}

export function parseRerankScores(raw: string, expected: number): number[] | null {
  const obj = asObject(raw);
  if (!obj || !Array.isArray(obj.scores) || obj.scores.length !== expected) return null;
  const scores: number[] = [];
  for (const value of obj.scores) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    scores.push(Math.min(10, Math.max(0, value)));
  }
  return scores;
}

export function termCoverage(query: string, text: string): number {
  const hay = text.toLowerCase();
  const parts = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const terms =
    parts.length > 0 ? parts : query.trim().length >= 2 ? [query.trim().toLowerCase()] : [];
  if (terms.length === 0) return 0;
  return terms.filter((term) => hay.includes(term)).length / terms.length;
}

/** grounded = min(llm/10, coverage); final = grounded*0.55 + orig*0.25 + coverage*0.2 */
export function blendRerankScore(llm: number, origNorm: number, coverage: number): number {
  const grounded = Math.min(llm / 10, coverage);
  return grounded * 0.55 + origNorm * 0.25 + coverage * 0.2;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => value,
        () => null
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SearchLlmGate {
  private until = 0;
  constructor(
    private readonly backoffMs = SEARCH_LLM_BACKOFF_MS,
    private readonly now: () => number = Date.now
  ) {}
  available(): boolean {
    return this.now() >= this.until;
  }
  trip(): void {
    this.until = this.now() + this.backoffMs;
  }
}

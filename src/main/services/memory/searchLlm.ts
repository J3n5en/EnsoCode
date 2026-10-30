import {
  completeWithin,
  parseRerankScores,
  parseSearchAnalysis,
  SEARCH_LLM_RERANK_MAX,
  SEARCH_LLM_TIMEOUT_MS,
  type SearchAssistReason,
  type SearchAssistReport,
  SearchLlmGate,
} from '@shared/memory/searchAssist';
import type { Complete } from './distill';
import type { SearchAssist } from './types';

const ANALYZE_SYSTEM =
  'Classify a memory-search query. Reply JSON only, no markdown: ' +
  '{"intent":"concept_lookup|factual_query|conceptual_question|relationship_query|exploratory_search",' +
  '"entity_terms":[],"confidence":0-1,' +
  '"has_temporal_intent":false,"temporal_type":null,"temporal_value":null,"temporal_confidence":0}. ' +
  'entity_terms: up to 3 substrings of the query, no translation. ' +
  'temporal_type is year|range|relative|context|reference when the query mentions time.';

const RERANK_SYSTEM =
  'Score each memory 0-10 for the query. Reply JSON only: {"scores":[...]} in the same order. No extra keys.';

const gate = new SearchLlmGate();

function budgetMs(complete: Complete): number {
  const value = complete.searchTimeoutMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : SEARCH_LLM_TIMEOUT_MS;
}

export function createSearchAssist(
  complete: Complete | null,
  opts?: { gate?: SearchLlmGate }
): SearchAssist | null {
  if (!complete) return null;
  const llmGate = opts?.gate ?? gate;
  const timeoutMs = budgetMs(complete);
  let succeeded = false;
  let failure: SearchAssistReason | undefined;
  const fail = (reason: SearchAssistReason, trip: boolean) => {
    failure ??= reason;
    if (trip) llmGate.trip();
  };
  const call = async (system: string, user: string): Promise<string | null> => {
    const result = await completeWithin((signal) => complete(system, user, { signal }), timeoutMs);
    if (!result.ok) {
      fail(result.reason, true);
      return null;
    }
    return result.value;
  };
  return {
    async analyze(query) {
      if (!llmGate.available()) {
        fail('backoff', false);
        return null;
      }
      const raw = await call(ANALYZE_SYSTEM, query);
      if (raw == null) return null;
      const parsed = parseSearchAnalysis(raw, query);
      if (!parsed) {
        fail('unparseable', false);
        return null;
      }
      succeeded = true;
      return parsed;
    },
    async rerank(query, items) {
      const window = items.slice(0, SEARCH_LLM_RERANK_MAX);
      if (window.length === 0) return null;
      if (!llmGate.available()) {
        fail('backoff', false);
        return null;
      }
      const listing = window
        .map((item, i) => `${i + 1}. ${item.title}\n${item.content}`)
        .join('\n\n');
      const raw = await call(RERANK_SYSTEM, `Query: ${query}\n\n${listing}`);
      if (raw == null) return null;
      const scores = parseRerankScores(raw, window.length);
      if (!scores) {
        fail('unparseable', false);
        return null;
      }
      succeeded = true;
      return scores;
    },
    outcome(): SearchAssistReport {
      if (succeeded) return { assist: 'llm' };
      if (failure) return { assist: 'fallback', assistReason: failure };
      return { assist: 'off' };
    },
  };
}

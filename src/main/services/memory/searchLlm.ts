import {
  parseRerankScores,
  parseSearchAnalysis,
  SEARCH_LLM_RERANK_MAX,
  SEARCH_LLM_TIMEOUT_MS,
  SearchLlmGate,
  withTimeout,
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

export function createSearchAssist(complete: Complete | null): SearchAssist | null {
  if (!complete) return null;
  return {
    async analyze(query) {
      if (!gate.available()) return null;
      const raw = await withTimeout(complete(ANALYZE_SYSTEM, query), SEARCH_LLM_TIMEOUT_MS);
      if (raw == null) {
        gate.trip();
        return null;
      }
      return parseSearchAnalysis(raw, query);
    },
    async rerank(query, items) {
      const window = items.slice(0, SEARCH_LLM_RERANK_MAX);
      if (!gate.available() || window.length === 0) return null;
      const listing = window
        .map((item, i) => `${i + 1}. ${item.title}\n${item.content}`)
        .join('\n\n');
      const raw = await withTimeout(
        complete(RERANK_SYSTEM, `Query: ${query}\n\n${listing}`),
        SEARCH_LLM_TIMEOUT_MS
      );
      if (raw == null) {
        gate.trip();
        return null;
      }
      return parseRerankScores(raw, window.length);
    },
  };
}

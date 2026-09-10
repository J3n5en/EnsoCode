import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blendRerankScore,
  mapLlmIntent,
  parseRerankScores,
  parseSearchAnalysis,
  SearchLlmGate,
  termCoverage,
  withTimeout,
} from './searchAssist';

describe('mapLlmIntent', () => {
  it('maps Nowledge intents onto local channel weights', () => {
    expect(mapLlmIntent('relationship_query')).toBe('relationship');
    expect(mapLlmIntent('conceptual_question')).toBe('conceptual');
    expect(mapLlmIntent('exploratory_search')).toBe('conceptual');
    expect(mapLlmIntent('factual_query')).toBe('factual');
    expect(mapLlmIntent('concept_lookup')).toBe('factual');
  });
});

describe('parseSearchAnalysis', () => {
  it('accepts JSON and keeps only query-substring entity terms', () => {
    const parsed = parseSearchAnalysis(
      '{"intent":"relationship_query","entity_terms":["Postgres","Redis","translated"],"confidence":0.8}',
      'how Postgres relates to Redis'
    );
    expect(parsed).toEqual({
      intent: 'relationship',
      entityTerms: ['Postgres', 'Redis'],
      confidence: 0.8,
      temporal: null,
    });
  });

  it('抽出时间意图：year 取四位年份，其余落到 relative', () => {
    expect(
      parseSearchAnalysis(
        '{"intent":"factual_query","has_temporal_intent":true,"temporal_type":"year","temporal_value":"2020","temporal_confidence":0.95}',
        'what happened in 2020'
      )?.temporal
    ).toEqual({ type: 'year', value: '2020', confidence: 0.95 });
    expect(
      parseSearchAnalysis(
        '{"intent":"conceptual_question","has_temporal_intent":true,"temporal_type":"relative","temporal_value":{"days":30},"temporal_confidence":0.8}',
        'recent changes'
      )?.temporal
    ).toEqual({ type: 'relative', value: null, confidence: 0.8 });
  });

  it('rejects unknown intent or non-JSON', () => {
    expect(parseSearchAnalysis('{"intent":"hyde"}', 'q')).toBeNull();
    expect(parseSearchAnalysis('not json', 'q')).toBeNull();
  });
});

describe('parseRerankScores', () => {
  it('clamps 0–10 and requires exact length', () => {
    expect(parseRerankScores('{"scores":[-1, 11, 5]}', 3)).toEqual([0, 10, 5]);
    expect(parseRerankScores('{"scores":[1, 2]}', 3)).toBeNull();
    expect(parseRerankScores('{"scores":[1, "x"]}', 2)).toBeNull();
  });
});

describe('termCoverage / blendRerankScore', () => {
  it('does not trust a naked LLM score without query-term coverage', () => {
    expect(termCoverage('Postgres replica', 'unrelated kafka topic')).toBe(0);
    expect(blendRerankScore(10, 1, 0)).toBeCloseTo(0.25, 12);
    expect(blendRerankScore(10, 1, 1)).toBeCloseTo(1, 12);
  });
});

describe('withTimeout / SearchLlmGate', () => {
  afterEach(() => vi.useRealTimers());

  it('returns null on timeout or rejection', async () => {
    vi.useFakeTimers();
    const hung = withTimeout(new Promise<string>(() => {}), 1500);
    vi.advanceTimersByTime(1500);
    await expect(hung).resolves.toBeNull();
    await expect(withTimeout(Promise.reject(new Error('boom')), 1500)).resolves.toBeNull();
  });

  it('skips the whole assist window after a trip', () => {
    let now = 0;
    const gate = new SearchLlmGate(30_000, () => now);
    expect(gate.available()).toBe(true);
    gate.trip();
    expect(gate.available()).toBe(false);
    now = 29_999;
    expect(gate.available()).toBe(false);
    now = 30_000;
    expect(gate.available()).toBe(true);
  });
});

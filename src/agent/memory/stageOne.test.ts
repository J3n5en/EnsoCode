import { describe, expect, it } from 'vitest';
import {
  parseStageOneResponse,
  selectStageOneCandidates,
  type StageOneCandidate,
} from './stageOne';

const HOUR = 3600;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000;

function candidate(overrides: Partial<StageOneCandidate>): StageOneCandidate {
  return {
    threadId: 't1',
    sessionFile: '/sessions/t1.jsonl',
    cwd: '/proj',
    updatedAtSec: NOW - 20 * HOUR,
    sourceKind: 'parent',
    ...overrides,
  };
}

describe('selectStageOneCandidates', () => {
  it('skips currentThreadId', () => {
    const threads = [candidate({ threadId: 'current' }), candidate({ threadId: 'other' })];
    const result = selectStageOneCandidates(threads, { nowSec: NOW, currentThreadId: 'current' });
    expect(result.map((t) => t.threadId)).toEqual(['other']);
  });

  it('skips sourceKind coworker and child', () => {
    const threads = [
      candidate({ threadId: 'a', sourceKind: 'coworker' }),
      candidate({ threadId: 'b', sourceKind: 'child' }),
      candidate({ threadId: 'c', sourceKind: 'parent' }),
    ];
    const result = selectStageOneCandidates(threads, { nowSec: NOW });
    expect(result.map((t) => t.threadId)).toEqual(['c']);
  });

  it('skips too-fresh threads (within min idle 12h)', () => {
    const threads = [candidate({ threadId: 'fresh', updatedAtSec: NOW - 11 * HOUR })];
    const result = selectStageOneCandidates(threads, { nowSec: NOW });
    expect(result).toEqual([]);
  });

  it('skips too-old threads (older than 30 days)', () => {
    const threads = [candidate({ threadId: 'old', updatedAtSec: NOW - 31 * DAY })];
    const result = selectStageOneCandidates(threads, { nowSec: NOW });
    expect(result).toEqual([]);
  });

  it('respects maxRolloutsPerStartup, preferring most recently updated', () => {
    const threads = [
      candidate({ threadId: 'a', updatedAtSec: NOW - 20 * HOUR }),
      candidate({ threadId: 'b', updatedAtSec: NOW - 15 * HOUR }),
      candidate({ threadId: 'c', updatedAtSec: NOW - 25 * HOUR }),
    ];
    const result = selectStageOneCandidates(threads, { nowSec: NOW, maxRolloutsPerStartup: 2 });
    expect(result.map((t) => t.threadId)).toEqual(['b', 'a']);
  });
});

describe('parseStageOneResponse', () => {
  it('parses exact JSON with the three keys', () => {
    expect(
      parseStageOneResponse('{"rollout_summary":"s","rollout_slug":"slug","raw_memory":"r"}')
    ).toEqual({ rollout_summary: 's', rollout_slug: 'slug', raw_memory: 'r' });
  });

  it('returns undefined for extra keys, missing keys, or non-JSON', () => {
    expect(
      parseStageOneResponse(
        '{"rollout_summary":"s","rollout_slug":null,"raw_memory":"r","extra":1}'
      )
    ).toBeUndefined();
    expect(parseStageOneResponse('{"rollout_summary":"s","raw_memory":"r"}')).toBeUndefined();
    expect(parseStageOneResponse('not json')).toBeUndefined();
  });

  it('unwraps a fenced ```json block and trims whitespace', () => {
    const fenced = '```json\n{"rollout_summary":"s","rollout_slug":null,"raw_memory":"r"}\n```';
    expect(parseStageOneResponse(`  ${fenced}  `)).toEqual({
      rollout_summary: 's',
      rollout_slug: null,
      raw_memory: 'r',
    });
  });

  it('treats empty durable signal as valid, not undefined', () => {
    expect(
      parseStageOneResponse('{"rollout_summary":"","rollout_slug":null,"raw_memory":""}')
    ).toEqual({ rollout_summary: '', rollout_slug: null, raw_memory: '' });
  });
});

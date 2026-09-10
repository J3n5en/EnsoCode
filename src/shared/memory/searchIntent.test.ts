import { describe, expect, it } from 'vitest';
import { channelWeights, detectSearchIntent } from './searchIntent';

describe('detectSearchIntent', () => {
  it('关系问句优先于 how/为什么', () => {
    expect(detectSearchIntent('how Postgres relates to the database choice')).toBe('relationship');
    expect(detectSearchIntent('relationship between Redis and Kafka')).toBe('relationship');
    expect(detectSearchIntent('Postgres 和数据库选型的关系')).toBe('relationship');
  });

  it('概念问句 vs 关键词查找', () => {
    expect(detectSearchIntent('why did we pick pnpm')).toBe('conceptual');
    expect(detectSearchIntent('explain OAuth2')).toBe('conceptual');
    expect(detectSearchIntent('为什么用 pnpm')).toBe('conceptual');
    expect(detectSearchIntent('Postgres')).toBe('factual');
    expect(detectSearchIntent('pnpm workspace')).toBe('factual');
  });
});

describe('channelWeights', () => {
  it('通道顺序固定为 FTS / vector / entity / community', () => {
    expect(channelWeights('factual')).toEqual([1.2, 1, 0.8, 0.4]);
    expect(channelWeights('conceptual')).toEqual([0.8, 1.2, 0.8, 1]);
    expect(channelWeights('relationship')).toEqual([0.8, 1, 1.3, 1.1]);
  });
});

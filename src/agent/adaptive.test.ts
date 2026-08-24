import { describe, expect, it } from 'vitest';
import { supportsAdaptiveThinking } from './supervisor';

describe('supportsAdaptiveThinking', () => {
  it('默认乐观支持：新模型与第三方无需维护列表', () => {
    for (const id of [
      'claude-opus-4-7',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'grok-4.6',
      'gpt-5.4',
      'some-future-model',
    ]) {
      expect(supportsAdaptiveThinking(id)).toBe(true);
    }
  });

  it('封闭黑名单：不支持 adaptive 的历史老世代走 budget', () => {
    for (const id of [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-6',
      'claude-3-5-sonnet',
    ]) {
      expect(supportsAdaptiveThinking(id)).toBe(false);
    }
  });
});

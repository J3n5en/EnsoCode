import { describe, expect, it } from 'vitest';
import { supportsAdaptiveThinking } from './supervisor';

describe('supportsAdaptiveThinking', () => {
  it('opus-4.7+、Claude 5 家族与 grok 走 adaptive', () => {
    for (const id of [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'grok-4.6',
    ]) {
      expect(supportsAdaptiveThinking(id)).toBe(true);
    }
  });

  it('老模型与未验证的第三方走 budget，避免 adaptive 400', () => {
    for (const id of [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'gpt-5.4',
    ]) {
      expect(supportsAdaptiveThinking(id)).toBe(false);
    }
  });
});

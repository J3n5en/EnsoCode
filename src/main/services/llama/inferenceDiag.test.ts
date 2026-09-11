import { describe, expect, it } from 'vitest';
import { addThoughtChunk, publicInferenceDiag, tokenMeterDelta } from './inferenceDiag';

describe('tokenMeterDelta', () => {
  it('subtracts snapshots without going negative', () => {
    expect(
      tokenMeterDelta(
        { usedInputTokens: 10, usedOutputTokens: 2 },
        { usedInputTokens: 40, usedOutputTokens: 22 }
      )
    ).toEqual({ inputTokens: 30, outputTokens: 20 });
    expect(tokenMeterDelta(undefined, undefined)).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
    expect(tokenMeterDelta(undefined, { usedInputTokens: 4, usedOutputTokens: 1 })).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
    expect(
      tokenMeterDelta(
        { usedInputTokens: 5, usedOutputTokens: 5 },
        { usedInputTokens: 3, usedOutputTokens: 1 }
      )
    ).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('addThoughtChunk', () => {
  it('counts only thought segments and never stores the text', () => {
    const stats = { thoughtChars: 0, thoughtTokens: 0 };
    addThoughtChunk(stats, {
      type: undefined,
      segmentType: undefined,
      text: 'visible json',
      tokens: [1, 2],
    });
    addThoughtChunk(stats, { type: 'segment', segmentType: 'comment', text: 'note', tokens: [3] });
    addThoughtChunk(stats, {
      type: 'segment',
      segmentType: 'thought',
      text: 'hidden chain',
      tokens: [4, 5, 6],
    });
    expect(stats).toEqual({ thoughtChars: 12, thoughtTokens: 3 });
    expect(JSON.stringify(stats)).not.toContain('hidden');
    expect(JSON.stringify(stats)).not.toContain('visible');
  });
});

describe('publicInferenceDiag', () => {
  it('drops unknown keys so leaked prompt text cannot ride along', () => {
    const out = publicInferenceDiag({
      inputTokens: 1,
      outputTokens: 2,
      firstTokenMs: 3,
      promptMs: 4,
      thoughtChars: 0,
      thoughtTokens: 0,
      gpu: 'metal',
      gpuLayers: 37,
      flashAttentionConfig: 'auto',
      finalTextChars: 9,
      prompt: 'do not log me',
    } as never);
    expect(out).not.toHaveProperty('prompt');
    expect(JSON.stringify(out)).not.toContain('do not log');
    expect(out.gpuLayers).toBe(37);
  });
});

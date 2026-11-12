import { describe, expect, it } from 'vitest';
import { type GenerationElapsedInput, generationElapsedOrigin } from './generationElapsed';

/** 脚点读数。没有起点则不显示；有起点则是距现在的毫秒，不看可见输出心跳。 */
function shownElapsedMs(input: GenerationElapsedInput, now: number): number | undefined {
  const origin = generationElapsedOrigin(input);
  return origin === undefined ? undefined : now - origin;
}

describe('generationElapsedOrigin', () => {
  const start = 1_700_000_000_000;

  it('思考心跳刷到现在时读数仍从本轮起点走，切到正文不回到 0', () => {
    const thinkingNow = start + 40_000;
    const textNow = start + 52_000;
    const thinking = generationElapsedOrigin({
      runStartedAt: start,
      lastOutputAt: thinkingNow,
      phase: 'thinking',
    });
    const text = generationElapsedOrigin({
      runStartedAt: start,
      lastOutputAt: textNow,
      phase: 'text',
    });

    expect(thinking).toBe(start);
    expect(text).toBe(thinking);
    expect(
      shownElapsedMs(
        { runStartedAt: start, lastOutputAt: thinkingNow, phase: 'thinking' },
        thinkingNow
      )
    ).toBe(40_000);
    expect(
      shownElapsedMs({ runStartedAt: start, lastOutputAt: textNow, phase: 'text' }, textNow)
    ).toBe(52_000);
  });

  it('不同轮次各用自己的起点，后一轮不沿用前一轮的心跳', () => {
    const first = generationElapsedOrigin({
      runStartedAt: 1_000,
      lastOutputAt: 8_500,
      phase: 'thinking',
    });
    const second = generationElapsedOrigin({
      runStartedAt: 9_000,
      lastOutputAt: 8_500,
      phase: 'text',
    });

    expect(first).toBe(1_000);
    expect(second).toBe(9_000);
    expect(second).not.toBe(first);
    expect(
      shownElapsedMs({ runStartedAt: 1_000, lastOutputAt: 8_500, phase: 'thinking' }, 5_000)
    ).toBe(4_000);
    expect(
      shownElapsedMs({ runStartedAt: 9_000, lastOutputAt: 8_500, phase: 'text' }, 12_000)
    ).toBe(3_000);
  });

  it('没有本轮起点时不退回 lastOutputAt，避免思考心跳把读数钉在 0s', () => {
    expect(shownElapsedMs({ lastOutputAt: 5_000, phase: 'thinking' }, 5_040)).toBeUndefined();
  });

  it('冷会话加载不产生生成起点，即使已经带了本轮起点也不计时', () => {
    expect(
      generationElapsedOrigin({
        loading: true,
        runStartedAt: 1_000,
        lastOutputAt: 1_040,
        phase: 'thinking',
      })
    ).toBeUndefined();
    expect(
      shownElapsedMs(
        { loading: true, runStartedAt: 1_000, lastOutputAt: 8_000, phase: 'text' },
        9_000
      )
    ).toBeUndefined();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { currentExitInterruption, exitInterruptionOf, setExitInterruption } from './exitWindow';

const STREAM_ERROR = 'OpenAI Responses stream ended before a terminal response event';
const interruption = { at: 10_000, kind: 'update' as const, window: { from: 0, to: 20_000 } };

describe('exitInterruptionOf', () => {
  afterEach(() => setExitInterruption(null));

  it('没有退出记录时一律不归到中断', () => {
    expect(exitInterruptionOf(STREAM_ERROR, 5_000)).toBeNull();
  });

  it('窗口内的断流错误归到中断', () => {
    setExitInterruption(interruption);
    expect(exitInterruptionOf(STREAM_ERROR, 15_000)).toEqual(interruption);
    expect(currentExitInterruption()).toEqual(interruption);
  });

  it('窗口外的同一类错误仍按失败处理', () => {
    setExitInterruption(interruption);
    expect(exitInterruptionOf(STREAM_ERROR, 20_001)).toBeNull();
  });

  it('鉴权与限流错误即使落在窗口内也不归到中断', () => {
    setExitInterruption(interruption);
    expect(exitInterruptionOf('401 invalid api key', 15_000)).toBeNull();
    expect(exitInterruptionOf('429 rate limit', 15_000)).toBeNull();
    expect(exitInterruptionOf(undefined, 15_000)).toBeNull();
  });
});

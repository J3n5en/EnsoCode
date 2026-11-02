import { describe, expect, it } from 'vitest';
import { ComputerError, computerErrorRetry, ReadOnlyError, StaleRefError } from './errors';

describe('ComputerError retry 处置', () => {
  it('按 code 推导是否可重试', () => {
    expect(new StaleRefError('e3').retry).toBe('reobserve');
    expect(new ReadOnlyError('click').retry).toBe('never');
    expect(new ComputerError('ax-worker-exited', 'x').retry).toBe('safe');
    expect(new ComputerError('lease-busy', 'x').retry).toBe('later');
    expect(computerErrorRetry('no-such-code')).toBeUndefined();
  });

  it('显式 retry 覆盖默认', () => {
    expect(new ComputerError('unsupported', 'x', 'safe').retry).toBe('safe');
  });

  it('StaleRef 默认文案仍可被识别为过期', () => {
    expect(new StaleRefError('e3').message).toBe('e3 expired; re-run ax()/find()');
  });
});

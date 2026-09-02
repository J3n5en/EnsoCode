import { describe, expect, it } from 'vitest';
import { assertDevtoolsIdle, DEVTOOLS_BUSY_ERROR } from './devtools';

describe('assertDevtoolsIdle', () => {
  it('关着 DevTools 时不抛', () => {
    expect(() => assertDevtoolsIdle(false)).not.toThrow();
  });

  it('开着时抛固定错误，agent 能读懂该关控制台', () => {
    expect(() => assertDevtoolsIdle(true)).toThrow(DEVTOOLS_BUSY_ERROR);
  });
});

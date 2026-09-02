import { describe, expect, it } from 'vitest';
import { isBrowserPartition, partitionName } from './browserHost';

describe('partitionName', () => {
  it('dev 与打包版分罐，且都是 persist', () => {
    expect(partitionName(true)).toBe('persist:enso-browser');
    expect(partitionName(false)).toBe('persist:enso-dev-browser');
    expect(isBrowserPartition(partitionName(true))).toBe(true);
    expect(isBrowserPartition(partitionName(false))).toBe(true);
  });
  it('clear 只认我们自己的罐', () => {
    expect(isBrowserPartition('persist:enso')).toBe(false);
    expect(isBrowserPartition('enso-browser')).toBe(false);
    expect(isBrowserPartition('')).toBe(false);
  });
});

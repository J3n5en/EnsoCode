import { describe, expect, it } from 'vitest';
import { cloneTitle } from './botText';

describe('cloneTitle', () => {
  it('重名时依次加序号', () => {
    expect(cloneTitle('team 的副本', ['team'])).toBe('team 的副本');
    expect(cloneTitle('team 的副本', ['team 的副本'])).toBe('team 的副本 2');
    expect(cloneTitle('team 的副本', ['team 的副本', 'team 的副本 2'])).toBe('team 的副本 3');
  });
});

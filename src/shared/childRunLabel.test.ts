import { describe, expect, it } from 'vitest';
import { childRunLabel } from './childRunLabel';

describe('childRunLabel', () => {
  it('有任务标题时用标题，否则去掉实例名末尾的 8 位哈希', () => {
    expect(childRunLabel({ name: 'exp-invite-0cd21319', title: '探测邀请接口' })).toBe(
      '探测邀请接口'
    );
    expect(childRunLabel({ name: 'exp-sqli3-371654bd' })).toBe('exp-sqli3');
    expect(childRunLabel({ name: 'Scout · a1' })).toBe('Scout · a1');
    expect(childRunLabel({ name: '-0cd21319' })).toBe('-0cd21319');
    expect(childRunLabel({ name: 'exp-invite-0cd21319', title: '   ' })).toBe('exp-invite');
  });
});

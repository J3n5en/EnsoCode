import { describe, expect, it } from 'vitest';
import { pushSlash, splitSlashChain } from './slashChain';

describe('pushSlash', () => {
  it('skill 追加到已有 skill 后，重复的忽略', () => {
    expect(pushSlash(['/skill:a'], '/skill:b')).toEqual(['/skill:a', '/skill:b']);
    expect(pushSlash(['/skill:a'], '/skill:a')).toEqual(['/skill:a']);
  });

  it('非 skill 命令独占', () => {
    expect(pushSlash(['/skill:a'], '/goal')).toEqual(['/goal']);
    expect(pushSlash(['/goal'], '/skill:a')).toEqual(['/skill:a']);
  });
});

describe('splitSlashChain', () => {
  it('拆出开头连续的 skill 或单个命令', () => {
    expect(splitSlashChain('/skill:a /skill:b 做事')).toEqual({
      slashes: ['/skill:a', '/skill:b'],
      rest: '做事',
    });
    expect(splitSlashChain('/goal 跑完')).toEqual({ slashes: ['/goal'], rest: '跑完' });
    expect(splitSlashChain('做事')).toEqual({ slashes: [], rest: '做事' });
  });
});

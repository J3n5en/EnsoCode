import { describe, expect, it } from 'vitest';
import { tabTitleFromTerminal } from './terminalTitle';

describe('tabTitleFromTerminal', () => {
  it('空串忽略', () => {
    expect(tabTitleFromTerminal('')).toBe('');
    expect(tabTitleFromTerminal('\x1b')).toBe('');
  });

  it('进程名原样保留', () => {
    expect(tabTitleFromTerminal('npm')).toBe('npm');
    expect(tabTitleFromTerminal('vim')).toBe('vim');
  });

  it('路径取末段', () => {
    expect(tabTitleFromTerminal('~/src/enso-code')).toBe('enso-code');
    expect(tabTitleFromTerminal('/Users/j3n5en/project/bot2api')).toBe('bot2api');
  });

  it('user@host: cwd 取目录末段', () => {
    expect(tabTitleFromTerminal('j3n5en@mac: ~/src/enso-code')).toBe('enso-code');
  });
});

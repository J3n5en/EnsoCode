import { describe, expect, it } from 'vitest';
import { pickSessionCwd, resolvePtySize } from './terminalService';

const exists = (dir: string) => dir === '/wt' || dir === '/proj';

describe('pickSessionCwd', () => {
  it('隔离会话用 worktree,不用项目根', () => {
    expect(
      pickSessionCwd({
        worktreePath: '/wt',
        projectPath: '/proj',
        home: '/home',
        exists,
      })
    ).toBe('/wt');
  });

  it('无 worktree 时用本地项目根,不落到 home', () => {
    expect(
      pickSessionCwd({ worktreePath: undefined, projectPath: '/proj', home: '/home', exists })
    ).toBe('/proj');
  });

  it('ssh 项目根是远端路径,不采用,无 worktree 时回落 home', () => {
    expect(
      pickSessionCwd({
        worktreePath: undefined,
        projectPath: '/opt/bot2api',
        ssh: true,
        home: '/home',
        exists: () => true,
      })
    ).toBe('/home');
  });

  it('worktree 目录已不存在时回落项目根', () => {
    expect(
      pickSessionCwd({
        worktreePath: '/gone',
        projectPath: '/proj',
        home: '/home',
        exists,
      })
    ).toBe('/proj');
  });
});

describe('resolvePtySize', () => {
  it('缺省落到 80x24', () => {
    expect(resolvePtySize()).toEqual({ cols: 80, rows: 24 });
  });

  it('0 或负数不当成有效尺寸', () => {
    expect(resolvePtySize(0, 0)).toEqual({ cols: 80, rows: 24 });
    expect(resolvePtySize(-1, 12)).toEqual({ cols: 80, rows: 12 });
  });
});

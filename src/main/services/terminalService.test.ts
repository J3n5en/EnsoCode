import { describe, expect, it } from 'vitest';
import { pickSessionCwd } from './terminalService';

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

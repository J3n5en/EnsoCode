import { describe, expect, it, vi } from 'vitest';
import {
  createPtyQuitDrain,
  pickSessionCwd,
  resolvePtySize,
  runPtyQuitIdle,
  withUtf8Locale,
} from './terminalService';

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

describe('withUtf8Locale', () => {
  it('Finder 启动常见的空 locale 补成 UTF-8，不掉 TERM', () => {
    const next = withUtf8Locale({ TERM: 'xterm-256color', TERM_PROGRAM: 'EnsoCode' });
    expect(next.TERM).toBe('xterm-256color');
    expect(next.LANG).toMatch(/utf-?8/i);
    expect(next.LC_CTYPE).toMatch(/utf-?8/i);
    expect(next.LC_ALL).toBeUndefined();
  });

  it('已是 UTF-8 的 LANG 不改', () => {
    expect(withUtf8Locale({ LANG: 'zh_CN.UTF-8' }).LANG).toBe('zh_CN.UTF-8');
  });

  it('LANG=C / POSIX 换成 UTF-8', () => {
    expect(withUtf8Locale({ LANG: 'C' }).LANG).toMatch(/utf-?8/i);
    expect(withUtf8Locale({ LANG: 'POSIX' }).LANG).toMatch(/utf-?8/i);
  });

  it('GBK 等非 UTF-8 编码改成 同语言.UTF-8，xterm 只走 UTF-8', () => {
    expect(withUtf8Locale({ LANG: 'zh_CN.GBK' }).LANG).toBe('zh_CN.UTF-8');
  });

  it('LC_ALL=C 会压过 LANG，必须一并改成 UTF-8', () => {
    const next = withUtf8Locale({ LANG: 'zh_CN.UTF-8', LC_ALL: 'C' });
    expect(next.LC_ALL).toMatch(/utf-?8/i);
    expect(next.LANG).toMatch(/utf-?8/i);
  });
});

describe('createPtyQuitDrain', () => {
  it('无 pending pty 时不拦截退出', () => {
    const disposeAll = vi.fn();
    const drain = createPtyQuitDrain({
      disposeAll,
      hasPending: () => false,
      waitIdle: vi.fn(async () => {}),
    });
    const preventDefault = vi.fn();
    const quit = vi.fn();
    drain.onWillQuit({ preventDefault }, quit);
    expect(disposeAll).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('有 pending 时先 preventDefault，idle 后再 quit；第二次放行', async () => {
    let pending = true;
    const drain = createPtyQuitDrain({
      disposeAll: vi.fn(),
      hasPending: () => pending,
      waitIdle: async () => {
        pending = false;
      },
    });
    const preventDefault = vi.fn();
    const quit = vi.fn();
    drain.onWillQuit({ preventDefault }, quit);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    const prevent2 = vi.fn();
    const quit2 = vi.fn();
    drain.onWillQuit({ preventDefault: prevent2 }, quit2);
    expect(prevent2).not.toHaveBeenCalled();
    expect(quit2).not.toHaveBeenCalled();
  });
});

describe('runPtyQuitIdle', () => {
  it('soft 期内已 idle 则不 forceKill', async () => {
    const forceKill = vi.fn();
    const waitUntilIdle = vi.fn(async () => {});
    await runPtyQuitIdle({
      hasPending: () => false,
      forceKill,
      waitUntilIdle,
      softMs: 40,
      hardMs: 80,
    });
    expect(waitUntilIdle).toHaveBeenCalledOnce();
    expect(waitUntilIdle).toHaveBeenCalledWith(40);
    expect(forceKill).not.toHaveBeenCalled();
  });

  it('soft 后仍 pending 则 SIGKILL 再等 hard', async () => {
    let pending = true;
    const forceKill = vi.fn(() => {
      pending = false;
    });
    const waited: number[] = [];
    await runPtyQuitIdle({
      hasPending: () => pending,
      forceKill,
      waitUntilIdle: async (ms) => {
        waited.push(ms);
      },
      softMs: 40,
      hardMs: 80,
    });
    expect(waited).toEqual([40, 80]);
    expect(forceKill).toHaveBeenCalledOnce();
  });
});

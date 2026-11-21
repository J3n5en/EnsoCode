import { describe, expect, it, vi } from 'vitest';
import { createAppQuitDrain } from './appQuitDrain';
import { createQuitWatchdog } from './appQuitWatchdog';

describe('createAppQuitDrain', () => {
  it('does not intercept quit when no step needs to wait', () => {
    const begin = vi.fn();
    const drain = createAppQuitDrain([
      { begin, shouldWait: () => false, wait: vi.fn(async () => {}) },
    ]);
    const preventDefault = vi.fn();
    const quit = vi.fn();
    drain.onWillQuit({ preventDefault }, quit);
    expect(begin).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('waits for every pending step before quit, then lets the second will-quit through', async () => {
    const order: string[] = [];
    let llama = true;
    let pty = true;
    const drain = createAppQuitDrain([
      {
        begin: () => order.push('pty-begin'),
        shouldWait: () => pty,
        wait: async () => {
          order.push('pty-wait');
          pty = false;
        },
      },
      {
        shouldWait: () => llama,
        wait: async () => {
          order.push('llama-wait');
          llama = false;
        },
      },
    ]);
    const preventDefault = vi.fn();
    const quit = vi.fn();
    drain.onWillQuit({ preventDefault }, quit);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(order).toEqual(['pty-begin', 'pty-wait', 'llama-wait']);

    const prevent2 = vi.fn();
    drain.onWillQuit({ preventDefault: prevent2 }, vi.fn());
    expect(prevent2).not.toHaveBeenCalled();
  });

  it('still quits if one waiter rejects', async () => {
    const drain = createAppQuitDrain([
      {
        shouldWait: () => true,
        wait: async () => {
          throw new Error('dispose failed');
        },
      },
    ]);
    const quit = vi.fn();
    drain.onWillQuit({ preventDefault: vi.fn() }, quit);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });

  it('收尾期间再次退出不叠加：继续拦住、不重跑各步，收完只放行一次', async () => {
    let release!: () => void;
    const begin = vi.fn();
    const wait = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const drain = createAppQuitDrain([{ begin, shouldWait: () => true, wait }]);
    const quit = vi.fn();
    drain.onWillQuit({ preventDefault: vi.fn() }, quit);
    const again = vi.fn();
    drain.onWillQuit({ preventDefault: again }, quit);
    expect(again).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    const final = vi.fn();
    drain.onWillQuit({ preventDefault: final }, quit);
    expect(final).not.toHaveBeenCalled();
  });

  it('某步同步抛错（begin / shouldWait / wait）也一定会再 quit，不会被 preventDefault 永远挡住', async () => {
    const drain = createAppQuitDrain([
      {
        begin: () => {
          throw new Error('begin');
        },
        shouldWait: () => true,
        wait: () => {
          throw new Error('sync');
        },
      },
      {
        shouldWait: () => {
          throw new Error('shouldWait');
        },
        wait: async () => {},
      },
    ]);
    const preventDefault = vi.fn();
    const quit = vi.fn();
    expect(() => drain.onWillQuit({ preventDefault }, quit)).not.toThrow();
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });

  it('报告还在等的步骤；某步永远不结束时看门狗按收尾期限强退并写明卡在它', async () => {
    vi.useFakeTimers();
    const host = { relaunch: vi.fn(), exit: vi.fn(), kill: vi.fn(), log: vi.fn() };
    const dog = createQuitWatchdog(host, { totalMs: 60_000, finishMs: 10_000, exitGraceMs: 1_000 });
    const progress: string[][] = [];
    const drain = createAppQuitDrain(
      [
        { name: '终端', shouldWait: () => true, wait: async () => {} },
        { name: 'llama', shouldWait: () => true, wait: () => new Promise<void>(() => {}) },
      ],
      (pending) => {
        progress.push(pending);
        dog.step(`will-quit 收尾：${pending.join('、')}`, { finishing: true });
      }
    );
    const quit = vi.fn();
    drain.onWillQuit({ preventDefault: vi.fn() }, quit);
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toEqual([['终端', 'llama'], ['llama']]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(quit).not.toHaveBeenCalled();
    expect(host.exit).toHaveBeenCalledOnce();
    expect(host.log.mock.calls[0][0]).toContain('卡在「will-quit 收尾：llama」');
    vi.useRealTimers();
  });
});

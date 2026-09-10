import { describe, expect, it, vi } from 'vitest';
import { createAppQuitDrain } from './appQuitDrain';

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
});

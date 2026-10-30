import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewController, type PreviewView } from './appPreviewController';

function setup(enabled = true) {
  const log: string[] = [];
  const view: PreviewView = {
    show: (input) => log.push(`show ${input.windowId} ${input.app}`),
    hide: () => log.push('hide'),
    dispose: () => log.push('dispose'),
  };
  const state = { enabled };
  const controller = new PreviewController({
    enabled: () => state.enabled,
    view: () => view,
    hideDelayMs: 1000,
  });
  const activity = (owner: string, windowId = 'w1') =>
    controller.activity({
      owner,
      windowId,
      pid: 1,
      app: 'Notes',
      path: '/Applications/Notes.app',
      size: async () => ({ width: 800, height: 600 }),
    });
  return { controller, log, state, activity };
}

describe('PreviewController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('后台操作窗口时显示；最后一个 run 结束后延时收起', async () => {
    const { controller, log, activity } = setup();
    await activity('a');
    await activity('b', 'w2');
    controller.runEnd('a');
    await vi.advanceTimersByTimeAsync(2000);
    expect(log).toEqual(['show w1 Notes', 'show w2 Notes']);
    controller.runEnd('b');
    await vi.advanceTimersByTimeAsync(999);
    expect(log.at(-1)).toBe('show w2 Notes');
    await vi.advanceTimersByTimeAsync(1);
    expect(log.at(-1)).toBe('hide');
  });

  it('收起前又有新操作：取消收起', async () => {
    const { controller, log, activity } = setup();
    await activity('a');
    controller.runEnd('a');
    await vi.advanceTimersByTimeAsync(500);
    await activity('b');
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).not.toContain('hide');
  });

  it('设置里关掉时不显示', async () => {
    const { log, activity } = setup(false);
    await activity('a');
    expect(log).toEqual([]);
  });

  it('用户关掉预览：同一窗口在这轮操作里不再弹出，换窗口或下一轮照常显示', async () => {
    const { controller, log, activity } = setup();
    await activity('a');
    controller.userClosed('w1');
    await activity('a');
    expect(log).toEqual(['show w1 Notes', 'hide']);
    await activity('a', 'w2');
    expect(log.at(-1)).toBe('show w2 Notes');
    controller.userClosed('w2');
    controller.runEnd('a');
    await vi.advanceTimersByTimeAsync(1000);
    await activity('c', 'w2');
    expect(log.at(-1)).toBe('show w2 Notes');
  });

  it('未知 owner 的 runEnd 不影响显示', async () => {
    const { controller, log, activity } = setup();
    await activity('a');
    controller.runEnd('zzz');
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toEqual(['show w1 Notes']);
  });
});

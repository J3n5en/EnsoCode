import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isPackaged: false }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged;
    },
  },
}));

import { isVerifyLaunch, presentWindow, showWindow } from './verifyLaunch';

function fakeWindow(minimized = false) {
  return {
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe('verifyLaunch', () => {
  const original = process.env.ENSO_VERIFY;

  beforeEach(() => {
    mocks.isPackaged = false;
    delete process.env.ENSO_VERIFY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ENSO_VERIFY;
    else process.env.ENSO_VERIFY = original;
  });

  it('只在未打包且 ENSO_VERIFY=1 时生效', () => {
    expect(isVerifyLaunch()).toBe(false);
    process.env.ENSO_VERIFY = 'true';
    expect(isVerifyLaunch()).toBe(false);
    process.env.ENSO_VERIFY = '1';
    expect(isVerifyLaunch()).toBe(true);
    mocks.isPackaged = true;
    expect(isVerifyLaunch()).toBe(false);
  });

  it('平时照常显示并唤起窗口', () => {
    const win = fakeWindow(true);
    presentWindow(win as never);
    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();

    const plain = fakeWindow();
    showWindow(plain as never);
    expect(plain.show).toHaveBeenCalled();
    expect(plain.focus).not.toHaveBeenCalled();
  });

  it('验收实例不显示、不聚焦窗口', () => {
    process.env.ENSO_VERIFY = '1';
    const win = fakeWindow(true);
    presentWindow(win as never);
    showWindow(win as never);
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isPackaged: false,
  shown: [] as { title: string; body: string; icon?: string }[],
  execFile: [] as unknown[][],
}));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    mocks.execFile.push(args);
  },
}));

vi.mock('electron', () => {
  class Notification {
    static isSupported = () => true;
    constructor(private readonly options: { title: string; body: string; icon?: string }) {}
    show() {
      mocks.shown.push(this.options);
    }
  }
  return {
    Notification,
    app: {
      get isPackaged() {
        return mocks.isPackaged;
      },
    },
  };
});

import { showSystemNotification } from './systemNotification';

describe('showSystemNotification', () => {
  const original = { verify: process.env.ENSO_VERIFY, platform: process.platform };
  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  beforeEach(() => {
    mocks.isPackaged = false;
    mocks.shown.length = 0;
    mocks.execFile.length = 0;
    delete process.env.ENSO_VERIFY;
    globalThis.__ensoVerifyNotifications = undefined;
    setPlatform('darwin');
  });

  afterEach(() => {
    if (original.verify === undefined) delete process.env.ENSO_VERIFY;
    else process.env.ENSO_VERIFY = original.verify;
    setPlatform(original.platform);
  });

  it('平时照常弹：未打包的 mac 按需走 osascript，否则走原生通知', () => {
    expect(
      showSystemNotification({ title: 'T', body: 'B', osascriptWhenUnsigned: true })
    ).toBeNull();
    expect(mocks.execFile).toHaveLength(1);
    expect(String(mocks.execFile[0][1])).toContain('display notification');

    expect(showSystemNotification({ title: 'T', body: 'B', icon: '/i.png' })).not.toBeNull();
    expect(mocks.shown).toEqual([{ title: 'T', body: 'B', icon: '/i.png', silent: false }]);
  });

  it('验收实例一条系统通知都不发，只记下来给脚本断言', () => {
    process.env.ENSO_VERIFY = '1';
    expect(
      showSystemNotification({ title: 'A', body: '1', osascriptWhenUnsigned: true })
    ).toBeNull();
    expect(showSystemNotification({ title: 'B', body: '2' })).toBeNull();
    expect(mocks.execFile).toEqual([]);
    expect(mocks.shown).toEqual([]);
    expect(globalThis.__ensoVerifyNotifications).toEqual([
      { title: 'A', body: '1' },
      { title: 'B', body: '2' },
    ]);
  });

  it('打包版忽略 ENSO_VERIFY', () => {
    mocks.isPackaged = true;
    process.env.ENSO_VERIFY = '1';
    showSystemNotification({ title: 'T', body: 'B', osascriptWhenUnsigned: true });
    expect(mocks.execFile).toEqual([]);
    expect(mocks.shown).toHaveLength(1);
    expect(globalThis.__ensoVerifyNotifications).toBeUndefined();
  });
});

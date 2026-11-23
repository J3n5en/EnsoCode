import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setBadgeCount: vi.fn(),
  on: vi.fn(),
  isMainWebContents: vi.fn((id: number) => id === 2),
}));

vi.mock('electron', () => ({
  app: { setBadgeCount: mocks.setBadgeCount },
  ipcMain: { on: mocks.on },
}));

vi.mock('../services/renderers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/renderers')>()),
  isMainRenderer: mocks.isMainWebContents,
}));

import { registerAppBadgeHandlers, toBadgeCount } from './appBadge';

describe('toBadgeCount', () => {
  it('接受 0..999 的整数', () => {
    expect(toBadgeCount(0)).toBe(0);
    expect(toBadgeCount(7)).toBe(7);
    expect(toBadgeCount(999)).toBe(999);
  });

  it('非法值返回 null', () => {
    for (const value of [
      -1,
      1000,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '3',
      null,
      undefined,
      {},
    ]) {
      expect(toBadgeCount(value)).toBeNull();
    }
  });
});

describe('registerAppBadgeHandlers', () => {
  let listener: (event: { sender: { id: number } }, value: unknown) => void;

  beforeEach(() => {
    mocks.setBadgeCount.mockClear();
    mocks.on.mockClear();
    registerAppBadgeHandlers();
    const call = mocks.on.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.APP_SET_BADGE_COUNT
    );
    listener = call?.[1];
  });

  it('主窗口上报合法值时设置角标', () => {
    listener({ sender: { id: 2 } }, 3);
    listener({ sender: { id: 2 } }, 0);
    expect(mocks.setBadgeCount.mock.calls).toEqual([[3], [0]]);
  });

  it('非主窗口或非法值忽略', () => {
    listener({ sender: { id: 1 } }, 3);
    listener({ sender: { id: 2 } }, -1);
    listener({ sender: { id: 2 } }, '3');
    expect(mocks.setBadgeCount).not.toHaveBeenCalled();
  });
});

import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  answer: vi.fn(() => true),
  list: vi.fn(() => [{ id: 'r1', command: 'id -u', retry: false, expiresAt: 1 }]),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));
vi.mock('../services/elevation', () => ({
  canAnswerElevation: (id: number) => id === 7,
  elevationBroker: { answer: mocks.answer, list: mocks.list },
}));

import { IPC_CHANNELS } from '@shared/types';
import { registerElevationHandlers } from './elevation';

const call = (channel: string, senderId: number, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: { id: senderId } }, ...args);

beforeEach(() => {
  mocks.handlers.clear();
  mocks.answer.mockClear();
  registerElevationHandlers();
});

it('只有口令窗口或完整模式主界面能看到待批请求', () => {
  expect(call(IPC_CHANNELS.ELEVATION_PENDING, 7)).toHaveLength(1);
  expect(call(IPC_CHANNELS.ELEVATION_PENDING, 3)).toEqual([]);
});

it('其它窗口应答一律无效', () => {
  expect(call(IPC_CHANNELS.ELEVATION_ANSWER, 3, 'r1', 'pw')).toBe(false);
  expect(mocks.answer).not.toHaveBeenCalled();
});

it('口令与拒绝原样交给 broker', () => {
  expect(call(IPC_CHANNELS.ELEVATION_ANSWER, 7, 'r1', 'p w!')).toBe(true);
  expect(call(IPC_CHANNELS.ELEVATION_ANSWER, 7, 'r1', null)).toBe(true);
  expect(mocks.answer.mock.calls).toEqual([
    ['r1', 'p w!'],
    ['r1', null],
  ]);
});

it('脏输入拒收：非字符串 id、空口令、换行/NUL、超长、非字符串口令', () => {
  for (const [id, password] of [
    [1, 'pw'],
    ['r1', ''],
    ['r1', 'a\nb'],
    ['r1', 'a\0b'],
    ['r1', 'x'.repeat(1025)],
    ['r1', 123],
    ['r1', undefined],
  ] as const) {
    expect(call(IPC_CHANNELS.ELEVATION_ANSWER, 7, id, password)).toBe(false);
  }
  expect(mocks.answer).not.toHaveBeenCalled();
});

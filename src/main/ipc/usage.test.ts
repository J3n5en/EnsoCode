import { IPC_CHANNELS } from '@shared/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getUsageSummary: vi.fn(async () => ({ ok: true, summary: {} })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../services/usage/usageService', () => ({ getUsageSummary: mocks.getUsageSummary }));

import { registerUsageHandlers } from './usage';

function summaryHandler(): (...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(IPC_CHANNELS.USAGE_SUMMARY);
  if (!handler) throw new Error('usage summary handler not registered');
  return handler;
}

beforeAll(() => {
  registerUsageHandlers();
});

beforeEach(() => {
  mocks.getUsageSummary.mockClear();
});

describe('usage:summary 参数校验', () => {
  it.each([['7'], [365], [null], [{}], [undefined], [7.5]])(
    '非法 days=%j 时直接拒绝，不调用 service',
    async (days) => {
      expect(await summaryHandler()({}, days)).toEqual({ ok: false, error: 'Invalid range' });
      expect(mocks.getUsageSummary).not.toHaveBeenCalled();
    }
  );

  it('合法 days 透传给 service 并原样返回结果', async () => {
    const result = await summaryHandler()({}, 7);
    expect(mocks.getUsageSummary).toHaveBeenCalledWith(7);
    expect(result).toEqual({ ok: true, summary: {} });
  });
});

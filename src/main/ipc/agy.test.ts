import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  order: [] as string[],
  detect: vi.fn(),
  cachedModels: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@platform', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, fn),
  },
}));
vi.mock('./settings', () => ({ readSettingsState: () => ({ agy: { binaryPath: '/opt/agy' } }) }));
vi.mock('../services/agyProbe', () => ({
  detectAgyAuth: (...args: unknown[]) => mocks.detect(...args),
  cachedAgyModels: () => mocks.cachedModels(),
}));
vi.mock('../services/agentHost', () => ({ pushAgyConfig: () => mocks.push() }));

const { registerAgyHandlers } = await import('./agy');
registerAgyHandlers();

function handler(channel: string) {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`missing handler ${channel}`);
  return fn;
}

beforeEach(() => {
  mocks.order.length = 0;
  mocks.detect.mockReset();
  mocks.cachedModels.mockReset();
  mocks.push.mockReset();
  mocks.push.mockImplementation(() => mocks.order.push('push'));
});

describe('agy IPC', () => {
  it('探测结束后把新清单推给 worker', async () => {
    const status = { status: 'signed-in', version: '1.5.18', models: [{ id: 'm', name: 'M' }] };
    mocks.detect.mockImplementation(async () => {
      mocks.order.push('detect');
      return status;
    });
    await expect(handler(IPC_CHANNELS.AGY_AUTH_STATUS)({}, true)).resolves.toEqual(status);
    expect(mocks.detect).toHaveBeenCalledWith('/opt/agy', true);
    expect(mocks.order).toEqual(['detect', 'push']);
  });

  it('refresh 只认 true', async () => {
    mocks.detect.mockResolvedValue({ status: 'unknown' });
    await handler(IPC_CHANNELS.AGY_AUTH_STATUS)({}, 'yes');
    expect(mocks.detect).toHaveBeenCalledWith('/opt/agy', false);
  });

  it('缓存清单通道只读缓存，不探测也不推送', async () => {
    const models = [{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }];
    mocks.cachedModels.mockReturnValue(models);
    await expect(
      Promise.resolve(handler(IPC_CHANNELS.AGY_CACHED_MODELS)({}, 'ignored'))
    ).resolves.toEqual(models);
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

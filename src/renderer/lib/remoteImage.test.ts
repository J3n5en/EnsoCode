import { REMOTE_LOCAL_IMAGE_PREFIX_KEY } from '@shared/localImage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteImagePrefix, retryRemoteImage } from './remoteImage';

describe('retryRemoteImage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps retrying while the desktop is unreachable and recovers once it loads', async () => {
    const results = [false, false, true];
    const load = vi.fn(async () => results.shift() ?? true);
    const loaded = vi.fn();
    retryRemoteImage('/desk/li/p/x', load, loaded);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(loaded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(loaded).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('stops when the image goes away', async () => {
    const load = vi.fn(async () => false);
    const stop = retryRemoteImage('/desk/li/p/x', load, () => {});
    await vi.advanceTimersByTimeAsync(2_000);
    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('remoteImagePrefix', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[REMOTE_LOCAL_IMAGE_PREFIX_KEY];
  });

  it('is null on the desktop and the /desk/li prefix in a remote renderer', () => {
    expect(remoteImagePrefix()).toBeNull();
    (globalThis as Record<string, unknown>)[REMOTE_LOCAL_IMAGE_PREFIX_KEY] = '/desk/li/p/';
    expect(remoteImagePrefix()).toBe('/desk/li/p/');
  });
});

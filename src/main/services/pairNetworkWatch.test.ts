import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPairNetworkWatch } from './pairNetworkWatch';

afterEach(() => {
  vi.useRealTimers();
});

describe('startPairNetworkWatch', () => {
  it('网卡指纹变化时立刻通知，相同指纹不重复触发', () => {
    vi.useFakeTimers();
    const snapshots = [
      { en0: [{ address: '192.168.1.8', family: 'IPv4' as const, internal: false }] },
      { en0: [{ address: '192.168.1.8', family: 'IPv4' as const, internal: false }] },
      {
        en0: [{ address: '192.168.1.8', family: 'IPv4' as const, internal: false }],
        utun4: [{ address: '100.64.0.2', family: 'IPv4' as const, internal: false }],
      },
    ];
    let i = 0;
    const onChange = vi.fn();
    const stop = startPairNetworkWatch({
      pollMs: 1_000,
      readNics: () => snapshots[Math.min(i++, snapshots.length - 1)]!,
      onChange,
    });
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });
});

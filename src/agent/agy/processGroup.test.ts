import { describe, expect, it } from 'vitest';
import { type GroupOps, stopGroup } from './processGroup';

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('stopGroup', () => {
  it('treats ESRCH as already gone and does not signal again', async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    const ops: GroupOps = {
      signal: (signal) => {
        signals.push(signal);
        throw errno('ESRCH');
      },
      sleep: async () => {},
      now: () => 0,
    };
    await expect(stopGroup(ops)).resolves.toBeUndefined();
    expect(signals).toEqual(['SIGTERM']);
  });

  it('retries a brief EPERM, then force-stops if the group is still there', async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    let now = 0;
    let permits = 0;
    const ops: GroupOps = {
      signal: (signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM' && permits < 2) {
          permits += 1;
          throw errno('EPERM');
        }
      },
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    };
    await stopGroup(ops, 0);
    expect(signals.filter((signal) => signal === 'SIGTERM').length).toBeGreaterThan(1);
    expect(signals.at(-1)).toBe('SIGKILL');
  });
});

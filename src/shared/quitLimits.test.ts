import { describe, expect, it } from 'vitest';
import {
  QUIT_REPLY_IDLE_MS,
  QUIT_REPLY_WAIT_CAP_MS,
  QUIT_REPLY_WAIT_FLOOR_MS,
  replyWaitDeadline,
} from './quitLimits';

const start = 1_000_000;

describe('回复等待截止时刻', () => {
  it('规则：保底 60 秒、空闲 20 秒、总上限 180 秒', () => {
    expect([QUIT_REPLY_WAIT_FLOOR_MS, QUIT_REPLY_IDLE_MS, QUIT_REPLY_WAIT_CAP_MS]).toEqual([
      60_000, 20_000, 180_000,
    ]);
  });

  it('还没出过 token / 早就不出了：等满保底就停', () => {
    expect(replyWaitDeadline(start, undefined)).toEqual({
      at: start + QUIT_REPLY_WAIT_FLOOR_MS,
      end: 'idle',
    });
    expect(replyWaitDeadline(start, start + 10_000)).toEqual({
      at: start + QUIT_REPLY_WAIT_FLOOR_MS,
      end: 'idle',
    });
  });

  it('保底后还在出 token：截止时刻跟着最近一次出 token 往后推', () => {
    expect(replyWaitDeadline(start, start + 55_000)).toEqual({ at: start + 75_000, end: 'idle' });
    expect(replyWaitDeadline(start, start + 120_000)).toEqual({
      at: start + 140_000,
      end: 'idle',
    });
  });

  it('一直在出 token 也只等到总上限', () => {
    expect(replyWaitDeadline(start, start + 165_000)).toEqual({
      at: start + QUIT_REPLY_WAIT_CAP_MS,
      end: 'cap',
    });
    expect(replyWaitDeadline(start, start + 179_999)).toEqual({
      at: start + QUIT_REPLY_WAIT_CAP_MS,
      end: 'cap',
    });
  });
});

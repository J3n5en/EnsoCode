import { describe, expect, it } from 'vitest';
import { resumeGrace } from './resumeGrace';

const MB = 1024 * 1024;

describe('resumeGrace', () => {
  it('缓冲没溢出就一直留着，让浏览器回来续上', () => {
    expect(resumeGrace({ retainedBytes: 1, maxBytes: 8 * MB, suspendedMs: 60_000 })).toBeNull();
    expect(resumeGrace({ retainedBytes: 8 * MB - 1, maxBytes: 8 * MB, suspendedMs: 60_000 })).toBe(
      null
    );
  });

  it('缓冲溢出后给 30 秒把积压发完，到点销毁', () => {
    expect(resumeGrace({ retainedBytes: 8 * MB, maxBytes: 8 * MB, suspendedMs: 29_999 })).toBe(
      null
    );
    expect(resumeGrace({ retainedBytes: 8 * MB, maxBytes: 8 * MB, suspendedMs: 30_000 })).toBe(
      'dispose'
    );
  });

  it('挂起超过 30 分钟就销毁，不再占内存', () => {
    expect(resumeGrace({ retainedBytes: 1, maxBytes: 8 * MB, suspendedMs: 30 * 60_000 - 1 })).toBe(
      null
    );
    expect(resumeGrace({ retainedBytes: 1, maxBytes: 8 * MB, suspendedMs: 30 * 60_000 })).toBe(
      'dispose'
    );
  });
});

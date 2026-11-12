import { describe, expect, it } from 'vitest';
import { hasPendingCalls } from './supervisor';

describe('hasPendingCalls', () => {
  it.each(['browser', 'memory', 'delegation', 'agentControl', 'computer'])(
    '%s 有在途调用时会话视为忙碌（驱逐与工作区锁共用）',
    (key) => {
      expect(hasPendingCalls({ [key]: { pendingCount: 1 } } as never)).toBe(true);
      expect(hasPendingCalls({ [key]: { pendingCount: 0 } } as never)).toBe(false);
    }
  );

  it('没有任何能力时不忙', () => {
    expect(hasPendingCalls({} as never)).toBe(false);
  });
});

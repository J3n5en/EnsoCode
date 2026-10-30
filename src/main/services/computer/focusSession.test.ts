import { describe, expect, it, vi } from 'vitest';
import { type FocusDeps, FocusRegistry, FocusSession } from './focusSession';

function fakeDeps(overrides: Partial<FocusDeps> = {}) {
  const calls: string[] = [];
  const state = { front: 100 as number | undefined, hid: 30 as number | null };
  const deps: FocusDeps = {
    frontPid: () => state.front,
    activate: (pid, windowId) => {
      calls.push(`activate ${pid}:${windowId}`);
    },
    deactivate: (pid, windowId) => {
      calls.push(`deactivate ${pid}:${windowId}`);
    },
    setFront: (pid) => {
      calls.push(`front ${pid}`);
      state.front = pid;
      return true;
    },
    hidIdleSeconds: () => state.hid,
    sleep: async () => {},
    ...overrides,
  };
  return { deps, calls, state };
}

describe('FocusSession.enforce', () => {
  it('先激活目标窗口，已相信同一窗口时幂等', async () => {
    const { deps, calls } = fakeDeps();
    const session = new FocusSession(42, deps);
    await session.enforce(9);
    await session.enforce(9);
    expect(calls).toEqual(['activate 42:9']);
    expect(session.state()).toEqual({ believedActive: true, window: 9, reallyActive: false });
  });

  it('换窗口：先反激活旧窗口，再激活新窗口（顺序固定）', async () => {
    const { deps, calls } = fakeDeps();
    const session = new FocusSession(42, deps);
    await session.enforce(9);
    await session.enforce(10);
    expect(calls).toEqual(['activate 42:9', 'deactivate 42:9', 'activate 42:10']);
  });

  it('目标本来就是真前台且用户没在操作：不发激活包', async () => {
    const { deps, calls, state } = fakeDeps();
    state.front = 42;
    const session = new FocusSession(42, deps);
    await session.enforce(9);
    expect(calls).toEqual([]);
    expect(session.state().reallyActive).toBe(true);
  });

  it('目标是真前台且用户正在操作：拒绝后台输入', async () => {
    const { deps, state } = fakeDeps();
    state.front = 42;
    state.hid = 0.2;
    const session = new FocusSession(42, deps);
    await expect(session.enforce(9)).rejects.toMatchObject({ code: 'user-active' });
  });

  it('teardown 后不可再用；teardown 幂等且只反激活一次', async () => {
    const { deps, calls } = fakeDeps();
    const session = new FocusSession(42, deps);
    await session.enforce(9);
    session.teardown();
    session.teardown();
    expect(calls).toEqual(['activate 42:9', 'deactivate 42:9']);
    await expect(session.enforce(9)).rejects.toThrow(/closed/);
  });

  it('没激活过就 teardown 不发反激活', () => {
    const { deps, calls } = fakeDeps();
    new FocusSession(42, deps).teardown();
    expect(calls).toEqual([]);
  });
});

describe('FocusSession：目标成了真前台', () => {
  it('用户自己切到目标后，后续动作不再把前台“还”给旧 app', async () => {
    const { deps, calls, state } = fakeDeps();
    const session = new FocusSession(42, deps);
    await session.enforce(9);
    // 用户切到目标 app，之后停手超过 1s
    state.front = 42;
    await session.guard(9, async () => {});
    expect(calls).not.toContain('front 100');
    expect(session.state().believedActive).toBe(false);
  });

  it('收尾时目标已是真前台：不发反激活，免得它以为自己失去激活', async () => {
    const { deps, calls, state } = fakeDeps();
    const session = new FocusSession(42, deps);
    await session.enforce(9);
    state.front = 42;
    session.teardown();
    expect(calls).toEqual(['activate 42:9']);
  });
});

describe('FocusSession.guard（焦点窃取防护）', () => {
  it('动作期间目标抢成真前台、用户没动：还给用户原前台并在下次重新激活', async () => {
    const { deps, calls, state } = fakeDeps();
    const session = new FocusSession(42, deps);
    await session.guard(9, async () => {
      state.front = 42;
    });
    expect(calls).toEqual(['activate 42:9', 'front 100']);
    expect(state.front).toBe(100);
    expect(session.state().believedActive).toBe(false);
    await session.enforce(9);
    expect(calls.at(-1)).toBe('activate 42:9');
  });

  it('用户自己切到目标 app（刚有物理输入）：不抢回，报 user-active', async () => {
    const { deps, calls, state } = fakeDeps();
    const session = new FocusSession(42, deps);
    await expect(
      session.guard(9, async () => {
        state.front = 42;
        state.hid = 0.1;
      })
    ).rejects.toMatchObject({ code: 'user-active' });
    expect(calls).not.toContain('front 100');
  });

  it('反复被抢超过上限：报 focus-steal，不无限拉锯', async () => {
    const { deps, state } = fakeDeps();
    const session = new FocusSession(42, deps, { maxSteals: 2 });
    const steal = async () => {
      state.front = 42;
    };
    await session.guard(9, steal);
    await session.guard(9, steal);
    await expect(session.guard(9, steal)).rejects.toMatchObject({ code: 'focus-steal' });
  });

  it('用户原前台不可知（无前台进程）时不抢回', async () => {
    const { deps, calls, state } = fakeDeps();
    state.front = undefined;
    const session = new FocusSession(42, deps);
    await session.guard(9, async () => {
      state.front = 42;
    });
    expect(calls).toEqual(['activate 42:9']);
  });

  it('动作抛错时同样检查窃取并原样抛出', async () => {
    const { deps, calls, state } = fakeDeps();
    const session = new FocusSession(42, deps);
    await expect(
      session.guard(9, async () => {
        state.front = 42;
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(calls).toContain('front 100');
  });

  it('长动作期间轮询：中途被抢立刻还回', async () => {
    vi.useFakeTimers();
    try {
      const { deps, calls, state } = fakeDeps();
      const session = new FocusSession(42, deps, { pollMs: 10 });
      const run = session.guard(9, async () => {
        state.front = 42;
        await vi.advanceTimersByTimeAsync(15);
        expect(calls).toContain('front 100');
        state.front = 100;
      });
      await run;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FocusRegistry', () => {
  it('同 pid 复用会话；空闲超时后统一 teardown', async () => {
    vi.useFakeTimers();
    try {
      const { deps, calls } = fakeDeps();
      const registry = new FocusRegistry(deps, { idleMs: 1000 });
      await registry.session(42).enforce(9);
      expect(registry.session(42)).toBe(registry.session(42));
      registry.touch(42);
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toEqual(['activate 42:9']);
      await vi.advanceTimersByTimeAsync(2);
      expect(calls).toEqual(['activate 42:9', 'deactivate 42:9']);
      expect(registry.has(42)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('动作进行中不按空闲收尾，结束后重新计时', async () => {
    vi.useFakeTimers();
    try {
      const { deps, calls } = fakeDeps();
      const registry = new FocusRegistry(deps, { idleMs: 1000, pollMs: 0 });
      let finish: () => void = () => {};
      const running = registry.session(42).guard(
        9,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(registry.has(42)).toBe(true);
      expect(calls).toEqual(['activate 42:9']);
      finish();
      await running;
      registry.touch(42);
      await vi.advanceTimersByTimeAsync(1001);
      expect(registry.has(42)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('touch 续期；releaseAll 立即收尾所有会话', async () => {
    vi.useFakeTimers();
    try {
      const { deps, calls } = fakeDeps();
      const registry = new FocusRegistry(deps, { idleMs: 1000 });
      await registry.session(42).enforce(9);
      await registry.session(43).enforce(5);
      registry.touch(42);
      await vi.advanceTimersByTimeAsync(800);
      registry.touch(42);
      await vi.advanceTimersByTimeAsync(800);
      expect(calls).not.toContain('deactivate 42:9');
      registry.releaseAll();
      expect(calls).toContain('deactivate 42:9');
      expect(calls).toContain('deactivate 43:5');
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.filter((call) => call.startsWith('deactivate'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('反激活抛错（进程已退出）不影响其它会话收尾', async () => {
    const { deps, calls } = fakeDeps({
      deactivate: (pid, windowId) => {
        if (pid === 42) throw new Error('gone');
        calls.push(`deactivate ${pid}:${windowId}`);
      },
    });
    const registry = new FocusRegistry(deps, { idleMs: 1000 });
    await registry.session(42).enforce(9);
    await registry.session(43).enforce(5);
    registry.releaseAll();
    expect(calls).toContain('deactivate 43:5');
  });
});

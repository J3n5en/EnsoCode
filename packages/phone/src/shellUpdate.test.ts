import { describe, expect, it } from 'vitest';
import { shellReloadDecision, watchShellUpdate } from './shellUpdate';

describe('shellReloadDecision', () => {
  it('不是旧缓存出来的不重载', () => {
    expect(shellReloadDecision({ stale: false, alreadyReloaded: false, canReloadNow: true })).toBe(
      'none'
    );
  });
  it('还没起来立即换，已在用等回前台', () => {
    expect(shellReloadDecision({ stale: true, alreadyReloaded: false, canReloadNow: true })).toBe(
      'now'
    );
    expect(shellReloadDecision({ stale: true, alreadyReloaded: false, canReloadNow: false })).toBe(
      'resume'
    );
  });
  it('同一版本本会话已重载过就不再重载（防循环）', () => {
    expect(shellReloadDecision({ stale: true, alreadyReloaded: true, canReloadNow: true })).toBe(
      'none'
    );
  });
});

function harness(opts: { stale: boolean; canReloadNow: boolean; version?: string | null }) {
  const docListeners: Record<string, () => void> = {};
  const swListeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  const store = new Map<string, string>();
  const asked: unknown[] = [];
  let reloads = 0;
  let updates = 0;
  let clock = 0;
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    querySelector: () => ({ getAttribute: () => opts.version ?? 'aaaaaaaaaaaaaaaa' }),
    addEventListener: (t: string, fn: () => void) => {
      docListeners[t] = fn;
    },
  };
  watchShellUpdate({
    container: {
      controller: {
        postMessage: (message, [port]) => {
          asked.push(message);
          port?.postMessage({ ready: true, stale: opts.stale });
        },
      },
      addEventListener: (t, fn) => {
        swListeners[t] = [...(swListeners[t] ?? []), fn];
      },
      getRegistration: async () => ({
        update: async () => {
          updates += 1;
        },
      }),
    },
    doc: doc as unknown as Document,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
    },
    canReloadNow: () => opts.canReloadNow,
    reload: () => {
      reloads += 1;
    },
    now: () => clock,
  });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return {
    asked,
    store,
    reloads: () => reloads,
    updates: () => updates,
    settle,
    tick: (ms: number) => {
      clock += ms;
    },
    resume: () => {
      doc.visibilityState = 'visible';
      docListeners.visibilitychange?.();
    },
    shellReady: () => {
      for (const fn of swListeners.message ?? [])
        fn({ data: { type: 'shell-ready' } } as MessageEvent);
    },
    controllerChange: () => {
      for (const fn of swListeners.controllerchange ?? []) fn({} as MessageEvent);
    },
  };
}

describe('watchShellUpdate', () => {
  it('启动时带上本页版本去问；旧壳且还没起来就立即重载一次', async () => {
    const h = harness({ stale: true, canReloadNow: true });
    await h.settle();
    expect(h.asked).toEqual([{ type: 'shell-check', version: 'aaaaaaaaaaaaaaaa' }]);
    expect(h.reloads()).toBe(1);
    expect(h.store.get('enso-shell-reloaded')).toBe('aaaaaaaaaaaaaaaa');
    h.shellReady();
    await h.settle();
    expect(h.reloads()).toBe(1);
  });

  it('新版 SW 接管后再问一次', async () => {
    const h = harness({ stale: false, canReloadNow: true });
    await h.settle();
    h.controllerChange();
    await h.settle();
    expect(h.asked).toHaveLength(2);
  });

  it('已在用：等回到前台再换', async () => {
    const h = harness({ stale: true, canReloadNow: false });
    await h.settle();
    expect(h.reloads()).toBe(0);
    h.resume();
    expect(h.reloads()).toBe(1);
  });

  it('不旧不动；常驻页面回前台隔一段时间查一次新版', async () => {
    const h = harness({ stale: false, canReloadNow: true });
    await h.settle();
    h.resume();
    expect(h.updates()).toBe(0);
    h.tick(31 * 60_000);
    h.resume();
    await h.settle();
    expect(h.updates()).toBe(1);
    expect(h.reloads()).toBe(0);
  });

  it('开发构建（页面没有版本）什么都不做', async () => {
    const h = harness({ stale: true, canReloadNow: true, version: 'dev' });
    await h.settle();
    expect(h.asked).toEqual([]);
    expect(h.reloads()).toBe(0);
  });
});

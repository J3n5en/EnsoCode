import { describe, expect, it, vi } from 'vitest';
import { AxEnablementRegistry, axEnablementAttribute } from './axEnablement';

describe('axEnablementAttribute', () => {
  it('Electron 类（AXManualAccessibility 可写）优先用它', () => {
    expect(axEnablementAttribute({ manualSettable: true, bundleId: 'com.microsoft.VSCode' })).toBe(
      'AXManualAccessibility'
    );
  });

  it('Chromium 浏览器只认 AXEnhancedUserInterface', () => {
    expect(axEnablementAttribute({ manualSettable: false, bundleId: 'com.google.Chrome' })).toBe(
      'AXEnhancedUserInterface'
    );
    expect(
      axEnablementAttribute({ manualSettable: false, bundleId: 'com.microsoft.edgemac' })
    ).toBe('AXEnhancedUserInterface');
  });

  it('原生 AppKit 不开 AXEnhancedUserInterface（会改变窗口动画等行为）', () => {
    expect(axEnablementAttribute({ manualSettable: false, bundleId: 'com.apple.TextEdit' })).toBe(
      undefined
    );
    expect(axEnablementAttribute({ manualSettable: false })).toBe(undefined);
  });
});

describe('AxEnablementRegistry', () => {
  function deps() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        enable: vi.fn(async (pid: number) => {
          calls.push(`enable ${pid}`);
          return { changed: ['AXManualAccessibility'] };
        }),
        restore: vi.fn(async (pid: number, attrs: string[]) => {
          calls.push(`restore ${pid} ${attrs.join(',')}`);
        }),
      },
    };
  }

  it('同 pid 只开一次（并发调用也只开一次）', async () => {
    const { deps: d, calls } = deps();
    const registry = new AxEnablementRegistry(d, { idleMs: 1000 });
    const first = await Promise.all([registry.ensure(1), registry.ensure(1)]);
    expect(first.filter(Boolean)).toHaveLength(1);
    expect(await registry.ensure(1)).toBe(false);
    expect(calls).toEqual(['enable 1']);
    registry.releaseAll();
  });

  it('空闲后只恢复我们改过的属性', async () => {
    vi.useFakeTimers();
    try {
      const { deps: d, calls } = deps();
      const registry = new AxEnablementRegistry(d, { idleMs: 1000 });
      await registry.ensure(1);
      await vi.advanceTimersByTimeAsync(1001);
      expect(calls).toEqual(['enable 1', 'restore 1 AXManualAccessibility']);
      await registry.ensure(1);
      expect(calls.at(-1)).toBe('enable 1');
      registry.releaseAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('没改过任何属性就不恢复；开启失败不阻断调用方', async () => {
    const calls: string[] = [];
    const registry = new AxEnablementRegistry(
      {
        enable: async (pid) => {
          if (pid === 2) throw new Error('gone');
          return { changed: [] };
        },
        restore: async (pid) => {
          calls.push(`restore ${pid}`);
        },
      },
      { idleMs: 1000 }
    );
    await registry.ensure(1);
    await expect(registry.ensure(2)).resolves.toBe(false);
    registry.releaseAll();
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
});

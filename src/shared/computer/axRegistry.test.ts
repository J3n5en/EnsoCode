import { describe, expect, it } from 'vitest';
import {
  AX_STALE_HANDLE,
  AxRegistry,
  axHandleEpoch,
  formatAxHandle,
  isAxStaleHandleError,
  parseAxHandle,
} from './axRegistry';
import { StaleRefError } from './errors';

describe('AxRegistry', () => {
  it('同一 target 下同一句柄跨代复用同一 ref，并随新一代续命', () => {
    const registry = new AxRegistry<string>();
    const g1 = registry.beginSnapshot('w1');
    const a1 = registry.register('w1', g1, 'A');
    const g2 = registry.beginSnapshot('w1');
    expect(registry.register('w1', g2, 'A')).toBe(a1);
    const g3 = registry.beginSnapshot('w1');
    expect(registry.register('w1', g3, 'A')).toBe(a1);
    registry.beginSnapshot('w1');
    // 第 3 代仍在两代窗口内，ref 不过期
    expect(registry.resolve(a1)).toBe('A');
  });

  it('不同 target 的同一句柄各自登记', () => {
    const registry = new AxRegistry<string>();
    const a = registry.register('w1', registry.beginSnapshot('w1'), 'A');
    const b = registry.register('desktop', registry.beginSnapshot('desktop'), 'A');
    expect(a).not.toBe(b);
  });

  it('新 snapshot 作废更早一代，当前与上一世代仍可解析', () => {
    const registry = new AxRegistry<string>();
    const g1 = registry.beginSnapshot('w1');
    const a = registry.register('w1', g1, 'A');
    expect(registry.resolve(a)).toBe('A');

    const g2 = registry.beginSnapshot('w1');
    const b = registry.register('w1', g2, 'B');
    expect(registry.resolve(a)).toBe('A');
    expect(registry.resolve(b)).toBe('B');

    registry.beginSnapshot('w1');
    expect(() => registry.resolve(a)).toThrow(StaleRefError);
    expect(registry.resolve(b)).toBe('B');
  });

  it('坏 ref 和别的窗口互不影响', () => {
    const registry = new AxRegistry<number>();
    const g = registry.beginSnapshot('w1');
    const ref = registry.register('w1', g, 7);
    registry.beginSnapshot('w2');
    expect(registry.resolve(ref)).toBe(7);
    expect(registry.targetOf(ref)).toBe('w1');
    expect(() => registry.resolve('e999')).toThrow(/expired/);
    expect(() => registry.resolve('nope')).toThrow(StaleRefError);
  });

  it('children 从父节点 adopt，得到 eN 而不是裸 handle', () => {
    const registry = new AxRegistry<string>();
    const g = registry.beginSnapshot('w1');
    const parent = registry.register('w1', g, 'ax1');
    const child = registry.adopt(parent, 'ax99');
    expect(child).toMatch(/^e\d+$/);
    expect(registry.resolve(child)).toBe('ax99');
    expect(registry.targetOf(child)).toBe('w1');
  });

  it('worker 纪元变化后，旧纪元句柄解析为 StaleRefError', () => {
    const registry = new AxRegistry<string>(axHandleEpoch);
    const g1 = registry.beginSnapshot('w1');
    const old = registry.register('w1', g1, formatAxHandle('aaaa', 1));
    const g2 = registry.beginSnapshot('w2');
    const fresh = registry.register('w2', g2, formatAxHandle('bbbb', 1));
    expect(registry.resolve(fresh)).toBe('ax-bbbb-1');
    let caught: unknown;
    try {
      registry.resolve(old);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StaleRefError);
    expect((caught as StaleRefError).code).toBe('stale-ref');
    expect(() => registry.targetOf(old)).toThrow(StaleRefError);
    expect(() => registry.adopt(old, formatAxHandle('bbbb', 2))).toThrow(StaleRefError);
  });
});

describe('ax handle epoch', () => {
  it('格式化与解析往返', () => {
    expect(formatAxHandle('k3x9', 12)).toBe('ax-k3x9-12');
    expect(parseAxHandle('ax-k3x9-12')).toEqual({ epoch: 'k3x9', id: 12 });
    expect(axHandleEpoch('ax-k3x9-12')).toBe('k3x9');
  });

  it('旧格式与脏输入不解析', () => {
    for (const bad of ['ax12', 'ax--1', 'ax-k-0', 'ax-k-1x', 'e1', '', 'ax-K!-1']) {
      expect(parseAxHandle(bad)).toBeNull();
      expect(axHandleEpoch(bad)).toBeUndefined();
    }
  });

  it('识别 worker 侧过期句柄错误（含旧 axN expired 文案）', () => {
    expect(isAxStaleHandleError(new Error(`${AX_STALE_HANDLE}: ax-k-1`))).toBe(true);
    expect(isAxStaleHandleError(new Error('ax12 expired; re-run ax()/find()'))).toBe(true);
    expect(isAxStaleHandleError(new Error('AX action press failed (-25206)'))).toBe(false);
    expect(isAxStaleHandleError('nope')).toBe(false);
  });
});

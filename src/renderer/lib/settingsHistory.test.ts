import { describe, expect, it, vi } from 'vitest';
import { bindSettingsHistory, type HistoryWindow } from './settingsHistory';

/** 浏览器历史栈：go() 异步触发 popstate，和真实浏览器一样 */
function fakeWindow() {
  const stack: unknown[] = [null];
  let index = 0;
  const listeners = new Set<(e: { state: unknown }) => void>();
  const queue: Array<() => void> = [];
  const win: HistoryWindow = {
    history: {
      get state() {
        return stack[index];
      },
      pushState(state: unknown) {
        stack.splice(index + 1);
        stack.push(state);
        index += 1;
      },
      go(delta = 0) {
        queue.push(() => {
          index = Math.max(0, Math.min(stack.length - 1, index + delta));
          for (const l of listeners) l({ state: stack[index] });
        });
      },
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const flush = () => {
    while (queue.length > 0) queue.shift()?.();
  };
  /** 用户按浏览器后退 / 手势返回 */
  const back = () => {
    win.history.go(-1);
    flush();
  };
  return { win, stack: () => stack.slice(0, index + 1), flush, back };
}

function setup() {
  const fake = fakeWindow();
  let depth = 0;
  let notify = () => {};
  const apply = vi.fn((next: number) => {
    depth = next;
  });
  const unbind = bindSettingsHistory(fake.win, {
    depth: () => depth,
    apply,
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
  });
  const set = (next: number) => {
    depth = next;
    notify();
  };
  return { ...fake, apply, set, unbind, depth: () => depth };
}

describe('设置与浏览器历史同步（/desk）', () => {
  it('进设置压一条历史；后退回到工作区，不离开页面', () => {
    const h = setup();
    h.set(1);
    expect(h.stack()).toHaveLength(2);
    h.back();
    expect(h.apply).toHaveBeenCalledWith(0);
    expect(h.depth()).toBe(0);
    expect(h.stack()).toHaveLength(1);
  });

  it('窄屏：分区详情再压一级，后退先回导航列表，再退回工作区', () => {
    const h = setup();
    h.set(1);
    h.set(2);
    expect(h.stack()).toHaveLength(3);
    h.back();
    expect(h.apply).toHaveBeenLastCalledWith(1);
    h.back();
    expect(h.apply).toHaveBeenLastCalledWith(0);
  });

  it('用界面按钮返回：把自己压的历史退掉，且不把这次 popstate 当成用户后退', () => {
    const h = setup();
    h.set(1);
    h.set(0);
    h.flush();
    expect(h.stack()).toHaveLength(1);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('退栈还没落地就又打开：等 popstate 到了再补压，历史深度与界面一致', () => {
    const h = setup();
    h.set(1);
    h.set(0);
    h.set(1);
    h.set(0);
    h.set(1);
    h.flush();
    expect(h.stack()).toHaveLength(2);
    expect(h.apply).not.toHaveBeenCalled();
    h.back();
    expect(h.apply).toHaveBeenCalledWith(0);
  });

  it('解绑后不再响应', () => {
    const h = setup();
    h.set(1);
    h.unbind();
    h.back();
    expect(h.apply).not.toHaveBeenCalled();
  });
});

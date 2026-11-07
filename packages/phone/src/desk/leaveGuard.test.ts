import { describe, expect, it, vi } from 'vitest';
import { installLeaveGuard, type LeaveGuardWindow } from './leaveGuard';

function fakeWindow(confirmed: boolean) {
  const listeners = new Map<string, (event: Event) => void>();
  const win = {
    location: { href: 'https://relay/desk?device=a' },
    history: { pushState: vi.fn(), back: vi.fn() },
    confirm: vi.fn(() => confirmed),
    addEventListener: (type: string, listener: (event: Event) => void) =>
      listeners.set(type, listener),
  };
  const fire = (type: string) => {
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    listeners.get(type)?.(event as unknown as Event);
    return event;
  };
  return { win: win as unknown as LeaveGuardWindow & typeof win, fire };
}

describe('installLeaveGuard', () => {
  it('压一条守卫历史，关闭/刷新页面前要求确认', () => {
    const { win, fire } = fakeWindow(false);
    installLeaveGuard(win, '离开？');
    expect(win.history.pushState).toHaveBeenCalledTimes(1);
    expect(fire('beforeunload').preventDefault).toHaveBeenCalled();
  });

  it('后退时取消确认则留在原页并补回守卫', () => {
    const { win, fire } = fakeWindow(false);
    installLeaveGuard(win, '离开？');
    fire('popstate');
    expect(win.confirm).toHaveBeenCalledWith('离开？');
    expect(win.history.back).not.toHaveBeenCalled();
    expect(win.history.pushState).toHaveBeenCalledTimes(2);
  });

  it('后退时确认则真正后退，之后不再拦截', () => {
    const { win, fire } = fakeWindow(true);
    installLeaveGuard(win, '离开？');
    fire('popstate');
    expect(win.history.back).toHaveBeenCalledTimes(1);
    expect(fire('beforeunload').preventDefault).not.toHaveBeenCalled();
  });

  it('后退先交给 onBack 处理（如关闭设置层），处理了就不弹确认', () => {
    const { win, fire } = fakeWindow(true);
    installLeaveGuard(win, '离开？', () => true);
    fire('popstate');
    expect(win.confirm).not.toHaveBeenCalled();
    expect(win.history.back).not.toHaveBeenCalled();
    expect(win.history.pushState).toHaveBeenCalledTimes(2);
  });

  it('release 后主动离开不再拦截', () => {
    const { win, fire } = fakeWindow(false);
    const guard = installLeaveGuard(win, '离开？');
    guard.release();
    expect(fire('beforeunload').preventDefault).not.toHaveBeenCalled();
    fire('popstate');
    expect(win.confirm).not.toHaveBeenCalled();
  });
});

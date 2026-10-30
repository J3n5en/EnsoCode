import { describe, expect, it } from 'vitest';
import { chooseClickPath, pickWindowForElement, resolveClickRoute } from './clickRoute';

describe('resolveClickRoute', () => {
  it('后台：有 pid 和 windowId 时走 sky 窗口事件', () => {
    expect(resolveClickRoute({ delivery: 'background', pid: 42, windowId: 9 })).toBe('skyClick');
  });

  it('后台：只有 pid 时走 postToPid，不移动真实指针', () => {
    expect(resolveClickRoute({ delivery: 'background', pid: 42 })).toBe('postToPid');
  });

  it('前台一律走 HID，不被 pid/windowId 改写成后台投递', () => {
    expect(resolveClickRoute({ delivery: 'foreground' })).toBe('hid');
    expect(resolveClickRoute({ delivery: 'foreground', pid: 42 })).toBe('hid');
    expect(resolveClickRoute({ delivery: 'foreground', pid: 42, windowId: 9 })).toBe('hid');
  });

  it('后台无 pid 不可用，不偷偷改成 HID', () => {
    expect(resolveClickRoute({ delivery: 'background' })).toBe('unavailable');
    expect(resolveClickRoute({ delivery: 'background', pid: 0, windowId: 9 })).toBe('unavailable');
  });

  it('缺省 delivery 按后台处理', () => {
    expect(resolveClickRoute({ pid: 42, windowId: 9 })).toBe('skyClick');
  });
});

describe('chooseClickPath', () => {
  const button = { role: 'AXButton', actions: ['AXPress'], pid: 42 };

  it('目标窗口内可 press 的控件：左键单击走 AXPress', () => {
    expect(chooseClickPath({ targetPid: 42, element: button })).toBe('axPress');
  });

  it('右键、双击、带修饰键都保留为合成点击', () => {
    expect(chooseClickPath({ targetPid: 42, element: button, button: 'right' })).toBe('synthetic');
    expect(chooseClickPath({ targetPid: 42, element: button, count: 2 })).toBe('synthetic');
    expect(chooseClickPath({ targetPid: 42, element: button, modifiers: ['cmd'] })).toBe(
      'synthetic'
    );
  });

  it('元素不属于目标 app、没有 AXPress 或角色不是可按控件时合成点击', () => {
    expect(chooseClickPath({ targetPid: 7, element: button })).toBe('synthetic');
    expect(chooseClickPath({ targetPid: 42, element: { ...button, pid: undefined } })).toBe(
      'synthetic'
    );
    expect(chooseClickPath({ targetPid: 42, element: { ...button, actions: [] } })).toBe(
      'synthetic'
    );
    expect(
      chooseClickPath({
        targetPid: 42,
        element: { role: 'AXStaticText', actions: ['AXPress'], pid: 42 },
      })
    ).toBe('synthetic');
    expect(chooseClickPath({ targetPid: 42, element: null })).toBe('synthetic');
  });

  it('元素在同一 app 的另一个窗口里（被自家面板遮住）：合成点击，不按错窗口的控件', () => {
    expect(
      chooseClickPath({
        targetPid: 42,
        targetWindowId: 9,
        element: { ...button, windowId: 10 },
      })
    ).toBe('synthetic');
    expect(
      chooseClickPath({ targetPid: 42, targetWindowId: 9, element: { ...button, windowId: 9 } })
    ).toBe('axPress');
    expect(chooseClickPath({ targetPid: 42, targetWindowId: 9, element: button })).toBe(
      'synthetic'
    );
  });

  it('文本输入框需要光标位置，不用 AXPress 代替', () => {
    expect(
      chooseClickPath({
        targetPid: 42,
        element: { role: 'AXTextField', actions: ['AXPress', 'AXConfirm'], pid: 42 },
      })
    ).toBe('synthetic');
  });
});

describe('pickWindowForElement', () => {
  const windows = [
    { id: '1', pid: 7, x: 0, y: 0, width: 100, height: 100 },
    { id: '2', pid: 42, x: 0, y: 0, width: 300, height: 300 },
    { id: '3', pid: 42, x: 400, y: 0, width: 300, height: 300 },
  ];

  it('元素带窗口号时用它', () => {
    expect(
      pickWindowForElement(windows, {
        pid: 42,
        windowId: 3,
        center: { x: 10, y: 10 },
        fallback: '2',
      })
    ).toBe('3');
  });

  it('否则取同进程里包含控件中心的窗口', () => {
    expect(
      pickWindowForElement(windows, { pid: 42, center: { x: 450, y: 20 }, fallback: 'desktop' })
    ).toBe('3');
  });

  it('都定位不到时用 ref 登记的窗口；desktop 作用域退到同进程第一个窗口', () => {
    expect(
      pickWindowForElement(windows, { pid: 42, center: { x: 900, y: 900 }, fallback: '2' })
    ).toBe('2');
    expect(
      pickWindowForElement(windows, { pid: 42, center: { x: 900, y: 900 }, fallback: 'desktop' })
    ).toBe('2');
    expect(pickWindowForElement(windows, { center: { x: 900, y: 900 }, fallback: 'desktop' })).toBe(
      'desktop'
    );
  });
});

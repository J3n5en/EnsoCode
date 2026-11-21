import { describe, expect, it } from 'vitest';
import {
  editableFocused,
  installKeyboardInset,
  KEYBOARD_CLASS,
  keyboardFrame,
  touchOnly,
} from './keyboard';

/** iPhone 12（390×844）竖屏弹出中文键盘的典型值 */
const typing = { layoutHeight: 844, height: 508, offsetTop: 0, scale: 1, editing: true };

describe('keyboardFrame', () => {
  it('输入中且可见区被压掉一截：贴着可见区', () => {
    expect(keyboardFrame(typing)).toEqual({ top: 0, height: 508 });
  });

  it('iOS 把页面上推时跟着可见区上沿走', () => {
    expect(keyboardFrame({ ...typing, offsetTop: 210.4, height: 507.6 })).toEqual({
      top: 210,
      height: 508,
    });
  });

  it('没有输入框聚焦一律不动（standalone 下高度关系异常也不误判）', () => {
    expect(keyboardFrame({ ...typing, editing: false })).toBeNull();
  });

  it('工具栏伸缩、外接键盘候选条这类小幅变化不算键盘', () => {
    expect(keyboardFrame({ ...typing, height: 844 - 80 })).toBeNull();
  });

  it('双指缩放时不接管', () => {
    expect(keyboardFrame({ ...typing, scale: 1.5 })).toBeNull();
  });

  it('坏数据不接管', () => {
    expect(keyboardFrame({ ...typing, height: 0 })).toBeNull();
    expect(keyboardFrame({ ...typing, height: Number.NaN })).toBeNull();
  });
});

type FakeEl = {
  tagName: string;
  type?: string;
  readOnly?: boolean;
  isContentEditable?: boolean;
  contentDocument?: { activeElement: FakeEl | null } | null;
};
const docWith = (activeElement: FakeEl | null) => ({ activeElement }) as unknown as Document;

describe('editableFocused', () => {
  it('文本框、textarea、contenteditable 算输入', () => {
    expect(editableFocused(docWith({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(editableFocused(docWith({ tagName: 'INPUT', type: 'text' }))).toBe(true);
    expect(editableFocused(docWith({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
  });

  it('按钮、复选框、只读输入不算', () => {
    expect(editableFocused(docWith({ tagName: 'BUTTON' }))).toBe(false);
    expect(editableFocused(docWith({ tagName: 'INPUT', type: 'checkbox' }))).toBe(false);
    expect(editableFocused(docWith({ tagName: 'TEXTAREA', readOnly: true }))).toBe(false);
    expect(editableFocused(docWith(null))).toBe(false);
  });

  it('穿过 iframe 找到完整版 renderer 里的输入框', () => {
    const inner = { tagName: 'DIV', isContentEditable: true };
    const frame = { tagName: 'IFRAME', contentDocument: { activeElement: inner } };
    expect(editableFocused(docWith(frame))).toBe(true);
    expect(editableFocused(docWith({ tagName: 'IFRAME', contentDocument: null }))).toBe(false);
  });
});

function fakeWindow(opts: { touch: boolean }) {
  const vvListeners: Record<string, (() => void)[]> = {};
  const docListeners: Record<string, (() => void)[]> = {};
  const classes = new Set<string>();
  const props = new Map<string, string>();
  const scrolls: [number, number][] = [];
  const frames: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const state = { active: null as FakeEl | null, height: 844, offsetTop: 0, scrollY: 0 };
  const viewport = {
    get height() {
      return state.height;
    },
    get offsetTop() {
      return state.offsetTop;
    },
    scale: 1,
    addEventListener: (t: string, fn: () => void) => {
      vvListeners[t] = [...(vvListeners[t] ?? []), fn];
    },
  };
  const document = {
    get activeElement() {
      return state.active;
    },
    documentElement: {
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
      },
      style: {
        setProperty: (k: string, v: string) => props.set(k, v),
        removeProperty: (k: string) => props.delete(k),
      },
    },
    addEventListener: (t: string, fn: () => void) => {
      docListeners[t] = [...(docListeners[t] ?? []), fn];
    },
  };
  const win = {
    visualViewport: viewport,
    document,
    innerHeight: 844,
    get scrollY() {
      return state.scrollY;
    },
    scrollX: 0,
    scrollTo: (x: number, y: number) => {
      scrolls.push([x, y]);
      state.scrollY = y;
    },
    matchMedia: () => ({ matches: opts.touch }),
    requestAnimationFrame: (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    },
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
  };
  const flush = () => {
    while (frames.length) frames.shift()?.();
  };
  const fire = (t: string) => {
    for (const fn of vvListeners[t] ?? []) fn();
    flush();
  };
  const focus = (t: 'focusin' | 'focusout') => {
    for (const fn of docListeners[t] ?? []) fn();
    flush();
  };
  return { win: win as unknown as Window, state, classes, props, scrolls, fire, focus };
}

describe('installKeyboardInset', () => {
  it('非触屏（桌面、鼠标）什么都不装', () => {
    const f = fakeWindow({ touch: false });
    expect(installKeyboardInset(f.win)).toBeNull();
    expect(touchOnly(f.win)).toBe(false);
  });

  it('弹起时写入可见区，收起后清干净并把上推的滚动归零', () => {
    const f = fakeWindow({ touch: true });
    expect(installKeyboardInset(f.win)).not.toBeNull();
    f.state.active = { tagName: 'TEXTAREA' };
    f.state.height = 508;
    f.state.offsetTop = 120;
    f.state.scrollY = 120;
    f.fire('resize');
    expect(f.classes.has(KEYBOARD_CLASS)).toBe(true);
    expect(f.props.get('--kb-top')).toBe('120px');
    expect(f.props.get('--kb-height')).toBe('508px');

    f.state.offsetTop = 60;
    f.fire('scroll');
    expect(f.props.get('--kb-top')).toBe('60px');

    // 收起：先失焦，visualViewport 还没来得及 resize
    f.state.active = null;
    f.focus('focusout');
    expect(f.classes.has(KEYBOARD_CLASS)).toBe(false);
    expect(f.props.size).toBe(0);
    expect(f.scrolls).toEqual([[0, 0]]);
  });

  it('没开过键盘时不动滚动位置', () => {
    const f = fakeWindow({ touch: true });
    installKeyboardInset(f.win);
    f.state.scrollY = 40;
    f.fire('resize');
    expect(f.scrolls).toEqual([]);
    expect(f.classes.size).toBe(0);
  });
});

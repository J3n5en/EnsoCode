import { describe, expect, it } from 'vitest';
import {
  MAC_EVENT_FLAG,
  macClickCount,
  macEventFlags,
  macKeyForAsciiChar,
  macModifierFlag,
  macModifierFlags,
  macMouseButton,
  pickEnglishLayoutIndex,
  resolveMacKey,
  splitMacChord,
  splitTypeSegments,
} from './macKey';

describe('resolveMacKey', () => {
  it('Meta/Command 是修饰键 55，不会落到字母 a（0）', () => {
    expect(resolveMacKey('Meta')).toEqual({ code: 55, modifier: true });
    expect(resolveMacKey('cmd')).toEqual({ code: 55, modifier: true });
    expect(resolveMacKey('a')).toEqual({ code: 0, modifier: false });
  });

  it('未知键不映射成 a', () => {
    expect(resolveMacKey('F19')).toEqual({ code: undefined, modifier: false });
  });

  it('方向键、导航键、F 键与标点都有 kVK 键码', () => {
    const codes = Object.fromEntries(
      [
        'left',
        'ArrowRight',
        'down',
        'ArrowUp',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'ForwardDelete',
        'F1',
        'F12',
        '.',
        ',',
        '/',
        '[',
        ']',
        "'",
        '\\',
        '`',
        '=',
        '-',
        ';',
      ].map((key) => [key, resolveMacKey(key).code])
    );
    expect(codes).toEqual({
      left: 123,
      ArrowRight: 124,
      down: 125,
      ArrowUp: 126,
      Home: 115,
      End: 119,
      PageUp: 116,
      PageDown: 121,
      ForwardDelete: 117,
      F1: 122,
      F12: 111,
      '.': 47,
      ',': 43,
      '/': 44,
      '[': 33,
      ']': 30,
      "'": 39,
      '\\': 42,
      '`': 50,
      '=': 24,
      '-': 27,
      ';': 41,
    });
  });

  it('原型链上的键名不命中', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(resolveMacKey(key)).toEqual({ code: undefined, modifier: false });
    }
  });
});

describe('macModifierFlag', () => {
  it('修饰键键码映射到标志位，普通键为 0', () => {
    expect(macModifierFlag(55)).toBe(MAC_EVENT_FLAG.command);
    expect(macModifierFlag(56)).toBe(MAC_EVENT_FLAG.shift);
    expect(macModifierFlag(58)).toBe(MAC_EVENT_FLAG.alternate);
    expect(macModifierFlag(59)).toBe(MAC_EVENT_FLAG.control);
    expect(macModifierFlag(0)).toBe(0);
  });
});

describe('macEventFlags', () => {
  it('Meta+a 带 Command 标志，单独 a 不带', () => {
    expect(macEventFlags(['Meta', 'a'])).toBe(0x00100000);
    expect(macEventFlags(['a'])).toBe(0);
  });

  it('shift+ctrl+option 可叠加', () => {
    expect(macEventFlags(['shift', 'ctrl', 'option'])).toBe(0x00020000 | 0x00040000 | 0x00080000);
  });
});

describe('splitMacChord', () => {
  it('Meta+a 拆成修饰键 55 和字母 0，并带 Command 标志', () => {
    expect(splitMacChord(['Meta', 'a'])).toEqual({
      modifiers: [55],
      keys: [0],
      flags: 0x00100000,
    });
  });

  it('任一键无法解析就抛错，不只发修饰键', () => {
    expect(() => splitMacChord(['cmd', 'F19'])).toThrow('unmapped key: F19');
    expect(() => splitMacChord(['ctrl', 'constructor'])).toThrow('unmapped key: constructor');
  });

  it('cmd+shift+left 可解析', () => {
    expect(splitMacChord(['cmd', 'shift', 'Left'])).toEqual({
      modifiers: [55, 56],
      keys: [123],
      flags: 0x00100000 | 0x00020000,
    });
  });
});

describe('splitTypeSegments', () => {
  it('拉丁字母和汉字分段，拉丁不走 Unicode', () => {
    expect(splitTypeSegments('nihao 你好')).toEqual([
      { kind: 'ascii', text: 'nihao ' },
      { kind: 'unicode', text: '你好' },
    ]);
  });
});

describe('macKeyForAsciiChar', () => {
  it('n 是键码 45，N 带 Shift', () => {
    expect(macKeyForAsciiChar('n')).toEqual({ code: 45, flags: 0 });
    expect(macKeyForAsciiChar('N')).toEqual({ code: 45, flags: 0x00020000 });
  });

  it('换行映射回车，Tab 映射 Tab 键', () => {
    expect(macKeyForAsciiChar('\n')).toEqual({ code: 36, flags: 0 });
    expect(macKeyForAsciiChar('\r')).toEqual({ code: 36, flags: 0 });
    expect(macKeyForAsciiChar('\t')).toEqual({ code: 48, flags: 0 });
  });

  it('键名不当字符映射', () => {
    expect(macKeyForAsciiChar('constructor')).toBeUndefined();
  });
});

describe('macMouseButton', () => {
  it('左/右/中键映射到 CG 事件类型与按钮号', () => {
    expect(macMouseButton(undefined)).toEqual({ button: 0, down: 1, up: 2, dragged: 6 });
    expect(macMouseButton('left')).toEqual({ button: 0, down: 1, up: 2, dragged: 6 });
    expect(macMouseButton('right')).toEqual({ button: 1, down: 3, up: 4, dragged: 7 });
    expect(macMouseButton('middle')).toEqual({ button: 2, down: 25, up: 26, dragged: 27 });
  });

  it('不支持的按钮显式抛错', () => {
    expect(() => macMouseButton('back')).toThrow('unsupported mouse button: back');
  });
});

describe('macModifierFlags', () => {
  it('只接受修饰键，其它键抛错', () => {
    expect(macModifierFlags(['cmd', 'Shift'])).toBe(0x00100000 | 0x00020000);
    expect(macModifierFlags(undefined)).toBe(0);
    expect(() => macModifierFlags(['a'])).toThrow('unsupported modifier: a');
  });
});

describe('macClickCount', () => {
  it('默认 1，支持 1-3 次，其它显式抛错', () => {
    expect(macClickCount(undefined)).toBe(1);
    expect(macClickCount(3)).toBe(3);
    for (const bad of [0, 4, 1.5, Number.NaN]) {
      expect(() => macClickCount(bad)).toThrow('unsupported click count');
    }
  });
});

describe('pickEnglishLayoutIndex', () => {
  it('优先精确的 ABC，其次 US，不按语言模糊匹配', () => {
    expect(
      pickEnglishLayoutIndex([
        'com.apple.inputmethod.SCIM.ITABC',
        'com.apple.keylayout.US',
        'com.apple.keylayout.ABC',
      ])
    ).toBe(2);
    expect(pickEnglishLayoutIndex(['com.apple.keylayout.US'])).toBe(0);
    expect(pickEnglishLayoutIndex(['com.apple.keylayout.USExtended', 'x'])).toBe(-1);
  });
});

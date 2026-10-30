const MODIFIERS = new Map<string, number>([
  ['meta', 55],
  ['cmd', 55],
  ['command', 55],
  ['super', 55],
  ['win', 55],
  ['shift', 56],
  ['option', 58],
  ['alt', 58],
  ['control', 59],
  ['ctrl', 59],
]);

const KEYS = new Map<string, number>([
  ['a', 0],
  ['s', 1],
  ['d', 2],
  ['f', 3],
  ['h', 4],
  ['g', 5],
  ['z', 6],
  ['x', 7],
  ['c', 8],
  ['v', 9],
  ['b', 11],
  ['q', 12],
  ['w', 13],
  ['e', 14],
  ['r', 15],
  ['y', 16],
  ['t', 17],
  ['1', 18],
  ['2', 19],
  ['3', 20],
  ['4', 21],
  ['6', 22],
  ['5', 23],
  ['=', 24],
  ['equal', 24],
  ['9', 25],
  ['7', 26],
  ['-', 27],
  ['minus', 27],
  ['8', 28],
  ['0', 29],
  [']', 30],
  ['o', 31],
  ['u', 32],
  ['[', 33],
  ['i', 34],
  ['p', 35],
  ['enter', 36],
  ['return', 36],
  ['l', 37],
  ['j', 38],
  ["'", 39],
  ['k', 40],
  [';', 41],
  ['\\', 42],
  [',', 43],
  ['/', 44],
  ['n', 45],
  ['m', 46],
  ['.', 47],
  ['tab', 48],
  ['space', 49],
  ['`', 50],
  ['delete', 51],
  ['backspace', 51],
  ['escape', 53],
  ['esc', 53],
  ['f5', 96],
  ['f6', 97],
  ['f7', 98],
  ['f3', 99],
  ['f8', 100],
  ['f9', 101],
  ['f11', 103],
  ['f10', 109],
  ['f12', 111],
  ['home', 115],
  ['pageup', 116],
  ['forwarddelete', 117],
  ['del', 117],
  ['f4', 118],
  ['end', 119],
  ['f2', 120],
  ['pagedown', 121],
  ['f1', 122],
  ['left', 123],
  ['arrowleft', 123],
  ['right', 124],
  ['arrowright', 124],
  ['down', 125],
  ['arrowdown', 125],
  ['up', 126],
  ['arrowup', 126],
]);

const TYPED_CONTROL = new Map<string, number>([
  ['\n', 36],
  ['\r', 36],
  ['\t', 48],
]);

export function resolveMacKey(key: string): { code: number | undefined; modifier: boolean } {
  const k = key.trim().toLowerCase();
  const modifier = MODIFIERS.get(k);
  if (modifier !== undefined) return { code: modifier, modifier: true };
  return { code: KEYS.get(k), modifier: false };
}

export const MAC_EVENT_FLAG = {
  shift: 0x0002_0000,
  control: 0x0004_0000,
  alternate: 0x0008_0000,
  command: 0x0010_0000,
} as const;

const MODIFIER_FLAG = new Map<number, number>([
  [55, MAC_EVENT_FLAG.command],
  [56, MAC_EVENT_FLAG.shift],
  [58, MAC_EVENT_FLAG.alternate],
  [59, MAC_EVENT_FLAG.control],
]);

/** 修饰键键码对应的事件标志位；非修饰键为 0 */
export function macModifierFlag(code: number): number {
  return MODIFIER_FLAG.get(code) ?? 0;
}

export function macEventFlags(keys: string[]): number {
  let flags = 0;
  for (const key of keys) {
    const code = MODIFIERS.get(key.trim().toLowerCase());
    if (code !== undefined) flags |= MODIFIER_FLAG.get(code) ?? 0;
  }
  return flags;
}

export function macModifierFlags(modifiers: string[] | undefined): number {
  for (const key of modifiers ?? []) {
    if (!MODIFIERS.has(key.trim().toLowerCase())) throw new Error(`unsupported modifier: ${key}`);
  }
  return macEventFlags(modifiers ?? []);
}

const MOUSE_BUTTONS = new Map<
  string,
  { button: number; down: number; up: number; dragged: number }
>([
  ['left', { button: 0, down: 1, up: 2, dragged: 6 }],
  ['right', { button: 1, down: 3, up: 4, dragged: 7 }],
  ['middle', { button: 2, down: 25, up: 26, dragged: 27 }],
]);

export function macMouseButton(button: string | undefined): {
  button: number;
  down: number;
  up: number;
  dragged: number;
} {
  const found = MOUSE_BUTTONS.get((button ?? 'left').trim().toLowerCase());
  if (!found) throw new Error(`unsupported mouse button: ${button}`);
  return { ...found };
}

export function macClickCount(count: number | undefined): number {
  const value = count ?? 1;
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error(`unsupported click count: ${count}`);
  }
  return value;
}

const ENGLISH_LAYOUT_IDS = ['com.apple.keylayout.ABC', 'com.apple.keylayout.US'];

export function pickEnglishLayoutIndex(inputSourceIds: string[]): number {
  for (const wanted of ENGLISH_LAYOUT_IDS) {
    const index = inputSourceIds.indexOf(wanted);
    if (index !== -1) return index;
  }
  return -1;
}

export function splitMacChord(keys: string[]): {
  modifiers: number[];
  keys: number[];
  flags: number;
} {
  const modifiers: number[] = [];
  const codes: number[] = [];
  for (const key of keys) {
    const resolved = resolveMacKey(key);
    if (resolved.code === undefined) throw new Error(`unmapped key: ${key}`);
    if (resolved.modifier) modifiers.push(resolved.code);
    else codes.push(resolved.code);
  }
  return { modifiers, keys: codes, flags: macEventFlags(keys) };
}

export function splitTypeSegments(
  text: string
): Array<{ kind: 'ascii' | 'unicode'; text: string }> {
  const segments: Array<{ kind: 'ascii' | 'unicode'; text: string }> = [];
  for (const char of text) {
    const kind = char.charCodeAt(0) < 128 ? 'ascii' : 'unicode';
    const last = segments.at(-1);
    if (last?.kind === kind) last.text += char;
    else segments.push({ kind, text: char });
  }
  return segments;
}

export function macKeyForAsciiChar(char: string): { code: number; flags: number } | undefined {
  if (char.length !== 1) return undefined;
  const control = TYPED_CONTROL.get(char);
  if (control !== undefined) return { code: control, flags: 0 };
  if (char >= 'A' && char <= 'Z') {
    const code = KEYS.get(char.toLowerCase());
    return code === undefined ? undefined : { code, flags: MAC_EVENT_FLAG.shift };
  }
  if (char === ' ') return { code: 49, flags: 0 };
  // 标点走 Unicode 注入，不依赖当前 ASCII 布局的物理键位
  if (!/^[a-z0-9]$/u.test(char)) return undefined;
  const code = KEYS.get(char);
  return code === undefined ? undefined : { code, flags: 0 };
}

/** 代码围栏的富渲染识别：JSON 树、终端输出。识别不了一律回落普通代码块。 */

export type FenceKind = 'json' | 'terminal';

const JSON_LANGS = new Set(['json', 'jsonc', 'json5']);
const TERMINAL_LANGS = new Set(['console', 'shell-session', 'terminal', 'output', 'ansi']);
const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'shellscript']);
const PROMPT = '$ ';

export function classifyFence(language: string | undefined, source: string): FenceKind | null {
  const lang = language?.toLowerCase();
  if (lang && JSON_LANGS.has(lang)) return isJsonContainer(source) ? 'json' : null;
  if (!lang && /^\s*[{[]/.test(source) && isJsonContainer(source)) return 'json';
  if (lang && TERMINAL_LANGS.has(lang)) return 'terminal';
  if (source.includes('\u001b[')) return 'terminal';
  if (!lang || SHELL_LANGS.has(lang)) {
    const lines = source.split('\n').filter((line) => line.trim());
    if (lines[0]?.startsWith(PROMPT) && lines.some((line) => !line.startsWith(PROMPT))) {
      return 'terminal';
    }
  }
  return null;
}

function isJsonContainer(source: string): boolean {
  const parsed = parseJsonLoose(source);
  return parsed.ok && typeof parsed.value === 'object' && parsed.value !== null;
}

/** JSON / JSONC：按字符串边界去掉注释与尾逗号后再 parse */
export function parseJsonLoose(source: string): { ok: true; value: unknown } | { ok: false } {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (ch === ',' && /^\s*[}\]]/.test(source.slice(i + 1))) {
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  try {
    return { ok: true, value: JSON.parse(out) };
  } catch {
    return { ok: false };
  }
}

export interface AnsiSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

type AnsiStyle = Omit<AnsiSegment, 'text'>;

const COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const CUBE = [0, 95, 135, 175, 215, 255];
const ESC = '\u001b';
const BEL = '\u0007';
/** CSI（含 SGR）、OSC、其余两字节转义 */
const ESCAPE = new RegExp(
  `${ESC}\\[([0-9;?]*)([A-Za-z])|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[@-Z\\\\-_]`,
  'g'
);

function hex(...channels: number[]): string {
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function color256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 8) return COLOR_NAMES[n];
  if (n < 16) return `bright-${COLOR_NAMES[n - 8]}`;
  if (n < 232) {
    const m = n - 16;
    return hex(CUBE[Math.floor(m / 36)]!, CUBE[Math.floor(m / 6) % 6]!, CUBE[m % 6]!);
  }
  const level = 8 + (n - 232) * 10;
  return hex(level, level, level);
}

/** 38/48 扩展色：返回颜色和消耗的参数个数 */
function extendedColor(params: number[], at: number): [string | undefined, number] {
  if (params[at + 1] === 5) return [color256(params[at + 2] ?? -1), 3];
  if (params[at + 1] === 2) {
    const [r, g, b] = params.slice(at + 2, at + 5);
    return [
      r === undefined || g === undefined || b === undefined ? undefined : `rgb(${r},${g},${b})`,
      5,
    ];
  }
  return [undefined, 1];
}

function applySgr(style: AnsiStyle, raw: string): AnsiStyle {
  const params = raw ? raw.split(';').map((p) => Number(p || 0)) : [0];
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) next = {};
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 22) {
      delete next.bold;
      delete next.dim;
    } else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p >= 30 && p <= 37) next.fg = COLOR_NAMES[p - 30];
    else if (p >= 90 && p <= 97) next.fg = `bright-${COLOR_NAMES[p - 90]}`;
    else if (p >= 40 && p <= 47) next.bg = COLOR_NAMES[p - 40];
    else if (p >= 100 && p <= 107) next.bg = `bright-${COLOR_NAMES[p - 100]}`;
    else if (p === 39) delete next.fg;
    else if (p === 49) delete next.bg;
    else if (p === 38 || p === 48) {
      const [value, used] = extendedColor(params, i);
      if (value) next[p === 38 ? 'fg' : 'bg'] = value;
      i += used - 1;
    }
  }
  return next;
}

const sameStyle = (a: AnsiStyle, b: AnsiStyle) =>
  a.fg === b.fg &&
  a.bg === b.bg &&
  a.bold === b.bold &&
  a.dim === b.dim &&
  a.italic === b.italic &&
  a.underline === b.underline;

/** 按 SGR 切分样式段；其它控制序列直接丢弃 */
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  const push = (text: string) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last && sameStyle(last, style)) last.text += text;
    else segments.push({ text, ...style });
  };
  let cursor = 0;
  for (const match of input.matchAll(ESCAPE)) {
    push(input.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[2] === 'm' && !match[1]?.includes('?')) style = applySgr(style, match[1] ?? '');
  }
  push(input.slice(cursor));
  return segments;
}

export function stripAnsi(input: string): string {
  return input.replace(ESCAPE, '');
}

export type ConsolePart = { kind: 'command' | 'output'; text: string };

/** `$ ` 开头的行是命令，其余合并为输出 */
export function splitConsole(source: string): ConsolePart[] {
  const parts: ConsolePart[] = [];
  for (const line of source.split('\n')) {
    if (line.startsWith(PROMPT)) {
      parts.push({ kind: 'command', text: line.slice(PROMPT.length) });
      continue;
    }
    const last = parts.at(-1);
    if (last?.kind === 'output') last.text += `\n${line}`;
    else parts.push({ kind: 'output', text: line });
  }
  return parts;
}

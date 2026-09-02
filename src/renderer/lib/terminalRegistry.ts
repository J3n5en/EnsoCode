/**
 * xterm 实例常驻:只 open 一次,切 tab/切会话只把 host 从 DOM 摘挂(Cursor/VS Code 同款)。
 * 关 tab 才 dispose。pty 在 main 侧,与此独立。
 */

import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { ITheme } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { tabTitleFromTerminal } from '@/lib/terminalTitle';
import '@xterm/xterm/css/xterm.css';

export interface TerminalOptions {
  theme?: ITheme;
  fontFamily: string;
  fontSize: number;
}

export interface TerminalSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface TerminalInstance {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  opened: boolean;
  onTitle?: (title: string) => void;
}

const registry = new Map<string, TerminalInstance>();
let listenersBound = false;

function ensureListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  window.electronAPI.terminal.onData(({ termId, data }) => {
    registry.get(termId)?.term.write(data);
  });
  window.electronAPI.terminal.onExit(({ termId, exitCode }) => {
    registry.get(termId)?.term.write(`\r\n\x1b[2m[process exited: ${exitCode}]\x1b[0m\r\n`);
  });
}

export function acquireTerminal(termId: string, options: TerminalOptions): TerminalInstance {
  ensureListeners();
  const existing = registry.get(termId);
  if (existing) return existing;

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    theme: options.theme,
    // 背景图模式下 wrapper 半透明，xterm 自身不得再刷不透明底色
    allowTransparency: true,
    allowProposedApi: true,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(
    new WebLinksAddon((_ev, uri) => {
      window.open(uri, '_blank');
    })
  );
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = '11';
  const host = document.createElement('div');
  host.dataset.termId = termId;
  host.style.width = '100%';
  host.style.height = '100%';
  term.onData((data) => void window.electronAPI.terminal.write(termId, data));
  const instance: TerminalInstance = { term, fit, search, host, opened: false };
  term.onTitleChange((title) => {
    const next = tabTitleFromTerminal(title);
    if (next) instance.onTitle?.(next);
  });
  // OSC 7: file://host/path,macOS Terminal / 部分 zsh 用来报 cwd
  term.parser.registerOscHandler(7, (data) => {
    try {
      const path = decodeURIComponent(data).replace(/^file:\/\/[^/]*/, '');
      const next = tabTitleFromTerminal(path);
      if (next) instance.onTitle?.(next);
    } catch {
      // 坏 OSC 忽略
    }
    return false;
  });
  registry.set(termId, instance);
  return instance;
}

/** 挂到可见容器;首次且有尺寸才 open */
export function attachTerminal(
  termId: string,
  wrapper: HTMLElement,
  options: TerminalOptions
): TerminalInstance {
  const instance = acquireTerminal(termId, options);
  if (instance.host.parentElement !== wrapper) wrapper.appendChild(instance.host);
  if (!instance.opened && wrapper.isConnected && wrapper.clientWidth > 0) {
    instance.term.open(instance.host);
    instance.opened = true;
  }
  return instance;
}

/** 仅摘 DOM,不 dispose */
export function detachTerminal(termId: string): void {
  registry.get(termId)?.host.remove();
}

export function updateTerminalAppearance(
  theme: ITheme | undefined,
  fontFamily: string,
  fontSize: number
): void {
  for (const { term } of registry.values()) {
    term.options.theme = theme;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
  }
}

export function findInTerminal(
  termId: string,
  query: string,
  direction: 'next' | 'prev',
  options?: TerminalSearchOptions
): boolean {
  const search = registry.get(termId)?.search;
  if (!search || !query) return false;
  return direction === 'next'
    ? search.findNext(query, options)
    : search.findPrevious(query, options);
}

export function clearTerminalSearch(termId: string): void {
  registry.get(termId)?.search.clearDecorations();
}

/** 关 tab:销毁 xterm(pty 由调用方 dispose) */
export function releaseTerminal(termId: string): void {
  const instance = registry.get(termId);
  if (!instance) return;
  registry.delete(termId);
  instance.term.dispose();
  instance.host.remove();
}

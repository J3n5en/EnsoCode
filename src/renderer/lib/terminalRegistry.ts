/**
 * xterm 实例注册表:实例与其 DOM 容器脱离 React 生命周期存活,
 * 切会话/切 tab 只是把容器重新挂进视图,buffer 不丢。pty 生命周期在 main 侧。
 */

import { FitAddon } from '@xterm/addon-fit';
import type { ITheme } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

export interface TerminalOptions {
  cwd?: string;
  theme?: ITheme;
  fontFamily: string;
  fontSize: number;
}

export interface TerminalInstance {
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
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

/** 取或建 xterm 实例;首建时同步在 main 侧建 pty */
export function acquireTerminal(termId: string, options: TerminalOptions): TerminalInstance {
  ensureListeners();
  const existing = registry.get(termId);
  if (existing) return existing;

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    theme: options.theme,
    allowProposedApi: true,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const container = document.createElement('div');
  container.style.width = '100%';
  container.style.height = '100%';
  term.open(container);

  term.onData((data) => void window.electronAPI.terminal.write(termId, data));

  const instance: TerminalInstance = { term, fit, container };
  registry.set(termId, instance);
  void window.electronAPI.terminal.create({
    termId,
    cwd: options.cwd,
    cols: term.cols,
    rows: term.rows,
  });
  return instance;
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

/** 关 tab 时调用:销毁 xterm 实例(main 侧 pty 由 store 另行 dispose) */
export function releaseTerminal(termId: string): void {
  const instance = registry.get(termId);
  if (!instance) return;
  registry.delete(termId);
  instance.term.dispose();
  instance.container.remove();
}

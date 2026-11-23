/**
 * 已创建的 xterm 实例表。只引类型、不引 xterm 运行时，主包里的回收路径能同步调用，
 * 不用为了关 tab 去动态加载 xterm。
 */

import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';

export interface TerminalInstance {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  opened: boolean;
  onTitle?: (title: string) => void;
}

export const terminalInstances = new Map<string, TerminalInstance>();

/** 关 tab:销毁 xterm(pty 由调用方 dispose) */
export function releaseTerminal(termId: string): void {
  const instance = terminalInstances.get(termId);
  if (!instance) return;
  terminalInstances.delete(termId);
  instance.term.dispose();
  instance.host.remove();
}

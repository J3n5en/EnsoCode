import { statSync } from 'node:fs';
import os from 'node:os';
import type { TerminalCreateRequest, TerminalCreateResult } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import type { WebContents } from 'electron';
import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';

interface TerminalEntry {
  pty: IPty;
  sender: WebContents;
}

const terminals = new Map<string, TerminalEntry>();

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/zsh';
}

/** 目录存在校验后回落 home:cwd 只决定工作目录,不涉及文件读取 */
export function resolveCwd(cwd: string | undefined): string {
  if (cwd && isDirectory(cwd)) return cwd;
  return os.homedir();
}

export function createTerminal(
  request: TerminalCreateRequest,
  sender: WebContents
): TerminalCreateResult {
  const existing = terminals.get(request.termId);
  if (existing) {
    // renderer 重载后 xterm buffer 已空但 pty 还活着:重绑 sender 并拖动 resize
    // 触发 SIGWINCH,让 shell 重绘 prompt,避免看起来像死终端
    existing.sender = sender;
    const cols = request.cols ?? existing.pty.cols;
    const rows = request.rows ?? existing.pty.rows;
    try {
      existing.pty.resize(Math.max(1, cols - 1), rows);
      existing.pty.resize(cols, rows);
    } catch {
      // pty 已退出
    }
    return { ok: true };
  }
  try {
    const pty = spawn(defaultShell(), [], {
      name: 'xterm-256color',
      cwd: resolveCwd(request.cwd),
      cols: request.cols ?? 80,
      rows: request.rows ?? 24,
      env: { ...process.env, TERM_PROGRAM: 'EnsoCode' } as Record<string, string>,
    });
    const entry: TerminalEntry = { pty, sender };
    pty.onData((data) => {
      if (!entry.sender.isDestroyed())
        entry.sender.send(IPC_CHANNELS.TERMINAL_DATA, { termId: request.termId, data });
    });
    pty.onExit(({ exitCode }) => {
      terminals.delete(request.termId);
      if (!entry.sender.isDestroyed())
        entry.sender.send(IPC_CHANNELS.TERMINAL_EXIT, { termId: request.termId, exitCode });
    });
    // 窗口销毁时回收 pty,避免孤儿 shell
    sender.once('destroyed', () => disposeTerminal(request.termId));
    terminals.set(request.termId, entry);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function writeTerminal(termId: string, data: string): void {
  terminals.get(termId)?.pty.write(data);
}

export function resizeTerminal(termId: string, cols: number, rows: number): void {
  if (cols < 1 || rows < 1) return;
  try {
    terminals.get(termId)?.pty.resize(cols, rows);
  } catch {
    // pty 已退出时 resize 会抛,忽略
  }
}

export function disposeTerminal(termId: string): void {
  const entry = terminals.get(termId);
  if (!entry) return;
  terminals.delete(termId);
  try {
    entry.pty.kill();
  } catch {
    // 已退出
  }
}

export function disposeAllTerminals(): void {
  for (const termId of [...terminals.keys()]) disposeTerminal(termId);
}

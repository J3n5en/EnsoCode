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

/** 与 agent spawn 同一口径:有隔离 worktree 用它,否则本地项目根,都没有才 home */
export function pickSessionCwd(input: {
  worktreePath?: string;
  projectPath?: string;
  ssh?: boolean;
  home: string;
  exists: (dir: string) => boolean;
}): string {
  if (input.worktreePath && input.exists(input.worktreePath)) return input.worktreePath;
  if (!input.ssh && input.projectPath && input.exists(input.projectPath)) return input.projectPath;
  return input.home;
}

export interface TerminalSpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export function localShellSpec(cwd: string): TerminalSpawnSpec {
  return {
    file: defaultShell(),
    args: [],
    cwd: isDirectory(cwd) ? cwd : os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'EnsoCode' } as Record<
      string,
      string
    >,
  };
}

/** node-pty 在 cols/rows 为 0 时 shell 会立刻 exit 0 */
export function resolvePtySize(cols?: number, rows?: number): { cols: number; rows: number } {
  return {
    cols: typeof cols === 'number' && cols >= 1 ? Math.floor(cols) : 80,
    rows: typeof rows === 'number' && rows >= 1 ? Math.floor(rows) : 24,
  };
}

export function createTerminal(
  request: TerminalCreateRequest,
  sender: WebContents,
  spec: TerminalSpawnSpec
): TerminalCreateResult {
  const existing = terminals.get(request.termId);
  if (existing) {
    existing.sender = sender;
    // 已有 pty 不抖动 resize:SIGWINCH 会让 shell 重绘,看起来像「历史丢了只剩新 prompt」
    const cols = request.cols ?? existing.pty.cols;
    const rows = request.rows ?? existing.pty.rows;
    if (cols !== existing.pty.cols || rows !== existing.pty.rows) {
      try {
        existing.pty.resize(cols, rows);
      } catch {
        // pty 已退出
      }
    }
    return { ok: true };
  }
  try {
    const { cols, rows } = resolvePtySize(request.cols, request.rows);
    const pty = spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cwd: spec.cwd,
      cols,
      rows,
      env: spec.env,
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

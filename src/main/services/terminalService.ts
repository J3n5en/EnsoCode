import { statSync } from 'node:fs';
import os from 'node:os';
import { resolveTerminalShellFile, type TerminalShell } from '@shared/terminalShell';
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
/** kill 之后 native wait 线程仍可能活着；FreeEnvironment 前必须等 onExit，否则 TSFN 抛 C++ 异常 abort */
const pendingPtys = new Set<IPty>();

const PTY_QUIT_SOFT_MS = 500;
const PTY_QUIT_HARD_MS = 1500;
const PTY_QUIT_POLL_MS = 20;

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
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

const UTF8_LOCALE_RE = /utf-?8/i;

function isUtf8Locale(value: string | undefined): boolean {
  return Boolean(value && UTF8_LOCALE_RE.test(value));
}

function utf8Fallback(lang: string | undefined): string {
  if (!lang || lang === 'C' || lang === 'POSIX') return 'en_US.UTF-8';
  if (isUtf8Locale(lang)) return lang;
  const dot = lang.lastIndexOf('.');
  return dot > 0 ? `${lang.slice(0, dot)}.UTF-8` : `${lang}.UTF-8`;
}

/** Electron 从 Finder 启动时常没有 UTF-8 locale，xterm 输入中文会乱码 */
export function withUtf8Locale(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  if (
    isUtf8Locale(out.LC_ALL) ||
    (!out.LC_ALL && (isUtf8Locale(out.LC_CTYPE) || isUtf8Locale(out.LANG)))
  ) {
    return out;
  }
  const fallback = utf8Fallback(out.LANG);
  out.LANG = isUtf8Locale(out.LANG) ? out.LANG : fallback;
  if (out.LC_ALL) out.LC_ALL = fallback;
  if (!isUtf8Locale(out.LC_CTYPE)) out.LC_CTYPE = out.LANG;
  return out;
}

export function localShellSpec(cwd: string, shell: TerminalShell = 'auto'): TerminalSpawnSpec {
  return {
    file: resolveTerminalShellFile(shell, process.platform, process.env),
    args: [],
    cwd: isDirectory(cwd) ? cwd : os.homedir(),
    env: withUtf8Locale({ ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'EnsoCode' }),
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
      env: withUtf8Locale(spec.env ?? process.env),
    });
    const entry: TerminalEntry = { pty, sender };
    pendingPtys.add(pty);
    pty.onData((data) => {
      try {
        if (!entry.sender.isDestroyed())
          entry.sender.send(IPC_CHANNELS.TERMINAL_DATA, { termId: request.termId, data });
      } catch {
        // 退出过程中 webContents 可能已不可用
      }
    });
    pty.onExit(({ exitCode }) => {
      pendingPtys.delete(pty);
      terminals.delete(request.termId);
      try {
        if (!entry.sender.isDestroyed())
          entry.sender.send(IPC_CHANNELS.TERMINAL_EXIT, { termId: request.termId, exitCode });
      } catch {
        // 同上
      }
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
    // onExit 才从 pending 删；kill 抛错时 wait 线程可能仍活着
  }
}

export function disposeAllTerminals(): void {
  for (const termId of [...terminals.keys()]) disposeTerminal(termId);
}

export function hasPendingPtys(): boolean {
  return pendingPtys.size > 0;
}

export function waitPtyQuitIdle(): Promise<void> {
  return runPtyQuitIdle({
    hasPending: () => pendingPtys.size > 0,
    forceKill: forceKillPendingPtys,
    waitUntilIdle: waitForPendingPtys,
    softMs: PTY_QUIT_SOFT_MS,
    hardMs: PTY_QUIT_HARD_MS,
  });
}

async function waitForPendingPtys(timeoutMs: number, pollMs = PTY_QUIT_POLL_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pendingPtys.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

function forceKillPendingPtys(): void {
  for (const pty of [...pendingPtys]) {
    try {
      if (process.platform === 'win32') pty.kill();
      else pty.kill('SIGKILL');
    } catch {
      // onExit 才从 pending 删
    }
  }
}

/** SIGHUP 等不及就 SIGKILL，避免 FreeEnvironment 时 TSFN CallJS abort */
export async function runPtyQuitIdle(input: {
  hasPending: () => boolean;
  forceKill: () => void;
  waitUntilIdle: (ms: number) => Promise<void>;
  softMs: number;
  hardMs: number;
}): Promise<void> {
  await input.waitUntilIdle(input.softMs);
  if (!input.hasPending()) return;
  input.forceKill();
  await input.waitUntilIdle(input.hardMs);
}

export function createPtyQuitDrain(input: {
  disposeAll: () => void;
  hasPending: () => boolean;
  waitIdle: () => Promise<void>;
}): { onWillQuit: (event: { preventDefault: () => void }, quit: () => void) => void } {
  let draining = false;
  return {
    onWillQuit(event, quit) {
      if (draining) return;
      input.disposeAll();
      if (!input.hasPending()) return;
      draining = true;
      event.preventDefault();
      void input.waitIdle().finally(quit);
    },
  };
}

export function attachPtyQuitDrain(app: {
  on(event: 'will-quit', listener: (event: { preventDefault: () => void }) => void): void;
  quit(): void;
}): void {
  const drain = createPtyQuitDrain({
    disposeAll: disposeAllTerminals,
    hasPending: () => pendingPtys.size > 0,
    waitIdle: () =>
      runPtyQuitIdle({
        hasPending: () => pendingPtys.size > 0,
        forceKill: forceKillPendingPtys,
        waitUntilIdle: waitForPendingPtys,
        softMs: PTY_QUIT_SOFT_MS,
        hardMs: PTY_QUIT_HARD_MS,
      }),
  });
  app.on('will-quit', (event) => drain.onWillQuit(event, () => app.quit()));
}

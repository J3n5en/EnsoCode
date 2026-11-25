import { type ChildProcess, spawn } from 'node:child_process';
import { lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { GitCloneRequest, GitCloneResult } from '@shared/types';

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ERROR_CHARS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRequest(value: unknown): GitCloneRequest | null {
  if (!isRecord(value)) return null;
  const { url, parentDir, name } = value;
  if (typeof url !== 'string' || typeof parentDir !== 'string') return null;
  if (name !== undefined && typeof name !== 'string') return null;
  return name === undefined ? { url, parentDir } : { url, parentDir, name };
}

function isSafeName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.startsWith('-') &&
    !/[/\\\0]/.test(name) &&
    Buffer.byteLength(name) <= 255
  );
}

function leafName(value: string): string | null {
  const trimmed = value.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  const segment = parts[parts.length - 1];
  if (!segment) return null;
  const name = segment.replace(/\.git$/i, '');
  return isSafeName(name) ? name : null;
}

/** 完整 git URL 原样使用；owner/repo 补成 GitHub https。拒绝 file、本地路径和以 - 开头的参数。 */
function resolveRemote(raw: string): { cloneUrl: string; name: string } | { error: string } {
  const input = raw.trim();
  if (!input || input.startsWith('-') || /[\s\0]/.test(input)) {
    return { error: 'Invalid git URL.' };
  }
  if (/^(?:file:|[\\/~.]|[a-z]:[\\/])/i.test(input)) {
    return { error: 'Invalid git URL.' };
  }

  const shorthand = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(input);
  if (shorthand) {
    const name = shorthand[2].replace(/\.git$/i, '');
    if (!isSafeName(name)) return { error: 'Invalid git URL.' };
    const cloneUrl = /\.git$/i.test(input)
      ? `https://github.com/${input}`
      : `https://github.com/${input}.git`;
    return { cloneUrl, name };
  }

  if (input.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      return { error: 'Invalid git URL.' };
    }
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) {
      return { error: 'Invalid git URL.' };
    }
    const name = leafName(parsed.pathname);
    if (!name) return { error: 'Invalid git URL.' };
    return { cloneUrl: input, name };
  }

  const scp = /^[A-Za-z0-9._+-]+@[A-Za-z0-9._-]+:(.+)$/.exec(input);
  if (scp) {
    const name = leafName(scp[1]);
    if (!name) return { error: 'Invalid git URL.' };
    return { cloneUrl: input, name };
  }

  return { error: 'Invalid git URL.' };
}

function clipError(stderr: string, fallback: string): string {
  const lines = stderr
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const text = lines.slice(-12).join('\n') || fallback;
  return text.length > MAX_ERROR_CHARS ? text.slice(-MAX_ERROR_CHARS) : text;
}

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function runClone(cloneUrl: string, target: string): Promise<GitCloneResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('git', ['clone', cloneUrl, target], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (error) {
      resolve({
        ok: false,
        error: error instanceof Error ? error.message : 'git clone failed.',
      });
      return;
    }

    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'Clone timed out.' });
    }, CLONE_TIMEOUT_MS);
    const finish = (result: GitCloneResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.once('error', (error: Error) => {
      finish({ ok: false, error: error.message || 'git clone failed.' });
    });
    child.once('close', (code) => {
      finish(
        timedOut
          ? { ok: false, error: 'Clone timed out.' }
          : code === 0
            ? { ok: true, path: target }
            : { ok: false, error: clipError(stderr, 'git clone failed.') }
      );
    });
  });
}

/** 克隆远程仓库到 parentDir/name。入参按 unknown 收窄，不经过 shell。 */
export async function gitClone(request: unknown): Promise<GitCloneResult> {
  const parsed = parseRequest(request);
  if (!parsed) return { ok: false, error: 'Invalid request.' };
  // 与 hostDirs 一致：`~` 与 `~/...` 展开到家目录
  const input = parsed.parentDir.trim();
  const expanded =
    input === '~'
      ? homedir()
      : input.startsWith('~/')
        ? path.join(homedir(), input.slice(2))
        : input;
  if (!path.isAbsolute(expanded)) return { ok: false, error: 'Invalid request.' };
  const parentDir = expanded;

  const remote = resolveRemote(parsed.url);
  if ('error' in remote) return { ok: false, error: remote.error };

  const explicit = parsed.name?.trim() ?? '';
  const name = explicit || remote.name;
  if (!isSafeName(name)) return { ok: false, error: 'Invalid folder name.' };

  const parent = path.resolve(parentDir);
  try {
    if (!statSync(parent).isDirectory()) return { ok: false, error: 'Not a directory.' };
  } catch (error) {
    if (errno(error) === 'ENOENT') return { ok: false, error: 'Directory not found.' };
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Directory not found.',
    };
  }

  const target = path.join(parent, name);
  try {
    lstatSync(target);
    return { ok: false, error: 'A file or folder with that name already exists.' };
  } catch (error) {
    if (errno(error) !== 'ENOENT') {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'git clone failed.',
      };
    }
  }

  return runClone(remote.cloneUrl, target);
}

import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { GitDiffFile, GitDiffResult } from '@shared/types/gitDiff';

export type { GitDiffFile, GitDiffResult };

const MAX_BYTES = 2_000_000;

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitDiffHost {
  isDir(dir: string): boolean;
  run(args: string[], cwd: string): Promise<GitRunResult>;
  readFile(absPath: string): Promise<string | null>;
}

function splitNul(buf: string): string[] {
  return buf.split('\0').filter((part) => part.length > 0);
}

export function parseNameStatus(buf: string): { status: string; path: string }[] {
  const tokens = splitNul(buf);
  const out: { status: string; path: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    const code = status[0];
    if ((code === 'R' || code === 'C') && i + 2 < tokens.length) {
      i += 2;
      continue;
    }
    const filePath = tokens[i + 1];
    if (!filePath) break;
    i += 1;
    out.push({ status: code, path: filePath });
  }
  return out;
}

function mapStatus(code: string): GitDiffFile['status'] | null {
  if (code === 'M' || code === 'T') return 'modified';
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  return null;
}

export async function diffHead(cwd: string, host: GitDiffHost): Promise<GitDiffResult> {
  if (!host.isDir(cwd)) return { ok: false, error: 'unavailable' };

  const inside = await host.run(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { ok: false, error: 'not-repo' };
  }

  const [named, others] = await Promise.all([
    host.run(['diff', 'HEAD', '--name-status', '-z', '--no-renames'], cwd),
    host.run(['ls-files', '--others', '--exclude-standard', '-z'], cwd),
  ]);

  const files: GitDiffFile[] = [];
  const seen = new Set<string>();

  for (const entry of parseNameStatus(named.stdout)) {
    const status = mapStatus(entry.status);
    if (!status) continue;
    const file = await loadFile(cwd, entry.path, status, host);
    if (!file) continue;
    seen.add(entry.path);
    files.push(file);
  }

  for (const rel of splitNul(others.stdout)) {
    if (seen.has(rel)) continue;
    const file = await loadFile(cwd, rel, 'untracked', host);
    if (file) files.push(file);
  }

  return { ok: true, files };
}

async function loadFile(
  cwd: string,
  rel: string,
  status: GitDiffFile['status'],
  host: GitDiffHost
): Promise<GitDiffFile | null> {
  const abs = path.join(cwd, rel);
  let oldText = '';
  let newText = '';

  if (status === 'modified' || status === 'deleted') {
    const shown = await host.run(['show', `HEAD:${rel}`], cwd);
    if (shown.code !== 0) return null;
    oldText = shown.stdout;
  }
  if (status !== 'deleted') {
    const current = await host.readFile(abs);
    if (current == null) return null;
    newText = current;
  }
  if (oldText === newText) return null;
  return { path: rel, status, oldText, newText };
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function localGitDiffHost(): GitDiffHost {
  return {
    isDir,
    run: (args, cwd) => runGit(args, cwd),
    readFile: async (absPath) => readUtf8(absPath),
  };
}

function readUtf8(filePath: string): string | null {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buf = readFileSync(filePath);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', () => resolve({ code: 1, stdout: '', stderr: 'spawn failed' }));
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    );
  });
}

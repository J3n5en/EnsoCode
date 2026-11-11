import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FilesSearchContentHit, FilesSearchNameHit, FilesSearchResult } from '@shared/types';
import type { ParsedWorkspaceFileSearchRequest } from '@shared/workspaceFileSearch';
import { fuzzyScore } from './fileSearch';

const SEARCH_TIMEOUT_MS = 10_000;
const EXCLUDE_GLOBS = [
  '!node_modules/**',
  '!dist/**',
  '!build/**',
  '!.git/**',
  '!*.lock',
  '!package-lock.json',
];

/** rg 跑完的结果；`failure` 只在进程根本没跑起来（missing）或被我们掐掉（timeout）时出现 */
export interface RgRunResult {
  code: number;
  stdout: string;
  failure?: 'missing' | 'timeout';
}

export type RgRunner = (args: string[], cwd: string) => Promise<RgRunResult>;

export function toRelativePosix(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export function rankNameHits(
  files: readonly string[],
  query: string,
  maxResults: number
): FilesSearchNameHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const needle = trimmed.toLowerCase();
  return files
    .map((relativePath) => {
      const name = relativePath.split('/').pop() || relativePath;
      let score = Math.max(fuzzyScore(trimmed, name) * 2, fuzzyScore(trimmed, relativePath));
      if (name.toLowerCase() === needle) score += 1000;
      return { relativePath, name, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ relativePath, name }) => ({ relativePath, name }));
}

export function parseRipgrepJsonMatch(line: string, root: string): FilesSearchContentHit | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const rec = json as Record<string, unknown>;
  if (rec.type !== 'match' || !rec.data || typeof rec.data !== 'object' || Array.isArray(rec.data))
    return null;
  const data = rec.data as Record<string, unknown>;
  const pathRec = data.path;
  const pathText =
    pathRec && typeof pathRec === 'object' && !Array.isArray(pathRec)
      ? (pathRec as Record<string, unknown>).text
      : undefined;
  if (typeof pathText !== 'string' || typeof data.line_number !== 'number') return null;
  const abs = path.isAbsolute(pathText) ? pathText : path.join(root, pathText);
  const relativePath = toRelativePosix(root, abs);
  if (!relativePath) return null;
  const lines = data.lines;
  const text =
    lines && typeof lines === 'object' && !Array.isArray(lines)
      ? (lines as Record<string, unknown>).text
      : '';
  const submatches = Array.isArray(data.submatches) ? data.submatches[0] : undefined;
  const start =
    submatches && typeof submatches === 'object' && !Array.isArray(submatches)
      ? (submatches as Record<string, unknown>).start
      : 0;
  const end =
    submatches && typeof submatches === 'object' && !Array.isArray(submatches)
      ? (submatches as Record<string, unknown>).end
      : 0;
  const column = typeof start === 'number' ? start : 0;
  const matchEnd = typeof end === 'number' ? end : column;
  return {
    relativePath,
    line: data.line_number,
    column,
    matchLength: Math.max(0, matchEnd - column),
    content: typeof text === 'string' ? text.replace(/\n$/, '') : '',
  };
}

export function buildNameSearchArgs(): string[] {
  return ['--files', ...EXCLUDE_GLOBS.flatMap((glob) => ['--glob', glob]), '.'];
}

export function buildContentSearchArgs(opts: {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}): string[] {
  const args = [
    '--json',
    '--line-number',
    '--column',
    '--max-count',
    '100',
    '--max-filesize',
    '1M',
    ...EXCLUDE_GLOBS.flatMap((glob) => ['--glob', glob]),
  ];
  if (!opts.caseSensitive) args.push('-i');
  if (opts.wholeWord) args.push('-w');
  if (!opts.regex) args.push('-F');
  args.push('--', opts.query, '.');
  return args;
}

/**
 * rg 可执行文件的候选顺序：随包二进制优先（asar 内不能执行，改指向 asar.unpacked），
 * 其次是 PATH 上用户自装的 rg。随包下载在 postinstall 阶段走 GitHub，离线 / 被墙 / 用
 * --ignore-scripts 安装的无界面服务端都可能缺这一个文件，没有回退整个搜索面板就只剩一句报错。
 */
export async function ripgrepCandidates(): Promise<string[]> {
  const { rgPath: originalRgPath } = await import('@vscode/ripgrep');
  const bundled = originalRgPath.replace(/\.asar([\\/])/, '.asar.unpacked$1');
  const fromPath = process.platform === 'win32' ? 'rg.exe' : 'rg';
  // 随包文件已经确认不存在就不必再 spawn 一次拿 ENOENT；PATH 候选交给 spawn 自己去找
  return existsSync(bundled) ? [bundled, fromPath] : [fromPath];
}

function spawnOnce(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<RgRunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, windowsHide: true });
    let stdout = '';
    let settled = false;
    const finish = (result: RgRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: 2, stdout, failure: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    // 'error' 在进程起不来（ENOENT / EACCES）时触发；起来之后的失败走 close 的退出码
    child.on('error', () => finish({ code: 2, stdout: '', failure: 'missing' }));
    child.on('close', (code) => finish({ code: code ?? 2, stdout }));
  });
}

/** 依次尝试候选可执行文件；只有「起不来」才换下一个，rg 自身的退出码照原样返回 */
export async function runRipgrep(
  candidates: readonly string[],
  args: string[],
  cwd: string,
  timeoutMs = SEARCH_TIMEOUT_MS
): Promise<RgRunResult> {
  for (const file of candidates) {
    const result = await spawnOnce(file, args, cwd, timeoutMs);
    if (result.failure !== 'missing') return result;
  }
  return { code: 2, stdout: '', failure: 'missing' };
}

export async function spawnRipgrep(args: string[], cwd: string): Promise<RgRunResult> {
  return runRipgrep(await ripgrepCandidates(), args, cwd);
}

function listedRelativeFiles(stdout: string, cwd: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const abs = path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed);
    const rel = toRelativePosix(cwd, abs);
    if (rel) files.push(rel);
  }
  return files;
}

/**
 * rg 退出码 2 = 出错，但「找不到 rg」「跑超时」和「正则写错」对用户是三件事：
 * 前两个要提示装 rg / 缩小范围，最后一个只是这次查询不合法。
 */
function failureCode(result: RgRunResult): string {
  if (result.failure === 'missing') return 'rg-missing';
  if (result.failure === 'timeout') return 'timeout';
  return 'unavailable';
}

export async function searchWorkspaceFiles(
  cwd: string,
  request: ParsedWorkspaceFileSearchRequest,
  run: RgRunner = spawnRipgrep
): Promise<FilesSearchResult> {
  if (request.mode === 'names') {
    if (!request.query.trim()) return { ok: true, mode: 'names', hits: [] };
    const names = await run(buildNameSearchArgs(), cwd);
    if (names.code === 2) return { ok: false, error: failureCode(names) };
    const { stdout } = names;
    return {
      ok: true,
      mode: 'names',
      hits: rankNameHits(listedRelativeFiles(stdout, cwd), request.query, request.maxResults),
    };
  }
  if (!request.query.trim()) return { ok: true, mode: 'content', hits: [], truncated: false };
  const content = await run(
    buildContentSearchArgs({
      query: request.query,
      caseSensitive: request.caseSensitive,
      wholeWord: request.wholeWord,
      regex: request.regex,
    }),
    cwd
  );
  if (content.code === 2) return { ok: false, error: failureCode(content) };
  const { stdout } = content;
  const hits: FilesSearchContentHit[] = [];
  let truncated = false;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const hit = parseRipgrepJsonMatch(line, cwd);
    if (!hit) continue;
    if (hits.length >= request.maxResults) {
      truncated = true;
      break;
    }
    hits.push(hit);
  }
  return { ok: true, mode: 'content', hits, truncated };
}

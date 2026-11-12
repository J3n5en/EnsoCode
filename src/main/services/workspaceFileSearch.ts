import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { FilesSearchContentHit, FilesSearchNameHit, FilesSearchResult } from '@shared/types';
import type { ParsedWorkspaceFileSearchRequest } from '@shared/workspaceFileSearch';
import { fuzzyScore } from './fileSearch';

const SEARCH_TIMEOUT_MS = 10_000;
/**
 * rg 输出的字节上限。内容搜索拿够结果会提前结束 rg，这里兜底超长行（压缩产物）和超大仓库的
 * 文件列举：输出全拼成一个字符串，超过 V8 字符串上限会在 data 监听里抛 RangeError，成为主进程未捕获异常。
 */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const EXCLUDE_GLOBS = [
  '!node_modules/**',
  '!dist/**',
  '!build/**',
  '!.git/**',
  '!*.lock',
  '!package-lock.json',
];

/**
 * rg 跑完的结果；`failure` 只在进程根本没跑起来（missing）、被我们掐掉（timeout）
 * 或被调用方取消（cancelled）时出现
 */
export interface RgRunResult {
  code: number;
  stdout: string;
  failure?: 'missing' | 'timeout' | 'cancelled';
  /** 调用方已拿够或输出超出字节上限，被我们提前结束；stdout 只保留完整行 */
  truncated?: boolean;
}

export interface RgRunOptions {
  /** 逐行交给调用方（此时不再累积 stdout）；返回 false 表示结果已够，立即结束 rg */
  onLine?: (line: string) => boolean;
  maxBytes?: number;
  /** 同一会话的新搜索到来时由 handler 中止：结果已没人要，及早结束 rg 免得在大仓库里堆积 */
  signal?: AbortSignal;
}

export type RgRunner = (
  args: string[],
  cwd: string,
  options?: RgRunOptions
) => Promise<RgRunResult>;

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
export interface ResolveRgOptions {
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
}

function rgFileExists(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (platform === 'win32') return existsSync(candidate);
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 PATH 上找 rg。只接受绝对目录，跳过空项、`.` 和相对路径；Windows 只认 rg.exe。
 * 找不到返回 null，调用方按 rg 缺失处理，不能把裸文件名交给 spawn（Windows 会先搜 cwd）。
 */
export function resolveRgFromPath(
  pathEnv: string | undefined,
  options: ResolveRgOptions = {}
): string | null {
  if (!pathEnv) return null;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const name = platform === 'win32' ? 'rg.exe' : 'rg';
  const exists = options.exists ?? ((candidate: string) => rgFileExists(candidate, platform));
  for (const entry of pathEnv.split(delimiter)) {
    if (!entry || !pathApi.isAbsolute(entry)) continue;
    const candidate = pathApi.join(entry, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export async function ripgrepCandidates(): Promise<string[]> {
  const { rgPath: originalRgPath } = await import('@vscode/ripgrep');
  const bundled = originalRgPath.replace(/\.asar([\\/])/, '.asar.unpacked$1');
  const candidates: string[] = [];
  if (existsSync(bundled)) candidates.push(bundled);
  const fromPath = resolveRgFromPath(process.env.PATH);
  if (fromPath) candidates.push(fromPath);
  return candidates;
}

function spawnOnce(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  { onLine, maxBytes = MAX_OUTPUT_BYTES, signal }: RgRunOptions
): Promise<RgRunResult> {
  return new Promise((resolve) => {
    // 取消可能落在查找候选或换下一个候选的间隙里，此时已无人要结果，不必再起进程
    if (signal?.aborted) {
      resolve({ code: 2, stdout: '', failure: 'cancelled' });
      return;
    }
    const child = spawn(file, args, { cwd, windowsHide: true });
    // 按字节分块到达，多字节字符可能被切开，交给 StringDecoder 拼回
    const decoder = new StringDecoder('utf8');
    let stdout = '';
    let pending = '';
    let bytes = 0;
    let settled = false;
    const finish = (result: RgRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    // 提前收尾按成功处理：已收到的完整行照常可用，被切断的半行丢弃
    const stop = () => {
      child.kill();
      finish({ code: 0, stdout: stdout.slice(0, stdout.lastIndexOf('\n') + 1), truncated: true });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: 2, stdout, failure: 'timeout' });
    }, timeoutMs);
    const cancel = () => {
      child.kill();
      finish({ code: 2, stdout, failure: 'cancelled' });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        stop();
        return;
      }
      const text = decoder.write(chunk);
      if (!onLine) {
        stdout += text;
        return;
      }
      // 只切新到的这块，半行接到首段：超长行跨很多块时不必每次重扫已累积的部分
      const lines = text.split('\n');
      lines[0] = `${pending}${lines[0]}`;
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!onLine(line)) {
          stop();
          return;
        }
      }
    });
    // 'error' 在进程起不来（ENOENT / EACCES）时触发；起来之后的失败走 close 的退出码
    child.on('error', () => finish({ code: 2, stdout: '', failure: 'missing' }));
    child.on('close', (code) => {
      const rest = decoder.end();
      if (settled) return;
      if (onLine) {
        // 最后一行可能没有换行符
        const last = `${pending}${rest}`;
        if (last) onLine(last);
      } else {
        stdout += rest;
      }
      finish({ code: code ?? 2, stdout });
    });
  });
}

/** 依次尝试候选可执行文件；只有「起不来」才换下一个，rg 自身的退出码照原样返回 */
export async function runRipgrep(
  candidates: readonly string[],
  args: string[],
  cwd: string,
  timeoutMs = SEARCH_TIMEOUT_MS,
  options: RgRunOptions = {}
): Promise<RgRunResult> {
  for (const file of candidates) {
    const result = await spawnOnce(file, args, cwd, timeoutMs, options);
    if (result.failure !== 'missing') return result;
  }
  return { code: 2, stdout: '', failure: 'missing' };
}

export async function spawnRipgrep(
  args: string[],
  cwd: string,
  options?: RgRunOptions
): Promise<RgRunResult> {
  return runRipgrep(await ripgrepCandidates(), args, cwd, SEARCH_TIMEOUT_MS, options);
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
 * 被新搜索取消的单独标出，renderer 本就按序号丢弃过期结果。
 */
function failureCode(result: RgRunResult): string {
  if (result.failure === 'missing') return 'rg-missing';
  if (result.failure === 'timeout') return 'timeout';
  if (result.failure === 'cancelled') return 'cancelled';
  return 'unavailable';
}

export async function searchWorkspaceFiles(
  cwd: string,
  request: ParsedWorkspaceFileSearchRequest,
  run: RgRunner = spawnRipgrep,
  signal?: AbortSignal
): Promise<FilesSearchResult> {
  if (request.mode === 'names') {
    if (!request.query.trim()) return { ok: true, mode: 'names', hits: [] };
    const names = await run(buildNameSearchArgs(), cwd, { signal });
    if (names.code === 2) return { ok: false, error: failureCode(names) };
    const { stdout } = names;
    return {
      ok: true,
      mode: 'names',
      hits: rankNameHits(listedRelativeFiles(stdout, cwd), request.query, request.maxResults),
    };
  }
  if (!request.query.trim()) return { ok: true, mode: 'content', hits: [], truncated: false };
  const hits: FilesSearchContentHit[] = [];
  let truncated = false;
  // 边读边解析：凑够 maxResults 后再见到一条命中就能判定 truncated 并结束 rg，不必等它扫完整个仓库
  const content = await run(
    buildContentSearchArgs({
      query: request.query,
      caseSensitive: request.caseSensitive,
      wholeWord: request.wholeWord,
      regex: request.regex,
    }),
    cwd,
    {
      signal,
      onLine: (line) => {
        const hit = line.trim() ? parseRipgrepJsonMatch(line, cwd) : null;
        if (!hit) return true;
        if (hits.length >= request.maxResults) {
          truncated = true;
          return false;
        }
        hits.push(hit);
        return true;
      },
    }
  );
  if (content.code === 2) return { ok: false, error: failureCode(content) };
  // 输出超出字节上限被截断时，已解析的命中照常返回，同样提示结果不完整
  return { ok: true, mode: 'content', hits, truncated: truncated || content.truncated === true };
}

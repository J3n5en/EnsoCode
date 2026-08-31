/**
 * 把 pi SDK 工具的 *Operations 接口落到 SshExecutor 上:
 * read/write/edit/ls/find/bash 六类经 operations 注入原厂工具,语义与本地版一致;
 * grep 的搜索本体在 SDK 内是本地 spawn rg,无法注入,由 remoteTools 单独包 execute。
 */

import { dirname } from 'node:path';
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from '@earendil-works/pi-coding-agent';
import { shellQuote } from '@shared/ssh';
import type { SshExecutor } from './executor';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/** 远端不便读文件魔数,按扩展名判定图片类型(read 工具附件用) */
export function detectImageMimeByExtension(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME_BY_EXTENSION[ext] ?? null;
}

/** find 工具的 glob → 远端 find 脚本。`**` 折叠为 `*`(find -path 的 * 本就跨 /) */
export function buildRemoteFindScript(
  pattern: string,
  cwd: string,
  options: { ignore: string[]; limit: number }
): string {
  const prunes = options.ignore
    .map((dir) => `-name ${shellQuote(dir)} -prune -o`)
    .join(' ');
  const matcher = pattern.includes('/')
    ? `-path ${shellQuote(`${cwd}/${pattern.replaceAll('**/', '*').replaceAll('**', '*')}`)}`
    : `-name ${shellQuote(pattern)}`;
  return `find ${shellQuote(cwd)} ${prunes} -type f ${matcher} -print 2>/dev/null | head -n ${options.limit}`;
}

export interface RemoteGrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

/** grep 工具参数 → 远端 rg/grep 脚本(engine 由能力探测决定) */
export function buildRemoteGrepScript(
  params: RemoteGrepParams,
  cwd: string,
  engine: 'rg' | 'grep'
): string {
  const target = shellQuote(
    params.path ? (params.path.startsWith('/') ? params.path : `${cwd}/${params.path}`) : cwd
  );
  const limit = params.limit ?? 100;
  const parts: string[] = [];
  if (engine === 'rg') {
    parts.push('rg -n --no-heading --color never');
    if (params.ignoreCase) parts.push('-i');
    if (params.literal) parts.push('-F');
    if (params.context !== undefined) parts.push(`-C ${Math.max(0, Math.floor(params.context))}`);
    if (params.glob) parts.push(`--glob ${shellQuote(params.glob)}`);
  } else {
    parts.push('grep -rn -I');
    if (params.ignoreCase) parts.push('-i');
    if (params.literal) parts.push('-F');
    else parts.push('-E');
    if (params.context !== undefined) parts.push(`-C ${Math.max(0, Math.floor(params.context))}`);
    if (params.glob) parts.push(`--include=${shellQuote(params.glob)}`);
    parts.push('--exclude-dir=node_modules --exclude-dir=.git');
  }
  parts.push('--', shellQuote(params.pattern), target);
  return `${parts.join(' ')} 2>/dev/null | head -n ${limit}`;
}

export interface RemoteOperations {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  ls: LsOperations;
  find: FindOperations;
  bash: BashOperations;
}

export function createRemoteOperations(executor: SshExecutor): RemoteOperations {
  const readFile = async (absolutePath: string): Promise<Buffer> => {
    const result = await executor.execRaw(['cat', '--', absolutePath]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `cannot read ${absolutePath}`);
    return result.stdout;
  };

  const writeFile = async (absolutePath: string, content: string): Promise<void> => {
    await mkdir(dirname(absolutePath));
    const result = await executor.exec(`cat > ${shellQuote(absolutePath)}`, {
      stdin: Buffer.from(content, 'utf8'),
    });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `cannot write ${absolutePath}`);
  };

  const mkdir = async (dir: string): Promise<void> => {
    const result = await executor.exec(['mkdir', '-p', '--', dir]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `cannot mkdir ${dir}`);
  };

  const accessRead = async (absolutePath: string): Promise<void> => {
    const result = await executor.exec(['test', '-r', absolutePath]);
    if (result.code !== 0) throw new Error(`${absolutePath} is not readable on remote host`);
  };

  const accessReadWrite = async (absolutePath: string): Promise<void> => {
    const result = await executor.exec(['test', '-r', absolutePath, '-a', '-w', absolutePath]);
    if (result.code !== 0) {
      throw new Error(`${absolutePath} is not readable/writable on remote host`);
    }
  };

  const exists = async (absolutePath: string): Promise<boolean> => {
    const result = await executor.exec(['test', '-e', absolutePath]);
    return result.code === 0;
  };

  return {
    read: {
      readFile,
      access: accessRead,
      detectImageMimeType: async (path) => detectImageMimeByExtension(path),
    },
    write: { writeFile, mkdir },
    edit: { readFile, writeFile, access: accessReadWrite },
    ls: {
      exists,
      stat: async (absolutePath) => {
        const result = await executor.exec(
          `if [ -d ${shellQuote(absolutePath)} ]; then echo d; elif [ -e ${shellQuote(absolutePath)} ]; then echo f; else exit 2; fi`
        );
        if (result.code !== 0) throw new Error(`${absolutePath} not found on remote host`);
        const isDir = result.stdout.trim() === 'd';
        return { isDirectory: () => isDir };
      },
      readdir: async (absolutePath) => {
        const result = await executor.exec(['ls', '-a', '--', absolutePath]);
        if (result.code !== 0) throw new Error(result.stderr.trim() || `cannot ls ${absolutePath}`);
        return result.stdout.split('\n').filter((e) => e && e !== '.' && e !== '..');
      },
    },
    find: {
      exists,
      glob: async (pattern, cwd, options) => {
        const result = await executor.exec(buildRemoteFindScript(pattern, cwd, options));
        return result.stdout.split('\n').filter(Boolean);
      },
    },
    bash: {
      exec: (command, cwd, options) =>
        executor.execStream(command, {
          onData: options.onData,
          signal: options.signal,
          // BashOperations 的 timeout 单位是秒(见 SDK resolveTimeoutMs)
          timeoutMs: options.timeout !== undefined ? options.timeout * 1000 : undefined,
          cwd,
        }),
    },
  };
}

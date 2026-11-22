import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FilesLinkResolution } from '@shared/types';
import { resolveUnderCwd } from './filesWorkspace';

/** 单批上限：renderer 按此分批，Main 超出部分直接丢弃 */
export const MAX_LINK_BATCH = 200;
const CONCURRENCY = 16;
const BATCH_TIMEOUT_MS = 500;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

async function resolveOne(
  root: string,
  realRoot: string,
  rel: unknown
): Promise<FilesLinkResolution | null> {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return null;
  const abs = resolveUnderCwd(root, rel);
  if (!abs) return null;
  try {
    const real = await realpath(abs);
    if (!inside(realRoot, real)) return null;
    const info = await stat(real);
    const kind = info.isFile() ? 'file' : info.isDirectory() ? 'dir' : null;
    if (!kind) return null;
    return { rel: path.relative(root, abs).split(path.sep).join('/'), kind };
  } catch {
    return null;
  }
}

/**
 * 聊天文件链接批量判定：只认工作区内真实存在的路径（软链接按 realpath 校验边界），
 * 不做文件名模糊匹配。并发受限，整批超时未完成的条目按打不开处理。
 */
export async function resolveWorkspaceLinks(
  cwd: string,
  rels: readonly unknown[],
  { timeoutMs = BATCH_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<(FilesLinkResolution | null)[]> {
  const items = rels.slice(0, MAX_LINK_BATCH);
  const results: (FilesLinkResolution | null)[] = items.map(() => null);
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    let realRoot: string;
    try {
      realRoot = await realpath(cwd);
    } catch {
      return;
    }
    let next = 0;
    const worker = async () => {
      while (next < items.length && Date.now() < deadline) {
        const index = next++;
        results[index] = await resolveOne(cwd, realRoot, items[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  })();
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
  });
  await Promise.race([work, expired]);
  clearTimeout(timer);
  // 超时后仍在跑的条目不再写回调用方拿到的结果
  return results.slice();
}

import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** 头像只允许这一个文件名。配置里记 imageVersion，不记路径。 */
export const SECRETARY_AVATAR_NAME = 'avatar.png';

/** 固定文件名落在秘书目录内；任何穿越都返回 null */
export function resolveSecretaryAvatarFile(dir: string): { root: string; file: string } | null {
  if (typeof dir !== 'string' || dir.length === 0) return null;
  const root = path.resolve(dir);
  const file = path.resolve(root, SECRETARY_AVATAR_NAME);
  if (path.relative(root, file) !== SECRETARY_AVATAR_NAME) return null;
  return { root, file };
}

function insideRoot(rootReal: string, fileReal: string): boolean {
  const rel = path.relative(rootReal, fileReal);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** 解析符号链接后仍在秘书目录里的普通文件；越界或悬空链接视为没有头像 */
export function readableSecretaryAvatar(dir: string): string | null {
  const located = resolveSecretaryAvatarFile(dir);
  if (!located) return null;
  let rootReal: string;
  try {
    rootReal = realpathSync(located.root);
    const stat = lstatSync(located.file);
    if (!stat.isFile() && !stat.isSymbolicLink()) return null;
    const real = realpathSync(located.file);
    return insideRoot(rootReal, real) ? real : null;
  } catch {
    return null;
  }
}

/** 写入用的路径。指向目录外的链接先拆掉，避免把字节写穿到外面。 */
export function prepareSecretaryAvatarWrite(dir: string): string | null {
  const located = resolveSecretaryAvatarFile(dir);
  if (!located) return null;
  try {
    if (lstatSync(located.file).isSymbolicLink() && !readableSecretaryAvatar(dir)) {
      unlinkSync(located.file);
    }
  } catch {
    // 还不存在
  }
  return located.file;
}

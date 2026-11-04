import { watch } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { USER_CSS_TEMPLATE } from '@shared/theme/userCssTemplate';

export const USER_CSS_FILE = 'user.css';
const MAX_USER_CSS_BYTES = 1024 * 1024;

/** 不存在、不是普通文件或过大都按没有处理 */
export async function readUserCss(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_USER_CSS_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export async function ensureUserCss(file: string): Promise<void> {
  try {
    await writeFile(file, USER_CSS_TEMPLATE, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** 监听所在目录而非文件本身：编辑器原子保存会换掉 inode，文件级 watch 随之失效 */
export function watchUserCss(dir: string, onChange: () => void, delayMs = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(dir, (_event, name) => {
    if (name && name !== USER_CSS_FILE) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, delayMs);
  });
  watcher.on('error', () => {});
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

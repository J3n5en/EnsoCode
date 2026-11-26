import { realpathSync } from 'node:fs';
import path from 'node:path';

function existingRealpath(target: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.reduceRight((dir, name) => path.join(dir, name), real);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function inside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 只允许会话 cwd 和附件目录。符号链接按 realpath 比较，越界为 false。 */
export function fsReadAllowed(target: string, roots: readonly string[]): boolean {
  if (!target || roots.length === 0) return false;
  const resolved = existingRealpath(target);
  return roots.some((root) => {
    try {
      return inside(resolved, realpathSync(root));
    } catch {
      return false;
    }
  });
}

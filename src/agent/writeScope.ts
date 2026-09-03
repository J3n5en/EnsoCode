import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** 极简 glob → RegExp：`**` 任意层级（含空）、`*` 段内任意、`?` 单字符；匹配整段 posix 相对路径 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** filePath 绝对或相对 cwd；越出 cwd 恒 false */
export function isPathInWriteScope(
  filePath: string,
  cwd: string,
  scope: readonly string[]
): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const rel = path.posix
    .relative(cwd.replace(/\\/g, '/'), path.posix.resolve(cwd.replace(/\\/g, '/'), normalized))
    .replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return false;
  return scope.some((glob) => globToRegExp(glob).test(rel));
}

/** 包装 edit/write 类工具：参数 path 不在范围内即拒绝；scope 缺省/为空原样返回 */
export function withWriteScope<T extends ToolDefinition>(
  def: T,
  cwd: string,
  scope: readonly string[] | undefined
): T {
  if (!scope || scope.length === 0) return def;
  return {
    ...def,
    execute: async (id, params, ...rest) => {
      const target = (params as { path?: unknown })?.path;
      if (typeof target === 'string' && !isPathInWriteScope(target, cwd, scope)) {
        throw new Error(
          `write scope: "${target}" is outside [${scope.join(', ')}] — this agent type may only write files matching those globs`
        );
      }
      return def.execute(id, params, ...rest);
    },
  } as T;
}

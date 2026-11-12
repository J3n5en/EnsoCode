import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { getApplyPatchPaths } from './applyPatch';
import { globToRegExp } from './globMatch';
import { expandPiToolPath } from './protectedActions';

export { globToRegExp } from './globMatch';

/** replace/write 走 path；带 input 的旧 Hashline 形状不再当写目标。 */
export function extractEditTargetPath(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const record = params as Record<string, unknown>;
  if (typeof record.input === 'string' && record.input.length > 0) return undefined;
  return typeof record.path === 'string' && record.path.length > 0 ? record.path : undefined;
}

/** 按工具协议提取全部真实写目标；apply_patch 必须优先走自身 parser。 */
export function extractWriteTargetPaths(toolName: string, params: unknown): string[] {
  if (toolName === 'apply_patch') return getApplyPatchPaths(params);
  const target = extractEditTargetPath(params);
  return target ? [target] : [];
}

/** filePath 绝对或相对 cwd，按字面解析（@/~ 由调用方按工具语义先展开）；越出 cwd 恒 false */
export function isPathInWriteScope(
  filePath: string,
  cwd: string,
  scope: readonly string[]
): boolean {
  // cwd 带盘符按 Windows 语义解析(盘符不同则 relative 给出绝对路径);否则反斜杠一律视为分隔符
  const win = /^[A-Za-z]:[\\/]/.test(cwd);
  const P = win ? path.win32 : path.posix;
  const target = win ? filePath : filePath.replace(/\\/g, '/');
  const rel = P.relative(cwd, P.resolve(cwd, target)).split(P.sep).join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || P.isAbsolute(rel)) return false;
  return scope.some((glob) => globToRegExp(glob).test(rel));
}

export function withWritePreflight<T extends ToolDefinition>(
  def: T,
  preflight: (params: unknown, signal: AbortSignal | undefined) => Promise<unknown>
): T {
  return {
    ...def,
    execute: async (id, params, signal, ...rest) => {
      await preflight(params, signal);
      return def.execute(id, params, signal, ...rest);
    },
  } as T;
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
      const targets = extractWriteTargetPaths(def.name, params);
      if (targets.length === 0) {
        throw new Error('write scope: cannot determine a valid target path');
      }
      for (const target of targets) {
        // edit/write 经 pi 的 resolveToCwd 落盘（去 @、展开 ~ 等），要按同一规则判定，
        // 否则 ~/x、@../x 会被当成 cwd 内路径；apply_patch 自己按字面解析，不能套这层
        const resolved = def.name === 'apply_patch' ? target : expandPiToolPath(target);
        if (!isPathInWriteScope(resolved, cwd, scope)) {
          throw new Error(
            `write scope: "${target}" is outside [${scope.join(', ')}] — this agent type may only write files matching those globs`
          );
        }
      }
      return def.execute(id, params, ...rest);
    },
  } as T;
}

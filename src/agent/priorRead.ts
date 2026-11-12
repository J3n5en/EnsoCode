import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/**
 * 改前须读（借鉴 qwen-code priorReadEnforcement / Claude Code readFileState）：
 * write 覆盖已存在文件前，本会话必须读过它且磁盘未在读后变动；挡住模型凭记忆整文件盲写。
 * edit / apply_patch 靠原文匹配天然防陈旧，不拦，只在成功后刷新记录。
 * 按 realpath 建键，相对 / 绝对 / @ 前缀 / 软链接都归到同一文件；任何读取都算数（大文件不可能全读）。
 */
export class ReadLedger {
  private readonly seen = new Map<string, { mtimeMs: number; size: number }>();

  constructor(private readonly cwd: string) {}

  private resolve(filePath: string, cwd = this.cwd): string {
    let p = filePath.trim().replace(/^@/, '');
    if (p === '~' || p.startsWith('~/')) p = path.join(homedir(), p.slice(1));
    return path.resolve(cwd, p);
  }

  async record(filePath: string, cwd?: string): Promise<void> {
    try {
      const real = await realpath(this.resolve(filePath, cwd));
      const st = await stat(real);
      if (st.isFile()) this.seen.set(real, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // 记录是 best-effort：路径不可解析时不影响工具结果
    }
  }

  /** 返回拒绝理由；放行返回 undefined。不存在、非普通文件或 stat 失败交给写工具自己报错 */
  async check(filePath: string, cwd?: string): Promise<string | undefined> {
    let real: string;
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      real = await realpath(this.resolve(filePath, cwd));
      st = await stat(real);
    } catch {
      return undefined;
    }
    if (!st.isFile()) return undefined;
    const prior = this.seen.get(real);
    if (!prior)
      return (
        `File ${filePath} already exists and has not been read in this session. ` +
        'Read it first before overwriting it with write, or use edit for targeted changes.'
      );
    if (prior.mtimeMs !== st.mtimeMs || prior.size !== st.size)
      return (
        `File ${filePath} has changed on disk since you last read it. ` +
        'Read it again before overwriting it with write.'
      );
    return undefined;
  }
}

type Ctx = { cwd?: string } | undefined;

/** 工具成功后记录目标路径（读过 / 自己写过都算见过当前内容）；相对路径按工具实际 cwd 解析 */
export function withPathRecord<T extends ToolDefinition>(
  def: T,
  ledger: ReadLedger,
  paths: (params: unknown) => string[]
): T {
  return {
    ...def,
    execute: async (id, params, signal, onUpdate, ctx) => {
      const result = await def.execute(id, params, signal, onUpdate, ctx);
      const cwd = (ctx as Ctx)?.cwd;
      await Promise.all(paths(params).map((p) => ledger.record(p, cwd)));
      return result;
    },
  } as T;
}

/** 覆盖前检查：未读或读后变动即拒（在审批之前，不打扰用户） */
export function withPriorRead<T extends ToolDefinition>(
  def: T,
  ledger: ReadLedger,
  paths: (params: unknown) => string[]
): T {
  return {
    ...def,
    execute: async (id, params, signal, onUpdate, ctx) => {
      const cwd = (ctx as Ctx)?.cwd;
      for (const p of paths(params)) {
        const reason = await ledger.check(p, cwd);
        if (reason) throw new Error(reason);
      }
      return def.execute(id, params, signal, onUpdate, ctx);
    },
  } as T;
}

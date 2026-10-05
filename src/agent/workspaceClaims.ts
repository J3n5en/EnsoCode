import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { programTokens } from './protectedActions';
import { extractWriteTargetPaths } from './writeScope';

/**
 * Bot 成员同一工作区的写协调（同一 worker 进程内）：
 * 写工具按文件占用到本轮结束；影响整个仓库的命令只在执行期间独占工作区。
 * 委派链上的祖先与子会话互不阻塞（父轮在等子结果）。
 */
export interface ClaimOwner {
  id: string;
  label: string;
  ancestors: readonly string[];
}

interface Blocker {
  owner: string;
  file?: string;
}

export interface ClaimWaitOptions {
  signal?: AbortSignal;
  onWait?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 2 * 60_000;

/** 不存在的文件按已存在的最近祖先目录取真实路径，再拼回剩余段 */
function canonical(target: string): string {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export class WorkspaceClaims {
  private readonly owners = new Map<string, ClaimOwner>();
  /** 真实文件路径 → 占用者与所属工作区 */
  private readonly files = new Map<string, { owner: string; root: string }>();
  /** 工作区 → 正在执行全局命令的会话（同一会话可重入） */
  private readonly exclusive = new Map<string, { owner: string; depth: number }>();
  private readonly waiters = new Set<() => void>();
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  register(owner: ClaimOwner): void {
    this.owners.set(owner.id, owner);
  }

  /** 释放该会话本轮的全部文件占用 */
  release(owner: string): void {
    let changed = false;
    for (const [file, holder] of this.files)
      if (holder.owner === owner) {
        this.files.delete(file);
        changed = true;
      }
    if (changed) this.wake();
  }

  forget(owner: string): void {
    this.release(owner);
    this.owners.delete(owner);
  }

  async claimFiles(
    owner: string,
    cwd: string,
    targets: readonly string[],
    options: ClaimWaitOptions = {}
  ): Promise<void> {
    const root = canonical(cwd);
    const files = targets.map((target) => canonical(path.resolve(cwd, target)));
    await this.waitFor(root, options, () => {
      const ex = this.exclusive.get(root);
      if (ex && !this.related(owner, ex.owner)) return { owner: ex.owner };
      for (const file of files) {
        const holder = this.files.get(file);
        if (holder && !this.related(owner, holder.owner)) return { owner: holder.owner, file };
      }
      return undefined;
    });
    for (const file of files) if (!this.files.has(file)) this.files.set(file, { owner, root });
  }

  async runExclusive<T>(
    owner: string,
    cwd: string,
    task: () => Promise<T>,
    options: ClaimWaitOptions = {}
  ): Promise<T> {
    const root = canonical(cwd);
    await this.waitFor(root, options, () => {
      const ex = this.exclusive.get(root);
      if (ex && !this.related(owner, ex.owner)) return { owner: ex.owner };
      for (const [file, holder] of this.files)
        if (holder.root === root && !this.related(owner, holder.owner))
          return { owner: holder.owner, file };
      return undefined;
    });
    const held = this.exclusive.get(root);
    if (held) held.depth += 1;
    else this.exclusive.set(root, { owner, depth: 1 });
    try {
      return await task();
    } finally {
      const current = this.exclusive.get(root);
      if (current && current.depth > 1) current.depth -= 1;
      else this.exclusive.delete(root);
      this.wake();
    }
  }

  private related(a: string, b: string): boolean {
    return (
      a === b ||
      (this.owners.get(a)?.ancestors.includes(b) ?? false) ||
      (this.owners.get(b)?.ancestors.includes(a) ?? false)
    );
  }

  private describe(blocker: Blocker, root: string): string {
    const name = this.owners.get(blocker.owner)?.label ?? 'another member';
    if (!blocker.file)
      return `${name} is running a workspace-wide command (git / install / rm -r) in this workspace`;
    const rel = path.relative(root, blocker.file) || blocker.file;
    return `"${rel.split(path.sep).join('/')}" is being edited by ${name} (released when their turn ends)`;
  }

  private async waitFor(
    root: string,
    { signal, onWait }: ClaimWaitOptions,
    check: () => Blocker | undefined
  ): Promise<void> {
    let blocker = check();
    if (!blocker) return;
    onWait?.(`Waiting: ${this.describe(blocker, root)}.`);
    const deadline = Date.now() + this.timeoutMs;
    while (blocker) {
      if (signal?.aborted) throw new Error('Aborted while waiting for workspace.');
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          `Workspace busy: ${this.describe(blocker, root)}. Work on other files first or coordinate with them, then retry.`
        );
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        this.waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
      blocker = check();
    }
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

const GIT_WIDE = new Set([
  'commit',
  'checkout',
  'switch',
  'reset',
  'rebase',
  'merge',
  'pull',
  'stash',
  'cherry-pick',
  'revert',
  'restore',
  'clean',
  'am',
  'apply',
  'mv',
  'rm',
]);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_WIDE = new Set([
  'install',
  'i',
  'ci',
  'add',
  'remove',
  'rm',
  'uninstall',
  'un',
  'update',
  'up',
  'upgrade',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);

function segmentIsWide(segment: string, depth: number): boolean {
  const tokens = programTokens(segment);
  if (tokens.length === 0) return false;
  const program = path.posix.basename(tokens[0]);
  const args = tokens.slice(1);
  if (SHELLS.has(program)) {
    const c = args.indexOf('-c');
    return c !== -1 && depth < 3 && commandIsWide(args.slice(c + 1).join(' '), depth + 1);
  }
  if (program === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-'))
      i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
    return GIT_WIDE.has(args[i] ?? '');
  }
  if (PACKAGE_MANAGERS.has(program)) {
    const sub = args.find((t) => !t.startsWith('-'));
    return sub === undefined ? program === 'yarn' : PACKAGE_WIDE.has(sub);
  }
  if (program === 'rm') return args.some((t) => /^-[A-Za-z]*[rR]/.test(t) || t === '--recursive');
  return false;
}

function commandIsWide(command: string, depth: number): boolean {
  return command.split(/\|\|?|&&?|;|\n|\$\(|`|\)/).some((s) => segmentIsWide(s, depth));
}

/** 影响整个仓库状态的命令：执行期间独占工作区 */
export function isWorkspaceWideCommand(command: string): boolean {
  return commandIsWide(command, 0);
}

interface ClaimContext {
  owner: string;
  cwd: string;
}

type UpdateFn =
  | ((partial: { content: { type: 'text'; text: string }[]; details: unknown }) => void)
  | undefined;

const notifier = (onUpdate: unknown) => (message: string) =>
  (onUpdate as UpdateFn)?.({ content: [{ type: 'text', text: message }], details: undefined });

export function withFileClaims<T extends ToolDefinition>(
  def: T,
  claims: WorkspaceClaims,
  context: ClaimContext
): T {
  return {
    ...def,
    execute: async (id, params, signal, onUpdate, ctx) => {
      const targets = extractWriteTargetPaths(def.name, params);
      if (targets.length > 0)
        await claims.claimFiles(context.owner, context.cwd, targets, {
          signal,
          onWait: notifier(onUpdate),
        });
      return def.execute(id, params, signal, onUpdate, ctx);
    },
  } as T;
}

export function withExclusiveCommand<T extends ToolDefinition>(
  def: T,
  claims: WorkspaceClaims,
  context: ClaimContext
): T {
  return {
    ...def,
    execute: async (id, params, signal, onUpdate, ctx) => {
      const command =
        params && typeof params === 'object' && 'command' in params ? params.command : undefined;
      if (typeof command !== 'string' || !isWorkspaceWideCommand(command))
        return def.execute(id, params, signal, onUpdate, ctx);
      return claims.runExclusive(
        context.owner,
        context.cwd,
        () => def.execute(id, params, signal, onUpdate, ctx),
        { signal, onWait: notifier(onUpdate) }
      );
    },
  } as T;
}

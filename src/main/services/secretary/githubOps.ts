/**
 * 秘书的两个轻量 GitHub 写操作：合并 PR 与删除远端分支。
 *
 * 硬边界：
 * - 合并只允许 squash，永不带 --admin，也不接受任意 gh 参数：分支保护挡不住的操作不存在。
 * - 删分支只删远端（git push origin --delete），保护名单（main、feat/signpath-windows）
 *   与任何有 open PR 的 head 分支一律拒绝。
 * - 命令全部按参数数组执行（execFile），不经过 shell；分支名与 owner/repo 先按字符集收窄。
 *
 * repo 归属：owner/repo 必须与某个可见本机项目的 git origin 一致（项目 origin 是权威），
 * 所以误传别的仓库会被拒绝；省略 repo 时全部可见项目只解析出一个 GitHub 仓库才作数。
 */
import { execFile } from 'node:child_process';
import { parseProfile } from '@shared/secretary/parse';
import type { ProjectAuthority } from '@shared/types/agent';
import type { SecretaryAuditEntry, SecretaryProfile } from '@shared/types/secretary';
import { appendAudit } from './audit';
import { visibleProjects } from './readers';
import { runGit } from './repoStatus';
import type { SecretaryContext } from './secretaries';
import { SecretaryStore } from './store';
import type { SecretaryOpContext, SecretaryOpHandler, SecretaryOpResult } from './tools';

const GH_TIMEOUT_MS = 15_000;

/** 用户点名不动的分支（#296）与主分支；任何用途都不删 */
export const PROTECTED_BRANCHES: readonly string[] = ['main', 'feat/signpath-windows'];

export interface GithubOpsCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type MaybePromise<T> = T | Promise<T>;

/** Main 侧的外部依赖；测试注入假实现，生产走下面的 githubOpsPortsFor */
export interface GithubOpsPorts {
  /** gh 不可用、超时或起不来返回 null。参数是数组，不经过 shell。 */
  gh(args: readonly string[]): Promise<GithubOpsCommandResult | null>;
  /** git 子命令（remote get-url / ls-remote / push），cwd 是项目检出目录 */
  git(cwd: string, args: readonly string[]): Promise<GithubOpsCommandResult>;
  projects(): MaybePromise<readonly ProjectAuthority[]>;
  profile(): MaybePromise<SecretaryProfile | null>;
  audit(entry: SecretaryAuditEntry): void;
  now(): number;
}

export function runGhOps(args: readonly string[]): Promise<GithubOpsCommandResult | null> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      [...args],
      { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string') {
          resolve(null);
          return;
        }
        resolve({
          code: typeof code === 'number' ? code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      }
    );
  });
}

const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/u;

/** git remote URL → owner/repo；不是 GitHub 远程返回 undefined */
export function parseGithubRepo(url: string): string | undefined {
  const text = url.trim();
  const match =
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(text) ??
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(text) ??
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text);
  if (!match) return undefined;
  const repo = `${match[1]}/${match[2]}`;
  return REPO_SLUG.test(repo) ? repo : undefined;
}

function validRepoSlug(value: string): string | null {
  const trimmed = value.trim();
  return REPO_SLUG.test(trimmed) ? trimmed : null;
}

function defaultProfile(): SecretaryProfile {
  const parsed = parseProfile({});
  if (!parsed) throw new Error('secretary default profile');
  return parsed;
}

export interface GithubRepoScope {
  repo: string;
  /** 解析命中的项目检出目录：git push 在这里跑，凭据与 remote 由它权威提供 */
  cwd: string;
  projectId: string;
}

/**
 * 把请求的 owner/repo 收窄到一个可见本机项目：
 * - projectId 给了就只查它；
 * - repo 字符串必须命中唯一一个项目的 origin；
 * - 都不给时全部可见项目解析出唯一一个 GitHub 仓库才放行，多个或零个都要秘书明说。
 */
export async function resolveGithubScope(
  ports: GithubOpsPorts,
  input: { repo?: string; projectId?: string }
): Promise<{ ok: true; scope: GithubRepoScope } | { ok: false; error: string }> {
  const projects = visibleProjects(
    await ports.projects(),
    (await ports.profile()) ?? defaultProfile()
  ).filter((project) => project.kind !== 'ssh');
  const origins: Array<{ projectId: string; cwd: string; repo: string }> = [];
  for (const project of projects) {
    if (input.projectId && project.projectId !== input.projectId) continue;
    const remote = await ports.git(project.canonicalPath, ['remote', 'get-url', 'origin']);
    if (remote.code !== 0) continue;
    const repo = parseGithubRepo(remote.stdout);
    if (repo) origins.push({ projectId: project.projectId, cwd: project.canonicalPath, repo });
  }
  if (input.projectId && origins.length === 0) {
    const known = projects.some((project) => project.projectId === input.projectId);
    return { ok: false, error: known ? 'no-github-origin' : 'not-found' };
  }
  if (!input.repo) {
    const distinct = new Set(origins.map((origin) => origin.repo.toLowerCase()));
    if (distinct.size === 1) {
      const hit = origins[0];
      return { ok: true, scope: { repo: hit.repo, cwd: hit.cwd, projectId: hit.projectId } };
    }
    return { ok: false, error: 'repo-required' };
  }
  const requested = validRepoSlug(input.repo);
  if (!requested) return { ok: false, error: 'invalid-repo' };
  const matches = origins.filter((origin) => origin.repo.toLowerCase() === requested.toLowerCase());
  if (matches.length === 0) return { ok: false, error: 'repo-not-visible-project-origin' };
  const hit = matches[0];
  return { ok: true, scope: { repo: hit.repo, cwd: hit.cwd, projectId: hit.projectId } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** gh pr view 的 JSON 输出里秘书真正用得上的三个字段 */
export interface PrView {
  state: string | null;
  mergeStateStatus: string | null;
  autoMergeRequested: boolean | null;
}

export function parsePrView(stdout: string): PrView | null {
  const body = parseJson(stdout);
  if (!isRecord(body)) return null;
  const auto = body.autoMergeRequest;
  return {
    state: typeof body.state === 'string' ? body.state.toUpperCase() : null,
    mergeStateStatus:
      typeof body.mergeStateStatus === 'string' ? body.mergeStateStatus.toUpperCase() : null,
    autoMergeRequested: isRecord(auto) ? true : auto === null ? false : null,
  };
}

function prNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function safeBranch(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    !/^[A-Za-z0-9._/-]{1,200}$/u.test(trimmed) ||
    trimmed.startsWith('-') ||
    trimmed.includes('..')
  )
    return null;
  return trimmed;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cliDetail(result: GithubOpsCommandResult): string {
  const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
  return detail.slice(0, 300) || `exit-${result.code}`;
}

const invalidArguments: SecretaryOpResult = { ok: false, error: 'invalid arguments' };

function auditEntry(
  ports: GithubOpsPorts,
  ctx: SecretaryOpContext,
  op: string,
  targetId: string | undefined,
  ok: boolean,
  detail?: string
): void {
  ports.audit({
    at: ports.now(),
    secretaryConversationId: ctx.secretaryConversationId,
    op,
    ...(targetId ? { targetId } : {}),
    ok,
    ...(detail ? { detail } : {}),
  });
}

async function mergePullRequest(
  ports: GithubOpsPorts,
  params: Record<string, unknown>,
  ctx: SecretaryOpContext
): Promise<SecretaryOpResult> {
  const number = prNumber(params.number);
  const repoInput = stringParam(params, 'repo');
  const projectId = stringParam(params, 'projectId');
  const auto = params.auto !== false;
  if (!number) return invalidArguments;
  if (params.method !== undefined && params.method !== 'squash') {
    return { ok: false, error: 'invalid arguments: only squash is allowed' };
  }
  const targetId = `${repoInput ?? projectId ?? '?'}#${number}`;

  const resolved = await resolveGithubScope(ports, {
    ...(repoInput ? { repo: repoInput } : {}),
    ...(projectId ? { projectId } : {}),
  });
  if (!resolved.ok) {
    auditEntry(ports, ctx, 'github_merge_pr', targetId, false, resolved.error);
    return { ok: false, error: resolved.error };
  }
  const { repo } = resolved.scope;
  const target = `${repo}#${number}`;

  const viewArgs = [
    'pr',
    'view',
    String(number),
    '--repo',
    repo,
    '--json',
    'number,state,mergeStateStatus,autoMergeRequest',
  ];
  const viewed = await ports.gh(viewArgs);
  if (!viewed) {
    auditEntry(ports, ctx, 'github_merge_pr', target, false, 'gh-unavailable');
    return { ok: false, error: 'gh-unavailable' };
  }
  if (viewed.code !== 0) {
    const detail = cliDetail(viewed);
    auditEntry(ports, ctx, 'github_merge_pr', target, false, detail);
    return { ok: false, error: detail };
  }
  const before = parsePrView(viewed.stdout);
  if (!before) {
    auditEntry(ports, ctx, 'github_merge_pr', target, false, 'gh-output-unparseable');
    return { ok: false, error: 'gh-output-unparseable' };
  }
  if (before.state !== 'OPEN') {
    const detail = `pr-not-open:${(before.state ?? 'unknown').toLowerCase()}`;
    auditEntry(ports, ctx, 'github_merge_pr', target, false, detail);
    return { ok: false, error: detail };
  }

  // 只有 squash 一条路：永不出现 merge / rebase / --admin，分支保护挡不住的操作不存在
  const mergeArgs = ['pr', 'merge', String(number), '--repo', repo, '--squash', '--delete-branch'];
  if (auto) mergeArgs.push('--auto');
  const merged = await ports.gh(mergeArgs);
  if (!merged) {
    auditEntry(ports, ctx, 'github_merge_pr', target, false, 'gh-unavailable');
    return { ok: false, error: 'gh-unavailable' };
  }
  if (merged.code !== 0) {
    const detail = cliDetail(merged);
    auditEntry(ports, ctx, 'github_merge_pr', target, false, detail);
    return { ok: false, error: detail };
  }

  const afterView = await ports.gh(viewArgs);
  const after = afterView && afterView.code === 0 ? parsePrView(afterView.stdout) : null;
  auditEntry(ports, ctx, 'github_merge_pr', target, true, `auto=${auto}`);
  return {
    ok: true,
    result: {
      repo,
      number,
      method: 'squash',
      auto,
      stateBefore: before.state,
      mergeStateStatusBefore: before.mergeStateStatus,
      ...(after
        ? {
            stateAfter: after.state,
            mergeStateStatusAfter: after.mergeStateStatus,
            autoMergeRequested: after.autoMergeRequested,
          }
        : {}),
    },
  };
}

async function deleteRemoteBranch(
  ports: GithubOpsPorts,
  params: Record<string, unknown>,
  ctx: SecretaryOpContext
): Promise<SecretaryOpResult> {
  const branch = safeBranch(params.branch);
  const repoInput = stringParam(params, 'repo');
  const projectId = stringParam(params, 'projectId');
  if (!branch) return invalidArguments;
  const targetId = `${repoInput ?? projectId ?? '?'}:${branch}`;

  if (PROTECTED_BRANCHES.includes(branch)) {
    auditEntry(ports, ctx, 'github_delete_branch', targetId, false, 'protected-branch');
    return { ok: false, error: `protected-branch: ${branch}` };
  }

  const resolved = await resolveGithubScope(ports, {
    ...(repoInput ? { repo: repoInput } : {}),
    ...(projectId ? { projectId } : {}),
  });
  if (!resolved.ok) {
    auditEntry(ports, ctx, 'github_delete_branch', targetId, false, resolved.error);
    return { ok: false, error: resolved.error };
  }
  const { repo, cwd } = resolved.scope;
  const target = `${repo}:${branch}`;

  // 远端根本没这个分支时直接报，别假装删掉了
  const remoteRef = await ports.git(cwd, ['ls-remote', '--heads', 'origin', branch]);
  if (remoteRef.code !== 0) {
    const detail = cliDetail(remoteRef);
    auditEntry(ports, ctx, 'github_delete_branch', target, false, detail);
    return { ok: false, error: detail };
  }
  if (!remoteRef.stdout.trim()) {
    auditEntry(ports, ctx, 'github_delete_branch', target, false, 'branch-not-on-remote');
    return { ok: false, error: 'branch-not-on-remote' };
  }

  // 有 open PR 以它为 head 的分支拒绝删除：删了等于替别人关 PR
  const listed = await ports.gh([
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  if (!listed) {
    auditEntry(ports, ctx, 'github_delete_branch', target, false, 'gh-unavailable');
    return { ok: false, error: 'gh-unavailable' };
  }
  if (listed.code !== 0) {
    const detail = cliDetail(listed);
    auditEntry(ports, ctx, 'github_delete_branch', target, false, detail);
    return { ok: false, error: detail };
  }
  const openPrs = (() => {
    const body = parseJson(listed.stdout);
    if (!Array.isArray(body)) return null;
    return body
      .map((entry) => (isRecord(entry) && typeof entry.number === 'number' ? entry.number : null))
      .filter((value): value is number => value !== null);
  })();
  if (openPrs === null) {
    auditEntry(ports, ctx, 'github_delete_branch', target, false, 'gh-output-unparseable');
    return { ok: false, error: 'gh-output-unparseable' };
  }
  if (openPrs.length > 0) {
    const detail = `has-open-pr:${openPrs.join(',')}`;
    auditEntry(ports, ctx, 'github_delete_branch', target, false, detail);
    return { ok: false, error: detail };
  }

  // 只删远端：本地分支（如果有）不在本次范围内
  const pushed = await ports.git(cwd, ['push', 'origin', '--delete', branch]);
  if (pushed.code !== 0) {
    const detail = cliDetail(pushed);
    auditEntry(ports, ctx, 'github_delete_branch', target, false, detail);
    return { ok: false, error: detail };
  }
  auditEntry(ports, ctx, 'github_delete_branch', target, true);
  return { ok: true, result: { repo, branch, deleted: 'remote' } };
}

export type SecretaryGithubOpsHandlers = Record<
  'github_merge_pr' | 'github_delete_branch',
  SecretaryOpHandler
>;

export function createSecretaryGithubOpsHandlers(
  ports: GithubOpsPorts
): SecretaryGithubOpsHandlers {
  return {
    github_merge_pr: (params, ctx) => mergePullRequest(ports, params, ctx),
    github_delete_branch: (params, ctx) => deleteRemoteBranch(ports, params, ctx),
  };
}

export function githubOpsPortsFor(
  ctx: SecretaryContext,
  profile?: () => SecretaryProfile | null
): GithubOpsPorts {
  return {
    gh: runGhOps,
    git: (cwd, args) => runGit(cwd, args),
    projects: async () => {
      // 与 readers 同样的惰性 import：权威注册表在测试里可以不存在
      const registry = (await import('../../ipc/agent')).getSourceAuthorityRegistry();
      return registry?.projection().projects ?? [];
    },
    profile: () => profile?.() ?? new SecretaryStore(ctx.dir).profile(),
    audit: (entry) => appendAudit(ctx.dir, entry),
    now: () => Date.now(),
  };
}

export function githubOpsHandlersFor(
  ctx: SecretaryContext,
  profile?: () => SecretaryProfile | null
): SecretaryGithubOpsHandlers {
  return createSecretaryGithubOpsHandlers(githubOpsPortsFor(ctx, profile));
}

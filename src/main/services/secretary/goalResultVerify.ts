import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { GoalResult, GoalResultCheck } from '@shared/secretary/goalResult';
import { runGit } from './repoStatus';

const COMMAND_MS = 5_000;

function runGh(args: readonly string[]): Promise<GoalResultCommandResult | null> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      [...args],
      { encoding: 'utf8', timeout: COMMAND_MS, maxBuffer: 1024 * 1024, windowsHide: true },
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

async function readImageHead(file: string): Promise<Uint8Array | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function dispatchedCwd(conversationId: string): Promise<string | null> {
  const { sessionWorktree } = await import('../../ipc/worktree');
  const { agentSessionIndex } = await import('../../ipc/sessionIndex');
  const { getSourceAuthorityRegistry } = await import('../../ipc/agent');
  const worktree = sessionWorktree(agentSessionIndex.workspaceRoot(conversationId));
  if (worktree && existsSync(worktree.path)) return worktree.path;
  const registry = getSourceAuthorityRegistry();
  const projectId = registry?.conversation(conversationId)?.projectId;
  const project = projectId ? registry?.project(projectId) : undefined;
  return project && (project.kind ?? 'local') === 'local' && existsSync(project.canonicalPath)
    ? project.canonicalPath
    : null;
}

/** 生产核验：工作目录只认会话自己的 worktree 或项目根，不信 result.worktree.path。 */
export async function verifyDispatchedGoalResult(
  conversationId: string,
  result: GoalResult
): Promise<GoalResultCheck[]> {
  const cwd = await dispatchedCwd(conversationId);
  return verifyGoalResult(result, {
    cwd: cwd ?? '/',
    git: (dir, args) => (cwd ? runGit(dir, args) : Promise.resolve(null)),
    gh: runGh,
    readHead: readImageHead,
  });
}

export interface GoalResultCommandResult {
  code: number;
  stdout: string;
  stderr?: string;
}

export interface GoalResultVerifyDeps {
  cwd: string;
  /** 不可用、超时或起不来返回 null。参数是数组，不经过 shell。 */
  git(cwd: string, args: readonly string[]): Promise<GoalResultCommandResult | null>;
  gh(args: readonly string[]): Promise<GoalResultCommandResult | null>;
  /** 文件不存在返回 null。只读文件头。 */
  readHead(path: string): Promise<Uint8Array | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function within<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), COMMAND_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function prState(value: unknown): 'merged' | 'open' | 'closed' | undefined {
  if (typeof value !== 'string') return undefined;
  const state = value.toLowerCase();
  if (state === 'merged' || state === 'open' || state === 'closed') return state;
  return undefined;
}

function githubRepo(url: string): string | undefined {
  const text = url.trim();
  const match =
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(text) ??
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(text) ??
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function isImage(bytes: Uint8Array): boolean {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return true;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return true;
  }
  if (bytes.length < 12) return false;
  const riff = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  const webp = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
  return riff === 'RIFF' && webp === 'WEBP';
}

function unverifiable(kind: GoalResultCheck['kind'], ref: string): GoalResultCheck {
  return { kind, ref, status: 'unverifiable' };
}

export async function verifyGoalResult(
  result: GoalResult,
  deps: GoalResultVerifyDeps
): Promise<GoalResultCheck[]> {
  const git = (args: readonly string[]) => within(deps.git(deps.cwd, args), null);
  const gh = (args: readonly string[]) => within(deps.gh(args), null);
  const groups = await Promise.all([
    ...(result.prs ?? []).map((pr) => verifyPull(pr, gh)),
    ...(result.commits ?? []).map((sha) => verifyCommit(sha, git, gh)),
    ...(result.screenshots ?? []).map((shot) => verifyShot(shot.path, deps)),
    ...(result.checks?.ci?.runId && result.checks.ci.repo
      ? [verifyCi(result.checks.ci.runId, result.checks.ci.repo, result.checks.ci.conclusion, gh)]
      : []),
  ]);
  return groups.flat();
}

/** 截止时还没核完的项：只列本来会去核的字段。 */
export function unverifiableGoalChecks(result: GoalResult, detail: string): GoalResultCheck[] {
  const checks: GoalResultCheck[] = [];
  for (const pr of result.prs ?? []) {
    const ref = `${pr.repo}#${pr.number}`;
    if (pr.state) checks.push({ kind: 'pr-state', ref, status: 'unverifiable', detail });
    if (pr.squashSha) checks.push({ kind: 'pr-squash', ref, status: 'unverifiable', detail });
    if (pr.remoteBranchDeleted !== undefined) {
      checks.push({ kind: 'pr-branch', ref, status: 'unverifiable', detail });
    }
  }
  for (const sha of result.commits ?? []) {
    checks.push({ kind: 'commit', ref: sha, status: 'unverifiable', detail });
  }
  for (const shot of result.screenshots ?? []) {
    checks.push({ kind: 'screenshot', ref: shot.path, status: 'unverifiable', detail });
  }
  const ci = result.checks?.ci;
  if (ci?.runId && ci.repo) {
    checks.push({ kind: 'ci', ref: String(ci.runId), status: 'unverifiable', detail });
  }
  return checks;
}

async function verifyPull(
  pr: NonNullable<GoalResult['prs']>[number],
  gh: (args: readonly string[]) => Promise<GoalResultCommandResult | null>
): Promise<GoalResultCheck[]> {
  const ref = `${pr.repo}#${pr.number}`;
  const claimed: GoalResultCheck['kind'][] = [];
  if (pr.state) claimed.push('pr-state');
  if (pr.squashSha) claimed.push('pr-squash');
  if (pr.remoteBranchDeleted !== undefined) claimed.push('pr-branch');
  if (claimed.length === 0) return [];
  const view = await gh([
    'pr',
    'view',
    String(pr.number),
    '--repo',
    pr.repo,
    '--json',
    'state,mergeCommit,headRefName,isCrossRepository',
  ]);
  const body = view?.code === 0 ? parseJson(view.stdout) : undefined;
  if (!isRecord(body)) return claimed.map((kind) => unverifiable(kind, ref));
  const checks: GoalResultCheck[] = [];
  if (pr.state) {
    const actual = prState(body.state);
    checks.push(
      actual === pr.state
        ? { kind: 'pr-state', ref, status: 'verified' }
        : {
            kind: 'pr-state',
            ref,
            status: actual ? 'mismatch' : 'unverifiable',
            ...(actual ? { detail: actual } : {}),
          }
    );
  }
  if (pr.squashSha) {
    const oid =
      isRecord(body.mergeCommit) && typeof body.mergeCommit.oid === 'string'
        ? body.mergeCommit.oid.toLowerCase()
        : '';
    checks.push(
      oid.startsWith(pr.squashSha)
        ? { kind: 'pr-squash', ref, status: 'verified' }
        : {
            kind: 'pr-squash',
            ref,
            status: 'mismatch',
            ...(oid ? { detail: oid.slice(0, 7) } : {}),
          }
    );
  }
  if (pr.remoteBranchDeleted !== undefined) {
    checks.push(await verifyBranch(pr, ref, body, gh));
  }
  return checks;
}

async function verifyBranch(
  pr: NonNullable<GoalResult['prs']>[number],
  ref: string,
  body: Record<string, unknown>,
  gh: (args: readonly string[]) => Promise<GoalResultCommandResult | null>
): Promise<GoalResultCheck> {
  if (body.isCrossRepository === true) return unverifiable('pr-branch', ref);
  if (typeof body.headRefName !== 'string' || !body.headRefName)
    return unverifiable('pr-branch', ref);
  const looked = await gh([
    'api',
    `repos/${pr.repo}/branches/${encodeURIComponent(body.headRefName)}`,
  ]);
  if (!looked) return unverifiable('pr-branch', ref);
  const deleted = looked.code === 404 || /\b404\b/.test(looked.stderr ?? '');
  const present = looked.code === 0;
  if (!deleted && !present) return unverifiable('pr-branch', ref);
  const gone = pr.remoteBranchDeleted === true;
  if (gone === deleted) return { kind: 'pr-branch', ref, status: 'verified' };
  return { kind: 'pr-branch', ref, status: 'mismatch', detail: deleted ? 'deleted' : 'exists' };
}

async function verifyCommit(
  sha: string,
  git: (args: readonly string[]) => Promise<GoalResultCommandResult | null>,
  gh: (args: readonly string[]) => Promise<GoalResultCommandResult | null>
): Promise<GoalResultCheck[]> {
  const onMain = async (rev: string) => {
    const result = await git(['merge-base', '--is-ancestor', sha, rev]);
    return result?.code === 0;
  };
  if ((await onMain('refs/remotes/origin/main')) || (await onMain('refs/heads/main'))) {
    return [{ kind: 'commit', ref: sha, status: 'verified' }];
  }
  const remote = await git(['remote', 'get-url', 'origin']);
  const repo = remote?.code === 0 ? githubRepo(remote.stdout) : undefined;
  if (!repo) return [unverifiable('commit', sha)];
  const compared = await gh(['api', `repos/${repo}/compare/${sha}...main`, '--jq', '.status']);
  const status = compared?.code === 0 ? compared.stdout.trim() : '';
  if (status === 'ahead' || status === 'identical') {
    return [{ kind: 'commit', ref: sha, status: 'verified' }];
  }
  if (status === 'behind' || status === 'diverged') {
    return [{ kind: 'commit', ref: sha, status: 'mismatch', detail: status }];
  }
  return [unverifiable('commit', sha)];
}

async function verifyShot(path: string, deps: GoalResultVerifyDeps): Promise<GoalResultCheck[]> {
  const head = await within(deps.readHead(path), null);
  if (!head) return [{ kind: 'screenshot', ref: path, status: 'mismatch', detail: 'missing' }];
  if (!isImage(head))
    return [{ kind: 'screenshot', ref: path, status: 'mismatch', detail: 'not-image' }];
  return [{ kind: 'screenshot', ref: path, status: 'verified' }];
}

async function verifyCi(
  runId: number,
  repo: string,
  conclusion: string | undefined,
  gh: (args: readonly string[]) => Promise<GoalResultCommandResult | null>
): Promise<GoalResultCheck[]> {
  const ref = String(runId);
  const view = await gh(['run', 'view', ref, '--repo', repo, '--json', 'conclusion']);
  const body = view?.code === 0 ? parseJson(view.stdout) : undefined;
  const actual =
    isRecord(body) && typeof body.conclusion === 'string' ? body.conclusion.toLowerCase() : '';
  if (!actual) return [unverifiable('ci', ref)];
  const claimed = (conclusion ?? 'success').toLowerCase();
  if (actual === claimed) return [{ kind: 'ci', ref, status: 'verified' }];
  return [{ kind: 'ci', ref, status: 'mismatch', detail: actual }];
}

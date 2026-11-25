import { type ChildProcess, spawn } from 'node:child_process';
import type { GithubRepo, GithubRepoSearchResult } from '@shared/types';

const TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const LIST_JSON = 'name,nameWithOwner,description,isPrivate,updatedAt,url,sshUrl';
const SEARCH_JSON = 'name,fullName,description,isPrivate,updatedAt,url';

interface ListedRepo extends GithubRepo {
  updatedAt: string;
}

type GhFailure = { ok: false; error: string };

function parseLimit(value: unknown): number | null {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseRepos(stdout: string): ListedRepo[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const repos: ListedRepo[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const name = text(item.name);
    const nameWithOwner = text(item.nameWithOwner) ?? text(item.fullName);
    const url = text(item.url);
    if (!name || !nameWithOwner || !url) continue;
    const sshUrl = text(item.sshUrl);
    repos.push({
      name,
      nameWithOwner,
      description: text(item.description),
      isPrivate: item.isPrivate === true,
      url,
      ...(sshUrl ? { sshUrl } : {}),
      updatedAt: text(item.updatedAt) ?? '',
    });
  }
  return repos;
}

function mergeRepos(repos: ListedRepo[], limit: number): GithubRepo[] {
  const byOwner = new Map<string, ListedRepo>();
  for (const repo of repos) {
    const key = repo.nameWithOwner.toLowerCase();
    const prev = byOwner.get(key);
    if (!prev) {
      byOwner.set(key, repo);
      continue;
    }
    const sshUrl = prev.sshUrl ?? repo.sshUrl;
    byOwner.set(key, {
      name: prev.name || repo.name,
      nameWithOwner: prev.nameWithOwner,
      description: prev.description ?? repo.description,
      isPrivate: prev.isPrivate || repo.isPrivate,
      url: prev.url || repo.url,
      ...(sshUrl ? { sshUrl } : {}),
      updatedAt: prev.updatedAt >= repo.updatedAt ? prev.updatedAt : repo.updatedAt,
    });
  }
  return [...byOwner.values()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, limit)
    .map(({ updatedAt: _updatedAt, ...repo }) => repo);
}

function needsAuth(value: string): boolean {
  const text = value.toLowerCase();
  return text.includes('not logged in') || text.includes('authentication');
}

function failure(error: unknown, stderr = ''): GhFailure {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  const message = error instanceof Error ? error.message : '';
  if (code === 'ENOENT' || message.includes('ENOENT')) {
    return { ok: false, error: 'GitHub CLI (gh) was not found.' };
  }
  if (needsAuth(stderr) || needsAuth(message)) {
    return { ok: false, error: 'Sign in to GitHub with gh CLI.' };
  }
  return { ok: false, error: 'GitHub search failed.' };
}

function runGh(args: string[]): Promise<{ ok: true; stdout: string } | GhFailure> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('gh', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve(failure(error));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { ok: true; stdout: string } | GhFailure) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'GitHub search timed out.' });
    }, TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.once('error', (error: Error) => finish(failure(error, stderr)));
    child.once('close', (code) => {
      if (code === 0) {
        finish({ ok: true, stdout });
        return;
      }
      finish(failure(new Error(stderr), stderr));
    });
  });
}

async function reposFrom(
  args: string[],
  limit: number
): Promise<{ ok: true; repos: ListedRepo[] } | GhFailure> {
  const result = await runGh(args);
  if (!result.ok) return result;
  const repos = parseRepos(result.stdout);
  if (!repos) return { ok: false, error: 'GitHub search failed.' };
  return { ok: true, repos: repos.slice(0, limit) };
}

/** 用 gh 列出或搜索当前账号的仓库。不经 shell，不读取 token。 */
export async function searchGithubRepos(
  query: unknown,
  limit?: unknown
): Promise<GithubRepoSearchResult> {
  if (typeof query !== 'string') return { ok: false, error: 'Invalid request.' };
  const capped = parseLimit(limit);
  if (capped === null) return { ok: false, error: 'Invalid request.' };

  const trimmed = query.trim();
  if (!trimmed) {
    const listed = await reposFrom(
      ['repo', 'list', '--json', LIST_JSON, '--limit', String(capped)],
      capped
    );
    if (!listed.ok) return listed;
    return { ok: true, repos: mergeRepos(listed.repos, capped) };
  }

  const searchArgs = ['search', 'repos', '--json', SEARCH_JSON, '--limit', String(capped)];
  const [general, priv] = await Promise.all([
    reposFrom([...searchArgs, '--sort', 'updated', '--order', 'desc', '--', trimmed], capped),
    reposFrom([...searchArgs, '--visibility=private', '--', trimmed], capped),
  ]);
  if (!general.ok) return general;
  if (!priv.ok) return priv;
  return { ok: true, repos: mergeRepos([...priv.repos, ...general.repos], capped) };
}

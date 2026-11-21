import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extractReportRefs } from '@shared/secretary/daily';
import { extractPullRef, parseNumstat, parsePullView } from '@shared/secretary/doneReport';
import type {
  SecretaryDoneReport,
  SecretaryReportFile,
  SecretaryStoredReport,
} from '@shared/types/secretary';
import type { GitRunner } from './repoStatus';

/** 结果视图最多列这么多文件，其余只给条数 */
export const DONE_REPORT_FILE_MAX = 100;
const GH_TIMEOUT_MS = 6_000;

export interface DoneReportDeps {
  report(conversationId: string): SecretaryStoredReport | null;
  /** 会话的工作目录：worktree 还在就用它，否则项目根；baseCommit 只有 worktree 有 */
  workspace(conversationId: string): { cwd: string; baseCommit?: string } | null;
  git: GitRunner;
  /** 返回 stdout；gh 不可用或失败返回 null */
  gh(args: readonly string[], cwd: string | undefined): Promise<string | null>;
}

export const runGh: DoneReportDeps['gh'] = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'gh',
      [...args],
      {
        ...(cwd && existsSync(cwd) ? { cwd } : {}),
        encoding: 'utf8',
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? null : stdout)
    );
  });

async function numstat(
  deps: DoneReportDeps,
  cwd: string,
  args: readonly string[]
): Promise<SecretaryReportFile[] | null> {
  const result = await deps.git(cwd, args);
  return result.code === 0 ? parseNumstat(result.stdout) : null;
}

/**
 * 已完成条目的「结果」：汇报正文与截图来自归档；PR 与改动文件只从 gh / git 元数据拿，
 * 一样都拿不到就不给，不从正文里猜行数。
 */
export async function buildDoneReport(
  conversationId: string,
  deps: DoneReportDeps
): Promise<SecretaryDoneReport> {
  const report = deps.report(conversationId);
  const result: SecretaryDoneReport = { report };
  const workspace = deps.workspace(conversationId);
  const ref = extractPullRef(report?.text);
  let files: SecretaryReportFile[] | null = null;
  if (ref && ('url' in ref || workspace)) {
    const target = 'url' in ref ? ref.url : String(ref.number);
    const out = await deps.gh(
      ['pr', 'view', target, '--json', 'number,url,state,mergeCommit,files'],
      workspace?.cwd
    );
    const view = out ? parsePullView(out) : null;
    if (view) {
      result.pr = view.pr;
      if (view.files.length > 0) files = view.files;
    }
  }
  if (!files && workspace) {
    const commit = extractReportRefs(report?.text).commit;
    if (commit)
      files = await numstat(deps, workspace.cwd, ['show', '--numstat', '--format=', commit]);
    else if (workspace.baseCommit)
      files = await numstat(deps, workspace.cwd, [
        'diff',
        '--numstat',
        workspace.baseCommit,
        'HEAD',
      ]);
  }
  if (files && files.length > 0) {
    result.files = files.slice(0, DONE_REPORT_FILE_MAX);
    if (files.length > DONE_REPORT_FILE_MAX) result.moreFiles = files.length - DONE_REPORT_FILE_MAX;
  }
  return result;
}

const CACHE_MS = 60_000;
const cache = new Map<
  string,
  { at: number; reportAt: number | null; value: SecretaryDoneReport }
>();

/** 生产端口：gh 慢，同一份报告一分钟内复用；报告换了就重算 */
export async function doneReportFor(conversationId: string): Promise<SecretaryDoneReport> {
  const { getSecretaryReportStore } = await import('./reportImages');
  const { sessionWorktree } = await import('../../ipc/worktree');
  const { agentSessionIndex } = await import('../../ipc/sessionIndex');
  const { getSourceAuthorityRegistry } = await import('../../ipc/agent');
  const { runGit } = await import('./repoStatus');
  const store = getSecretaryReportStore();
  const reportAt = store?.read(conversationId)?.at ?? null;
  const hit = cache.get(conversationId);
  if (hit && hit.reportAt === reportAt && Date.now() - hit.at < CACHE_MS)
    return { ...hit.value, report: store?.view(conversationId) ?? null };
  const value = await buildDoneReport(conversationId, {
    report: (id) => store?.view(id) ?? null,
    workspace: (id) => {
      const worktree = sessionWorktree(agentSessionIndex.workspaceRoot(id));
      if (worktree && existsSync(worktree.path))
        return { cwd: worktree.path, baseCommit: worktree.baseCommit };
      const registry = getSourceAuthorityRegistry();
      const projectId = registry?.conversation(id)?.projectId;
      const project = projectId ? registry?.project(projectId) : undefined;
      return project && (project.kind ?? 'local') === 'local' && existsSync(project.canonicalPath)
        ? { cwd: project.canonicalPath }
        : null;
    },
    git: runGit,
    gh: runGh,
  });
  cache.set(conversationId, { at: Date.now(), reportAt, value });
  return value;
}

import path from 'node:path';
import { app } from '@platform';
import { projectNameFromPath } from '@shared/projectName';
import { parseProfile } from '@shared/secretary/parse';
import {
  chunkMessageText,
  projectReadableMessages,
  readableText,
  wrapUntrusted,
} from '@shared/secretary/transcript';
import type {
  ConversationAuthority,
  ParentHistoryTailResult,
  ProjectAuthority,
  ProjectedMessage,
} from '@shared/types/agent';
import type { SecretaryProfile } from '@shared/types/secretary';
import type { ObservedTask } from '../backgroundTaskTracker';
import { redactSecrets } from '../memory/distill';
import {
  ACTIVITY_LIMIT_DEFAULT,
  ACTIVITY_LIMIT_MAX,
  type SessionToolActivity,
} from '../sessionActivity';
import { currentBranch, repoIsClean } from '../worktree/service';
import { leftoverReason, taskIsPersistent } from './leftover';
import {
  REPO_STATUS_COMMIT_DEFAULT,
  REPO_STATUS_COMMIT_MAX,
  type RepoScopeCandidate,
  type RepoStatusDeps,
  type RepoStatusSnapshot,
  readRepoStatus,
  realRepoDeps,
  resolveRepoScope,
} from './repoStatus';
import { SecretaryStore } from './store';
import type { SecretaryOpHandler, SecretaryOpResult } from './tools';

const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 100;
const DEFAULT_READ_LIMIT = 10;
const MAX_READ_LIMIT = 30;

/** 秘书没有工作区的三种伪项目：没有可派活的目录，也不该出现在它的项目清单里 */
const HIDDEN_PROJECT_KINDS: ReadonlySet<string> = new Set(['secretary', 'scratch', 'bot-home']);

export type SecretarySessionState = 'running' | 'idle' | 'waiting' | 'error' | 'not-started';

export interface SecretarySessionStatus {
  state: 'running' | 'idle' | 'waiting' | 'error';
  pendingAsks: number;
  pendingApprovals: number;
}

type MaybePromise<T> = T | Promise<T>;

/** Main 侧的只读数据源；测试注入假实现，生产走下面的 defaultPorts */
export interface SecretaryReadPorts {
  projects(): MaybePromise<readonly ProjectAuthority[]>;
  conversations(): MaybePromise<readonly ConversationAuthority[]>;
  rows(): MaybePromise<Record<string, Record<string, unknown>>>;
  status(conversationId: string): MaybePromise<SecretarySessionStatus>;
  history(sessionFile: string | undefined, before?: number): MaybePromise<ParentHistoryTailResult>;
  git(repoPath: string): MaybePromise<{ branch: string | null; dirty: boolean } | null>;
  profile(): MaybePromise<SecretaryProfile | null>;
  /** 全量投影后按绝对下标取一条消息；session_read 的 index 模式用 */
  message(sessionFile: string | undefined, index: number): MaybePromise<ProjectedMessage | null>;
  /** 最近工具调用，不含任何工具输出 */
  activity(sessionFile: string | undefined, limit: number): MaybePromise<SessionToolActivity[]>;
  /** 该会话的后台任务（Main 侧对 worker 事件流的投影） */
  tasks(conversationId: string): MaybePromise<ObservedTask[]>;
  /** 只读 git；路径越界校验与采集都在 repoStatus 里 */
  repo: RepoStatusDeps;
}

export interface SecretaryReadHandlers {
  project_list: SecretaryOpHandler;
  project_info: SecretaryOpHandler;
  repo_status: SecretaryOpHandler;
  session_list: SecretaryOpHandler;
  session_read: SecretaryOpHandler;
  session_tasks: SecretaryOpHandler;
  session_activity: SecretaryOpHandler;
}

interface ListedSession {
  conversationId: string;
  projectId: string;
  title: string;
  lastActiveAt: number;
  sessionFile?: string;
}

const invalidArguments: SecretaryOpResult = { ok: false, error: 'invalid arguments' };
const notFound: SecretaryOpResult = { ok: false, error: 'not-found' };

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function countParam(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/** 绝对消息下标：before 与 index 共用同一套校验 */
function absoluteIndex(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/** 全文分页的 offset 允许 0，与 countParam 的最小 1 不同 */
function offsetParam(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 后台任务在秘书眼里的三态：在跑、正常退出、被杀（没有退出码 = 信号终止） */
function taskState(task: ObservedTask): 'running' | 'exited' | 'killed' {
  if (task.status === 'running') return 'running';
  if (task.status === 'done') return 'exited';
  return task.exitCode === undefined ? 'killed' : 'exited';
}

/** parseProfile 只对非对象输入返回 null，空对象就是默认档案 */
function defaultProfile(): SecretaryProfile {
  const parsed = parseProfile({});
  if (!parsed) throw new Error('secretary default profile');
  return parsed;
}

export function visibleProjects(
  projects: readonly ProjectAuthority[],
  profile: SecretaryProfile
): ProjectAuthority[] {
  const allowed = profile.visibleProjectIds;
  return projects.filter(
    (project) =>
      project.state === 'active' &&
      !HIDDEN_PROJECT_KINDS.has(project.kind ?? 'local') &&
      (allowed === 'all' || allowed.includes(project.projectId))
  );
}

/**
 * 秘书可见的会话：可见项目里的根会话，排除 child、bot、已归档与没有权威记录的残留行。
 * 排序在调用方按需截断，保证 session_list 与 project_info 的最近活跃口径一致。
 */
async function collect(ports: SecretaryReadPorts): Promise<{
  projects: ProjectAuthority[];
  sessions: ListedSession[];
}> {
  const profile = (await ports.profile()) ?? defaultProfile();
  const projects = visibleProjects(await ports.projects(), profile);
  const visibleIds = new Set(projects.map((project) => project.projectId));
  const authorities = new Map(
    (await ports.conversations()).map((conversation) => [conversation.conversationId, conversation])
  );
  const sessions: ListedSession[] = [];
  for (const [conversationId, row] of Object.entries(await ports.rows())) {
    if (row.parentId !== undefined || row.btwParentId !== undefined) continue;
    if (row.archived === true) continue;
    const projectId = typeof row.projectId === 'string' ? row.projectId : undefined;
    if (!projectId || !visibleIds.has(projectId)) continue;
    const authority = authorities.get(conversationId);
    if (authority?.kind !== 'root' || authority.bot) continue;
    if (authority.projectId !== projectId) continue;
    const sessionFile = typeof row.sessionFile === 'string' ? row.sessionFile : undefined;
    sessions.push({
      conversationId,
      projectId,
      title: redactSecrets(typeof row.title === 'string' ? row.title : ''),
      lastActiveAt: timestamp(row.lastActiveAt) ?? timestamp(row.createdAt) ?? 0,
      ...(sessionFile ? { sessionFile } : {}),
    });
  }
  sessions.sort(
    (left, right) =>
      right.lastActiveAt - left.lastActiveAt ||
      left.conversationId.localeCompare(right.conversationId)
  );
  return { projects, sessions };
}

function projectKind(project: ProjectAuthority): 'local' | 'ssh' {
  return project.kind === 'ssh' ? 'ssh' : 'local';
}

function lastActivity(sessions: readonly ListedSession[], projectId: string): number | null {
  let latest: number | null = null;
  for (const session of sessions) {
    if (session.projectId !== projectId) continue;
    latest = latest === null ? session.lastActiveAt : Math.max(latest, session.lastActiveAt);
  }
  return latest;
}

function sessionState(
  session: ListedSession,
  status: SecretarySessionStatus
): SecretarySessionState {
  return session.sessionFile ? status.state : 'not-started';
}

/**
 * repo_status 的对外形状。提交标题与作者是仓库里的自由文本，按不可信内容包起来；
 * 路径与 ref 沿用 project_list / project_info 的口径只做脱敏，保证秘书能原样回传。
 */
function presentRepoStatus(
  snapshot: RepoStatusSnapshot,
  projectId: string
): Record<string, unknown> {
  const untrusted = (text: string) => wrapUntrusted(`repo:${projectId}`, redactSecrets(text));
  return {
    path: redactSecrets(snapshot.root),
    branch: snapshot.branch === null ? null : redactSecrets(snapshot.branch),
    head: snapshot.head
      ? { sha: snapshot.head.sha, subject: untrusted(snapshot.head.subject) }
      : null,
    commits: snapshot.commits.map((commit) => ({
      sha: commit.sha,
      subject: untrusted(commit.subject),
      author: untrusted(commit.author),
      at: commit.at,
    })),
    ...(snapshot.base ? { base: snapshot.base } : {}),
    ...(snapshot.contains ? { contains: snapshot.contains } : {}),
    changes: {
      total: snapshot.changes.total,
      files: snapshot.changes.files.map((file) => ({
        status: file.status,
        path: redactSecrets(file.path),
      })),
    },
    operation: snapshot.operation,
    worktrees: snapshot.worktrees.map((worktree) => ({
      path: redactSecrets(worktree.path),
      branch: worktree.branch === null ? null : redactSecrets(worktree.branch),
      head: worktree.head,
    })),
  };
}

export function createSecretaryReadHandlers(ports: SecretaryReadPorts): SecretaryReadHandlers {
  return {
    async project_list() {
      const { projects, sessions } = await collect(ports);
      const rows = projects.map((project) => ({
        projectId: project.projectId,
        name: redactSecrets(projectNameFromPath(project.canonicalPath)),
        kind: projectKind(project),
        path: redactSecrets(project.canonicalPath),
        lastActivityAt: lastActivity(sessions, project.projectId),
      }));
      const withGit: Array<
        (typeof rows)[number] & { git?: { branch: string | null; dirty: boolean } }
      > = [];
      for (const row of rows) {
        const project = projects.find((candidate) => candidate.projectId === row.projectId);
        const git =
          project && project.kind !== 'ssh' ? await ports.git(project.canonicalPath) : null;
        withGit.push(git ? { ...row, git } : row);
      }
      withGit.sort(
        (left, right) =>
          (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0) ||
          left.name.localeCompare(right.name)
      );
      return { ok: true, result: { projects: withGit } };
    },

    async project_info(params) {
      const projectId = stringParam(params, 'projectId');
      if (!projectId) return invalidArguments;
      const { projects, sessions } = await collect(ports);
      const project = projects.find((candidate) => candidate.projectId === projectId);
      if (!project) return notFound;
      // ssh 项目的分支在远端，本机跑 git 只会得到错误
      const git = project.kind === 'ssh' ? null : await ports.git(project.canonicalPath);
      return {
        ok: true,
        result: {
          projectId,
          name: redactSecrets(projectNameFromPath(project.canonicalPath)),
          kind: projectKind(project),
          path: redactSecrets(project.canonicalPath),
          lastActivityAt: lastActivity(sessions, projectId),
          ...(git ? { git } : {}),
        },
      };
    },

    async session_list(params) {
      const projectId = stringParam(params, 'projectId');
      const limit = countParam(params.limit, DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT);
      const { projects, sessions } = await collect(ports);
      if (projectId && !projects.some((project) => project.projectId === projectId))
        return notFound;
      const scoped = projectId
        ? sessions.filter((session) => session.projectId === projectId)
        : sessions;
      const rows = [];
      for (const session of scoped.slice(0, limit)) {
        const status = await ports.status(session.conversationId);
        rows.push({
          conversationId: session.conversationId,
          projectId: session.projectId,
          title: session.title,
          state: sessionState(session, status),
          pending: { approvals: status.pendingApprovals, asks: status.pendingAsks },
          lastActiveAt: session.lastActiveAt,
        });
      }
      return { ok: true, result: { sessions: rows } };
    },

    async session_read(params) {
      const conversationId = stringParam(params, 'conversationId');
      if (!conversationId) return invalidArguments;
      const limit = countParam(params.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
      const before = absoluteIndex(params.before);
      const index = absoluteIndex(params.index);
      const { sessions } = await collect(ports);
      const session = sessions.find((candidate) => candidate.conversationId === conversationId);
      if (!session) return notFound;
      // index 模式：读单条消息全文，按 offset 分页；只放行 user / assistant，工具输出不外泄
      if (index !== undefined) {
        const message = await ports.message(session.sessionFile, index);
        if (!message) return notFound;
        if (message.role !== 'user' && message.role !== 'assistant')
          return { ok: false, error: 'not-readable' };
        const chunk = chunkMessageText(readableText(message), offsetParam(params.offset));
        return {
          ok: true,
          result: {
            conversationId,
            projectId: session.projectId,
            title: session.title,
            index,
            role: message.role,
            totalChars: chunk.totalChars,
            offset: chunk.offset,
            text: wrapUntrusted(`session:${conversationId}`, redactSecrets(chunk.text)),
            ...(chunk.nextOffset === undefined ? {} : { nextOffset: chunk.nextOffset }),
          },
        };
      }
      const status = await ports.status(conversationId);
      const page = await ports.history(session.sessionFile, before);
      const readable = page.ok
        ? projectReadableMessages(page.messages, { limit, baseIndex: page.baseIndex })
        : { messages: [], hasMore: false };
      const source = `session:${conversationId}`;
      const messages = readable.messages.map((message) => ({
        index: message.index,
        role: message.role,
        text: wrapUntrusted(source, redactSecrets(message.text)),
        ...(message.truncated ? { truncated: true } : {}),
      }));
      const nextBefore = page.ok ? (messages[0]?.index ?? page.baseIndex) : (before ?? 0);
      return {
        ok: true,
        result: {
          conversationId,
          projectId: session.projectId,
          title: session.title,
          state: sessionState(session, status),
          pending: { approvals: status.pendingApprovals, asks: status.pendingAsks },
          lastActiveAt: session.lastActiveAt,
          messages,
          hasMore: readable.hasMore,
          ...(readable.hasMore ? { nextBefore } : {}),
          ...(page.ok ? {} : { historyError: page.code }),
        },
      };
    },

    async session_tasks(params) {
      const conversationId = stringParam(params, 'conversationId');
      if (!conversationId) return invalidArguments;
      const { sessions } = await collect(ports);
      const session = sessions.find((candidate) => candidate.conversationId === conversationId);
      if (!session) return notFound;
      const now = Date.now();
      const source = `task:${conversationId}`;
      const tasks = (await ports.tasks(conversationId)).map((task) => {
        const leftover = leftoverReason(task, { now });
        return {
          taskId: task.taskId,
          command: wrapUntrusted(source, redactSecrets(task.command)),
          startedAt: task.startedAt,
          ranMs: Math.max(0, now - task.startedAt),
          status: task.status,
          state: taskState(task),
          ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
          // null：worker 看门狗还没探测过，不能当成"活着"
          alive: task.alive ?? null,
          ...(task.deadlineAt === undefined ? {} : { deadlineAt: task.deadlineAt }),
          ...(task.status === 'running' && task.deadlineAt !== undefined && now >= task.deadlineAt
            ? { stalled: true }
            : {}),
          // 常驻服务不会自己结束；遗留只按进程与时长判定，不看会话是否收口
          ...(task.status === 'running' && taskIsPersistent(task, now) ? { persistent: true } : {}),
          ...(leftover ? { leftover } : {}),
        };
      });
      return {
        ok: true,
        result: { conversationId, projectId: session.projectId, tasks },
      };
    },

    async session_activity(params) {
      const conversationId = stringParam(params, 'conversationId');
      if (!conversationId) return invalidArguments;
      const limit = countParam(params.limit, ACTIVITY_LIMIT_DEFAULT, ACTIVITY_LIMIT_MAX);
      const { sessions } = await collect(ports);
      const session = sessions.find((candidate) => candidate.conversationId === conversationId);
      if (!session) return notFound;
      const source = `session:${conversationId}`;
      const calls = (await ports.activity(session.sessionFile, limit)).map((call) => ({
        name: call.name,
        ok: call.ok,
        ...(call.pending ? { pending: true } : {}),
        ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
        ...(call.at === undefined ? {} : { at: call.at }),
        ...(call.command ? { command: wrapUntrusted(source, redactSecrets(call.command)) } : {}),
      }));
      return {
        ok: true,
        result: { conversationId, projectId: session.projectId, calls },
      };
    },

    async repo_status(params) {
      const projectId = stringParam(params, 'projectId');
      const requestedPath = stringParam(params, 'path');
      if (!projectId && !requestedPath) return invalidArguments;
      const limit = countParam(params.limit, REPO_STATUS_COMMIT_DEFAULT, REPO_STATUS_COMMIT_MAX);
      const base = stringParam(params, 'base');
      const contains = stringParam(params, 'contains');
      const { projects } = await collect(ports);
      // ssh 项目的分支在远端，本机跑 git 只会得到错误
      const candidates: RepoScopeCandidate[] = projects
        .filter((project) => project.kind !== 'ssh')
        .map((project) => ({ projectId: project.projectId, path: project.canonicalPath }));
      let scope: { projectId: string; root: string } | null = null;
      if (requestedPath) {
        scope = await resolveRepoScope(ports.repo, candidates, requestedPath);
        // 同时给了 projectId 时，路径必须落在同一个项目里，不能借路径跨项目
        if (scope && projectId && scope.projectId !== projectId)
          return { ok: false, error: 'path-out-of-scope' };
      } else {
        const project = projects.find((candidate) => candidate.projectId === projectId);
        if (!project) return notFound;
        if (project.kind === 'ssh') return { ok: false, error: 'ssh-project' };
        scope = { projectId: project.projectId, root: project.canonicalPath };
      }
      if (!scope) return { ok: false, error: 'path-out-of-scope' };
      const outcome = await readRepoStatus(ports.repo, {
        root: scope.root,
        limit,
        ...(base ? { base } : {}),
        ...(contains ? { contains } : {}),
      });
      if (!outcome.ok) return { ok: false, error: outcome.code };
      return {
        ok: true,
        result: {
          projectId: scope.projectId,
          ...presentRepoStatus(outcome.snapshot, scope.projectId),
        },
      };
    },
  };
}

const defaultPorts: SecretaryReadPorts = {
  async projects() {
    const registry = (await import('../../ipc/agent')).getSourceAuthorityRegistry();
    return registry?.projection().projects ?? [];
  },
  async conversations() {
    const registry = (await import('../../ipc/agent')).getSourceAuthorityRegistry();
    return registry?.projection().conversations ?? [];
  },
  async rows() {
    return (await import('../../ipc/settings')).readPersistedConversations();
  },
  async status(conversationId) {
    return (await import('../../ipc/agent')).observedSessionStatus(conversationId);
  },
  async history(sessionFile, before) {
    return (await import('../../ipc/agent')).readSessionHistoryFile(sessionFile, before);
  },
  async git(repoPath) {
    try {
      const [branch, clean] = await Promise.all([currentBranch(repoPath), repoIsClean(repoPath)]);
      return { branch, dirty: !clean };
    } catch {
      return null;
    }
  },
  async profile() {
    return new SecretaryStore(path.join(app.getPath('userData'), 'secretary')).profile();
  },
  async message(sessionFile, index) {
    return (await import('../../ipc/agent')).readSessionMessage(sessionFile, index);
  },
  async activity(sessionFile, limit) {
    return (await import('../../ipc/agent')).readSessionActivity(sessionFile, limit);
  },
  async tasks(conversationId) {
    return (await import('../../ipc/agent')).observedBackgroundTasks(conversationId);
  },
  repo: realRepoDeps,
};

export const secretaryReadHandlers = createSecretaryReadHandlers(defaultPorts);

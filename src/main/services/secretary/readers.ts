import type { SessionReminder } from '@shared/reminders';
import { formatGoalResultClaims, type GoalResultView } from '@shared/secretary/goalResult';
import { parseProfile } from '@shared/secretary/parse';
import { queuedStartOf, queuePositions } from '@shared/secretary/queuedSession';
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
import { autoArchived } from './autoArchive';
import { leftoverReason, taskIsPersistent } from './leftover';
import { projectAliasesFromSettings, secretaryProjectNames } from './projectLabel';
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
import type { SecretaryContext } from './secretaries';
import { SecretaryStore } from './store';
import type { SecretaryOpHandler, SecretaryOpResult } from './tools';

export { projectAliasesFromSettings };

const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 100;
const DEFAULT_READ_LIMIT = 10;
const MAX_READ_LIMIT = 30;

/** 秘书没有工作区的三种伪项目：没有可派活的目录，也不该出现在它的项目清单里 */
const HIDDEN_PROJECT_KINDS: ReadonlySet<string> = new Set(['secretary', 'scratch', 'bot-home']);

export type SecretarySessionState =
  | 'running'
  | 'idle'
  | 'waiting'
  | 'error'
  | 'not-started'
  | 'queued';

export interface SecretarySessionStatus {
  state: 'running' | 'idle' | 'waiting' | 'error';
  pendingAsks: number;
  pendingApprovals: number;
}

type MaybePromise<T> = T | Promise<T>;

/** Main 侧的只读数据源；测试注入假实现，生产走下面的 defaultPorts */
export interface SecretaryReadPorts {
  projects(): MaybePromise<readonly ProjectAuthority[]>;
  /** projectId → 用户起的别名；别名只存在 settings.json 的项目列表里，不在权威注册表 */
  projectAliases?(): MaybePromise<Readonly<Record<string, string>>>;
  conversations(): MaybePromise<readonly ConversationAuthority[]>;
  rows(): MaybePromise<Record<string, Record<string, unknown>>>;
  status(conversationId: string): MaybePromise<SecretarySessionStatus>;
  history(sessionFile: string | undefined, before?: number): MaybePromise<ParentHistoryTailResult>;
  git(repoPath: string): MaybePromise<{ branch: string | null; dirty: boolean } | null>;
  profile(): MaybePromise<SecretaryProfile | null>;
  /** 全量投影后按 jsonl entry id（优先）或绝对下标取一条消息；session_read 的全文模式用 */
  message(
    sessionFile: string | undefined,
    target: { entryId: string } | { index: number }
  ): MaybePromise<{ index: number; message: ProjectedMessage } | null>;
  /** 最近工具调用，不含任何工具输出 */
  activity(sessionFile: string | undefined, limit: number): MaybePromise<SessionToolActivity[]>;
  /** 该会话的后台任务（Main 侧对 worker 事件流的投影） */
  tasks(conversationId: string): MaybePromise<ObservedTask[]>;
  /** 会话（含子代理）挂着的自定提醒；缺省表示没有 */
  reminders?(conversationId: string): MaybePromise<readonly SessionReminder[]>;
  /** 派发记录上的结构化结果；缺省表示没有 */
  goalResult?(conversationId: string): MaybePromise<GoalResultView | undefined>;
  /** 这条已归档的行是不是派出会话完成后被 Main 自动归档的；缺省表示都不是 */
  autoArchived?(conversationId: string, row: Record<string, unknown>): MaybePromise<boolean>;
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
  /** 会话行上的目标：与 session_create 挂的是同一种，巡检按它判定 */
  goal?: { text: string; status: string };
  /** 排队会话：位次，或自动启动失败的原因 */
  queue?: { position: number } | { failed: string };
}

const invalidArguments: SecretaryOpResult = { ok: false, error: 'invalid arguments' };
const notFound: SecretaryOpResult = { ok: false, error: 'not-found' };
/** 消息已不在当前分支（回退、换了会话文件）或下标不是分页给的：应重新分页。错误码在前，工具卡片按码取译文 */
const staleIndex: SecretaryOpResult = {
  ok: false,
  error:
    'stale-index: the message changed (the session was rewound or switched branches); list the session again and read it with the new entryId',
};
const notReadable: SecretaryOpResult = {
  ok: false,
  error:
    'not-readable: only user and assistant messages can be read; tool calls and tool output are never returned',
};

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

/** 后台任务在秘书眼里的状态：在跑、正常退出、被杀（没有退出码 = 信号终止）、因应用重启被停 */
function taskState(task: ObservedTask): 'running' | 'exited' | 'killed' | 'interrupted-by-restart' {
  if (task.interrupted === 'restart') return 'interrupted-by-restart';
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
async function collect(
  ports: SecretaryReadPorts,
  /** session_read 读完成结果：放行 Main 自动归档的派出会话，用户手动归档的仍不可见 */
  withAutoArchived = false
): Promise<{
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
  const rows = await ports.rows();
  const positions = queuePositions(rows);
  for (const [conversationId, row] of Object.entries(rows)) {
    if (row.parentId !== undefined || row.btwParentId !== undefined) continue;
    if (
      row.archived === true &&
      !(withAutoArchived && (await ports.autoArchived?.(conversationId, row)) === true)
    )
      continue;
    const projectId = typeof row.projectId === 'string' ? row.projectId : undefined;
    if (!projectId || !visibleIds.has(projectId)) continue;
    const authority = authorities.get(conversationId);
    if (authority?.kind !== 'root' || authority.bot) continue;
    if (authority.projectId !== projectId) continue;
    const sessionFile = typeof row.sessionFile === 'string' ? row.sessionFile : undefined;
    const goal = listedGoal(row.goal);
    const queued = queuedStartOf(row);
    const position = positions.get(conversationId);
    sessions.push({
      conversationId,
      projectId,
      title: redactSecrets(typeof row.title === 'string' ? row.title : ''),
      lastActiveAt: timestamp(row.lastActiveAt) ?? timestamp(row.createdAt) ?? 0,
      ...(sessionFile ? { sessionFile } : {}),
      ...(goal ? { goal } : {}),
      ...(queued?.failed
        ? { queue: { failed: queued.failed.error } }
        : queued && position !== undefined
          ? { queue: { position } }
          : {}),
    });
  }
  sessions.sort(
    (left, right) =>
      right.lastActiveAt - left.lastActiveAt ||
      left.conversationId.localeCompare(right.conversationId)
  );
  return { projects, sessions };
}

/** 会话行上的目标：只取文本与状态，计数与指纹不外泄 */
function listedGoal(value: unknown): { text: string; status: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const goal = value as Record<string, unknown>;
  if (typeof goal.text !== 'string' || !goal.text.trim()) return undefined;
  if (typeof goal.status !== 'string') return undefined;
  return { text: goal.text, status: goal.status };
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
  if (session.queue) return 'queued';
  return session.sessionFile ? status.state : 'not-started';
}

function queueFields(session: ListedSession): Record<string, unknown> {
  if (!session.queue) return {};
  return 'failed' in session.queue
    ? { queueFailed: redactSecrets(session.queue.failed) }
    : { queuePosition: session.queue.position };
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
  async function goalResultOf(
    source: string,
    conversationId: string
  ): Promise<
    | { goalResult: { at: number; result: string; checks?: GoalResultView['checks'] } }
    | Record<string, never>
  > {
    const view = await ports.goalResult?.(conversationId);
    if (!view) return {};
    return {
      goalResult: {
        at: view.at,
        ...(view.checks ? { checks: view.checks } : {}),
        result: wrapUntrusted(source, redactSecrets(formatGoalResultClaims(view.result))),
      },
    };
  }

  return {
    async project_list() {
      const { projects, sessions } = await collect(ports);
      const aliases = (await ports.projectAliases?.()) ?? {};
      const rows = projects.map((project) => ({
        projectId: project.projectId,
        ...secretaryProjectNames(project, aliases),
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
      const aliases = (await ports.projectAliases?.()) ?? {};
      // ssh 项目的分支在远端，本机跑 git 只会得到错误
      const git = project.kind === 'ssh' ? null : await ports.git(project.canonicalPath);
      return {
        ok: true,
        result: {
          projectId,
          ...secretaryProjectNames(project, aliases),
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
          ...queueFields(session),
          pending: { approvals: status.pendingApprovals, asks: status.pendingAsks },
          lastActiveAt: session.lastActiveAt,
          ...(session.goal ? { goal: session.goal } : {}),
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
      const entryId = stringParam(params, 'entryId');
      const target =
        entryId !== undefined ? { entryId } : index !== undefined ? { index } : undefined;
      const { sessions } = await collect(ports, true);
      const session = sessions.find((candidate) => candidate.conversationId === conversationId);
      if (!session) return notFound;
      // 全文模式：按 entryId（优先）或 index 读单条消息，按 offset 分页；只放行 user / assistant，工具输出不外泄
      if (target) {
        const found = await ports.message(session.sessionFile, target);
        if (!found) return staleIndex;
        const { message } = found;
        const foundId = message.messageId ?? entryId;
        const readable = message.role === 'user' || message.role === 'assistant';
        // id 是分页给出的稳定标识，点到工具消息就是不可读；分页从不给出工具消息或空正文的下标，撞上只能是下标已漂移
        if (entryId !== undefined && !readable) return notReadable;
        const body = readable ? readableText(message) : '';
        if (!body) return staleIndex;
        const chunk = chunkMessageText(body, offsetParam(params.offset));
        return {
          ok: true,
          result: {
            conversationId,
            projectId: session.projectId,
            title: session.title,
            index: found.index,
            ...(foundId ? { entryId: foundId } : {}),
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
      const goal = await goalResultOf(source, conversationId);
      const messages = readable.messages.map((message) => ({
        index: message.index,
        ...(message.entryId ? { entryId: message.entryId } : {}),
        role: message.role,
        text: wrapUntrusted(source, redactSecrets(message.text)),
        ...(message.truncated ? { truncated: true } : {}),
      }));
      const nextBefore = page.ok ? (messages[0]?.index ?? page.baseIndex) : (before ?? 0);
      const reminders = (await ports.reminders?.(conversationId)) ?? [];
      return {
        ok: true,
        result: {
          conversationId,
          projectId: session.projectId,
          title: session.title,
          state: sessionState(session, status),
          ...queueFields(session),
          pending: { approvals: status.pendingApprovals, asks: status.pendingAsks },
          lastActiveAt: session.lastActiveAt,
          messages,
          hasMore: readable.hasMore,
          ...(readable.hasMore ? { nextBefore } : {}),
          ...(page.ok ? {} : { historyError: page.code }),
          // 挂着自定提醒：会话在等自己定的时间点，不是卡住
          ...(reminders.length > 0
            ? {
                reminders: reminders.map((item) => ({
                  dueAt: item.dueAt,
                  ...(item.label ? { label: item.label } : {}),
                })),
              }
            : {}),
          ...goal,
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
          status:
            task.interrupted === 'restart' ? ('interrupted-by-restart' as const) : task.status,
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
          // 子代理起的任务归子代理：标出所属子会话，不当成会话自己起的
          ...(task.ownerSessionId ? { startedBySubagent: task.ownerSessionId } : {}),
        };
      });
      const reminders = (await ports.reminders?.(conversationId)) ?? [];
      return {
        ok: true,
        result: {
          conversationId,
          projectId: session.projectId,
          tasks,
          ...(reminders.length > 0
            ? {
                reminders: reminders.map((item) => ({
                  id: item.id,
                  ...(item.label ? { label: item.label } : {}),
                  dueAt: item.dueAt,
                  inMs: item.dueAt - now,
                  ...(item.sessionId === conversationId ? {} : { subagent: item.sessionId }),
                })),
              }
            : {}),
        },
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
        ...(call.pending ? { pending: true } : { ok: call.ok === true }),
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

/** 一个秘书的只读端口：档案（可见项目）按秘书读，降权回合传收窄后的档案 */
export function readPortsFor(
  ctx: SecretaryContext,
  profile: () => MaybePromise<SecretaryProfile | null> = () => new SecretaryStore(ctx.dir).profile()
): SecretaryReadPorts {
  return {
    async projects() {
      const registry = (await import('../../ipc/agent')).getSourceAuthorityRegistry();
      return registry?.projection().projects ?? [];
    },
    async projectAliases() {
      return projectAliasesFromSettings((await import('../../ipc/settings')).readSettings());
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
      return (await import('../../ipc/agent')).readSessionHistoryFile(sessionFile, before, {
        messageIds: true,
      });
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
      return profile();
    },
    async message(sessionFile, target) {
      return (await import('../../ipc/agent')).readSessionMessage(sessionFile, target);
    },
    async activity(sessionFile, limit) {
      return (await import('../../ipc/agent')).readSessionActivity(sessionFile, limit);
    },
    async tasks(conversationId) {
      return (await import('../../ipc/agent')).observedBackgroundTasks(conversationId);
    },
    async reminders(conversationId) {
      return (await import('../sessionReminders')).readSessionReminders(conversationId);
    },
    goalResult(conversationId) {
      return new SecretaryStore(ctx.dir).dispatch().dispatched[conversationId]?.goalResult;
    },
    autoArchived(conversationId, row) {
      const record = new SecretaryStore(ctx.dir).dispatch().dispatched[conversationId];
      return record ? autoArchived(record, row) : false;
    },
    repo: realRepoDeps,
  };
}

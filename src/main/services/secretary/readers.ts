import path from 'node:path';
import { app } from '@platform';
import { projectNameFromPath } from '@shared/projectName';
import { parseProfile } from '@shared/secretary/parse';
import { projectReadableMessages, wrapUntrusted } from '@shared/secretary/transcript';
import type {
  ConversationAuthority,
  ParentHistoryTailResult,
  ProjectAuthority,
} from '@shared/types/agent';
import type { SecretaryProfile } from '@shared/types/secretary';
import { redactSecrets } from '../memory/distill';
import { currentBranch, repoIsClean } from '../worktree/service';
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
}

export interface SecretaryReadHandlers {
  project_list: SecretaryOpHandler;
  project_info: SecretaryOpHandler;
  session_list: SecretaryOpHandler;
  session_read: SecretaryOpHandler;
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

function beforeParam(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
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
      rows.sort(
        (left, right) =>
          (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0) ||
          left.name.localeCompare(right.name)
      );
      return { ok: true, result: { projects: rows } };
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
      const before = beforeParam(params.before);
      const { sessions } = await collect(ports);
      const session = sessions.find((candidate) => candidate.conversationId === conversationId);
      if (!session) return notFound;
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
};

export const secretaryReadHandlers = createSecretaryReadHandlers(defaultPorts);

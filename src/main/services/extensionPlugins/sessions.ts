import { basename } from 'node:path';
import type { PluginSessionState } from '@shared/extensionPlugins/events';
import type { ConversationAuthority, ProjectAuthority } from '@shared/types/agent';
import type { PluginSessionInfo } from './gate';

const MAX_SESSIONS = 200;
const MAX_TITLE = 200;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

interface SessionSource {
  conversations: readonly ConversationAuthority[];
  persisted(id: string): Record<string, unknown> | null;
  running(id: string): boolean;
  state(id: string): PluginSessionState;
}

const listable = (c: ConversationAuthority) =>
  c.kind === 'root' && c.lifecycle !== 'ended' && !c.bot;

/** 权威记录定范围，持久化的会话行只提供标题与时间 */
function toInfo(
  input: SessionSource,
  c: ConversationAuthority,
  project?: ProjectAuthority
): PluginSessionInfo {
  const row = input.persisted(c.conversationId) ?? {};
  const title = typeof row.title === 'string' ? row.title.trim().slice(0, MAX_TITLE) : '';
  const running = input.running(c.conversationId);
  const state = input.state(c.conversationId);
  const info: PluginSessionInfo = {
    id: c.conversationId,
    title,
    updatedAt: finite(row.lastActiveAt) ?? finite(row.createdAt) ?? 0,
    // 启动中还没有状态事件，按索引算作运行
    state: state === 'idle' && running ? 'running' : state,
  };
  if (running) info.running = true;
  if (row.archived === true) info.archived = true;
  if (project) {
    info.projectId = project.projectId;
    info.projectName = basename(project.canonicalPath);
  }
  return info;
}

const newestFirst = (list: PluginSessionInfo[]) =>
  list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);

/** 与 origin 同项目的主会话 */
export function listProjectSessions(
  input: SessionSource & { origin: string }
): PluginSessionInfo[] {
  const rootId = input.origin.split('::')[0];
  const projectId = input.conversations.find((c) => c.conversationId === rootId)?.projectId;
  if (!projectId) return [];
  return newestFirst(
    input.conversations
      .filter((c) => c.projectId === projectId && listable(c))
      .map((c) => toInfo(input, c))
  );
}

/**
 * 所有在用项目的主会话；不含 Bot 工作区。秘书项目只在 includeSecretary 时纳入，
 * 且只认 secretaryName 认得的在用秘书：项目名与缺省标题都用秘书名。
 */
export function listAllSessions(
  input: SessionSource & {
    projects: readonly ProjectAuthority[];
    includeSecretary?: boolean;
    secretaryName?: (projectId: string) => string | null;
  }
): PluginSessionInfo[] {
  const projects = new Map(
    input.projects
      .filter(
        (p) =>
          p.state === 'active' &&
          p.kind !== 'bot-home' &&
          (p.kind !== 'secretary' || input.includeSecretary === true)
      )
      .map((p) => [p.projectId, p])
  );
  return newestFirst(
    input.conversations.flatMap((c) => {
      const project = projects.get(c.projectId);
      if (!project || !listable(c)) return [];
      const info = toInfo(input, c, project);
      if (project.kind !== 'secretary') return [info];
      const name = input.secretaryName?.(project.projectId);
      if (!name) return [];
      return [{ ...info, title: info.title || name, projectName: name, kind: 'secretary' }];
    })
  );
}

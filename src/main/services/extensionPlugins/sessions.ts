import type { ConversationAuthority } from '@shared/types/agent';
import type { PluginSessionInfo } from './gate';

const MAX_SESSIONS = 200;
const MAX_TITLE = 200;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** 与 origin 同项目的主会话：权威记录定范围，持久化的会话行只提供标题与时间 */
export function listProjectSessions(input: {
  origin: string;
  conversations: readonly ConversationAuthority[];
  persisted(id: string): Record<string, unknown> | null;
  running(id: string): boolean;
}): PluginSessionInfo[] {
  const rootId = input.origin.split('::')[0];
  const projectId = input.conversations.find((c) => c.conversationId === rootId)?.projectId;
  if (!projectId) return [];
  return input.conversations
    .filter(
      (c) => c.projectId === projectId && c.kind === 'root' && c.lifecycle !== 'ended' && !c.bot
    )
    .map((c) => {
      const row = input.persisted(c.conversationId) ?? {};
      const title = typeof row.title === 'string' ? row.title.trim().slice(0, MAX_TITLE) : '';
      const info: PluginSessionInfo = {
        id: c.conversationId,
        title,
        updatedAt: finite(row.lastActiveAt) ?? finite(row.createdAt) ?? 0,
      };
      if (input.running(c.conversationId)) info.running = true;
      if (row.archived === true) info.archived = true;
      return info;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);
}

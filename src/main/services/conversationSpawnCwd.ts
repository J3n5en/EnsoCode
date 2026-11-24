import path from 'node:path';
import { conversationCwd } from '@shared/conversationCwd';
import { resolveLocalUnderCwd } from './filesWorkspace';
import type { SourceAuthorityRegistry } from './sourceAuthorityRegistry';

/** cwd 只从权威记录推导。scratch 固定为 `<根>/<会话 id>`，secretary 固定为项目根，都不接受 worktree。 */
export function spawnCwdFromAuthority(
  authority: Pick<SourceAuthorityRegistry, 'conversation' | 'project'> | null | undefined,
  worktreePath: (conversationId: string) => string | undefined,
  sessionId: string
): string | null {
  const conversation = authority?.conversation(sessionId);
  const project = conversation ? authority?.project(conversation.projectId) : undefined;
  if (
    conversation?.kind !== 'root' ||
    conversation.lifecycle === 'ended' ||
    project?.state !== 'active'
  ) {
    return null;
  }
  return conversationCwd({
    kind: project.kind,
    canonicalPath: project.canonicalPath,
    conversationId: sessionId,
    worktreePath:
      project.kind === 'ssh' || project.kind === 'scratch' || project.kind === 'secretary'
        ? undefined
        : worktreePath(sessionId),
  });
}

/** @ 文件搜索根：与 agent cwd 同源但不跟 worktree；ssh 没有本机根；realpath 必须仍在项目根内。 */
export function mentionSearchRoot(
  authority: Pick<SourceAuthorityRegistry, 'conversation' | 'project'> | null | undefined,
  conversationId: string
): string | null {
  const projectId = authority?.conversation(conversationId)?.projectId;
  const project = projectId ? authority?.project(projectId) : undefined;
  if (!project || project.kind === 'ssh') return null;
  const cwd = spawnCwdFromAuthority(authority, () => undefined, conversationId);
  return cwd
    ? resolveLocalUnderCwd(project.canonicalPath, path.relative(project.canonicalPath, cwd))
    : null;
}

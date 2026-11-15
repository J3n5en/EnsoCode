import type { ProjectKind } from '@shared/types/agent';
import { getSourceAuthorityRegistry } from '../../ipc/agent';

/** 秘书身份按项目 kind 推导：秘书项目里的会话就是全部秘书会话，派出关系另存在 dispatch.json */
export function isSecretaryProject(project: { kind?: ProjectKind } | undefined): boolean {
  return project?.kind === 'secretary';
}

export function secretaryProjectId(): string | null {
  const registry = getSourceAuthorityRegistry();
  const project = registry
    ?.projection()
    .projects.find((candidate) => candidate.state === 'active' && isSecretaryProject(candidate));
  return project?.projectId ?? null;
}

export function isSecretaryConversation(conversationId: string): boolean {
  const registry = getSourceAuthorityRegistry();
  const conversation = registry?.conversation(conversationId);
  return Boolean(conversation && isSecretaryProject(registry?.project(conversation.projectId)));
}

import { randomUUID } from 'node:crypto';
import type { HostToPhone, PhoneToHost } from '@enso/pair';
import type { CreateProjectAuthorityRequest } from '@shared/types/agent';
import { createHostDir, listHostDirs } from './hostDirs';

type ProjectCommand = Extract<PhoneToHost, { type: 'host-dirs' | 'project-add' }>;

export interface PairProjectDeps {
  createProject?: (
    request: CreateProjectAuthorityRequest
  ) => { accepted: true; value: { projectId: string } } | { accepted: false; error?: string };
}

/** 另一台桌面添加项目：浏览/新建 host 目录，或把目录登记进权威注册表（renderer 随投影广播同步） */
export async function pairProjectReply(
  command: ProjectCommand,
  deps: PairProjectDeps
): Promise<HostToPhone> {
  const { requestId } = command;
  if (command.type === 'host-dirs') {
    const listing =
      command.create !== undefined && command.path
        ? await createHostDir(command.path, command.create)
        : await listHostDirs(command.path);
    return listing.ok
      ? {
          type: 'host-dirs-result',
          requestId,
          path: listing.path,
          parent: listing.parent,
          dirs: listing.dirs,
        }
      : { type: 'host-dirs-result', requestId, error: listing.error };
  }
  const result = deps.createProject?.({ requestId: randomUUID(), path: command.path }) ?? {
    accepted: false as const,
    error: 'Project registry is not ready.',
  };
  return result.accepted
    ? { type: 'project-add-result', requestId, projectId: result.value.projectId }
    : { type: 'project-add-result', requestId, error: result.error || 'Failed to add project.' };
}

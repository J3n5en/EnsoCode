import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app } from '@platform';
import { getSourceAuthorityRegistry } from '../../ipc/agent';
import { isSecretaryProject } from './identity';
import { isSecretaryId, SecretaryRegistry } from './registry';

/** 一个秘书在 Main 里的全部坐标：目录与隐藏项目都只由 id 推导 */
export interface SecretaryContext {
  id: string;
  dir: string;
  /** 隐藏项目还没登记（注册表未就绪）时为 null */
  projectId: string | null;
}

let registry: SecretaryRegistry | null = null;
let registryRoot = '';
const projectIds = new Map<string, string>();
const listeners = new Set<() => void>();

export function secretaryRoot(): string {
  return path.join(app.getPath('userData'), 'secretary');
}

export function secretaryRegistry(): SecretaryRegistry {
  const root = secretaryRoot();
  if (!registry || registryRoot !== root) {
    registryRoot = root;
    projectIds.clear();
    registry = new SecretaryRegistry(root, {
      now: () => Date.now(),
      randomId: () => randomUUID().replace(/-/gu, ''),
    });
  }
  return registry;
}

/** 测试用：换一个根目录的注册表并清掉项目映射 */
export function resetSecretaryRegistryForTests(next: SecretaryRegistry | null): void {
  registry = next;
  registryRoot = next ? secretaryRoot() : '';
  projectIds.clear();
}

function ensureProject(id: string): string | null {
  const known = projectIds.get(id);
  const authority = getSourceAuthorityRegistry();
  if (known && authority?.project(known)?.state === 'active') return known;
  const ensured = authority?.ensureSecretaryProject(
    path.join(secretaryRegistry().dir(id), 'workspace')
  );
  if (!ensured) return null;
  projectIds.set(id, ensured.projectId);
  return ensured.projectId;
}

/** 启动时登记每个秘书的隐藏项目：按路径幂等，重启后 projectId 不变 */
export function ensureSecretaryProjects(): void {
  for (const entry of secretaryRegistry().list()) ensureProject(entry.id);
}

export function secretaryIds(): string[] {
  return secretaryRegistry()
    .list()
    .map((entry) => entry.id);
}

export function secretaryContext(id: string): SecretaryContext | null {
  if (!isSecretaryId(id) || !secretaryRegistry().has(id)) return null;
  return { id, dir: secretaryRegistry().dir(id), projectId: ensureProject(id) };
}

export function secretaryContexts(): SecretaryContext[] {
  return secretaryIds().flatMap((id) => {
    const ctx = secretaryContext(id);
    return ctx ? [ctx] : [];
  });
}

export function secretaryIdOfProject(projectId: string | undefined): string | null {
  if (!projectId) return null;
  const ids = secretaryIds();
  for (const id of ids) {
    if (ensureProject(id) === projectId) return id;
  }
  // 只有一个秘书时，任何在用的秘书项目都只能是它的（删掉的秘书项目已标记移除）
  const project = getSourceAuthorityRegistry()?.project(projectId);
  if (ids.length === 1 && project?.state === 'active' && isSecretaryProject(project)) return ids[0];
  return null;
}

/** 秘书会话属于哪个秘书：只认 Main 的会话权威 */
export function secretaryIdOfConversation(conversationId: string): string | null {
  const authority = getSourceAuthorityRegistry();
  const conversation = authority?.conversation(conversationId);
  if (!conversation) return null;
  if (!isSecretaryProject(authority?.project(conversation.projectId))) return null;
  return secretaryIdOfProject(conversation.projectId);
}

/**
 * IPC 入参里的秘书 id：显式给了就必须是已登记的；没给时只有一个秘书才能省略，
 * 多个秘书时不猜，返回 null 由调用方报错。
 */
export function resolveSecretaryRequest(raw: unknown): SecretaryContext | null {
  if (raw !== undefined && raw !== null) {
    return typeof raw === 'string' ? secretaryContext(raw) : null;
  }
  const ids = secretaryIds();
  return ids.length === 1 ? secretaryContext(ids[0]) : null;
}

export function onSecretariesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifySecretariesChanged(): void {
  for (const listener of listeners) listener();
}

export function forgetSecretaryProject(id: string): void {
  projectIds.delete(id);
}

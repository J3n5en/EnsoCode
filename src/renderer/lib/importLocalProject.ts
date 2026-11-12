import type { Project } from '@shared/types';
import { type ProjectImportFocus, projectImportFollowUp } from '@/lib/projectDrop';
import { useSessionsStore } from '@/stores/sessions';
import { projectConversationIds } from '@/stores/sessions/pinned';
import { useSettingsStore } from '@/stores/settings';
import {
  ARCHIVED_PROJECTS_KEY,
  readSidebarOrder,
  writeSidebarOrder,
} from '@/stores/settings/sidebarOrderStorage';

const COLLAPSED_KEY = 'enso-collapsed-projects';
export const COLLAPSED_PROJECTS_EVENT = 'enso-collapsed-projects-changed';

export function readCollapsedProjects(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

export function subscribeCollapsedProjects(listener: () => void): () => void {
  window.addEventListener(COLLAPSED_PROJECTS_EVENT, listener);
  return () => window.removeEventListener(COLLAPSED_PROJECTS_EVENT, listener);
}

function writeCollapsedProjects(next: Record<string, boolean>): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(COLLAPSED_PROJECTS_EVENT));
}

function currentDefaultGroupId(): string | undefined {
  try {
    const selected = localStorage.getItem('enso-selected-project-group');
    if (!selected) return undefined;
    return useSettingsStore.getState().projectGroups.find((group) => group.id === selected)?.id;
  } catch {
    return undefined;
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function isSkippableProjectPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a directory/i.test(message) || /ENOENT|no such file/i.test(message);
}

export function isNotDirectoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a directory/i.test(message);
}

let importChain: Promise<void> = Promise.resolve();

/** Dock 打开与拖入添加共用一条串行链，避免并发导入各自新建会话。 */
export function enqueueProjectImport(task: () => Promise<void>): Promise<void> {
  importChain = importChain.then(task).catch(() => undefined);
  return importChain;
}

export type LocalProjectImport = { project: Project; focus: ProjectImportFocus };

/** 复用 addProject 权威链路并解归档/展开，不切会话；批量导入由调用方只聚焦最后一个。 */
export async function addLocalProject(
  path: string,
  groupId?: string
): Promise<LocalProjectImport | undefined> {
  const settings = useSettingsStore.getState();
  const knownIds = new Set(settings.projects.map((project) => project.id));
  const project = await settings.addProject(path, undefined, groupId ?? currentDefaultGroupId());
  if (!project) return undefined;
  const sessions = useSessionsStore.getState();
  const follow = projectImportFollowUp({
    projectId: project.id,
    knownIds,
    archivedIds: readSidebarOrder(ARCHIVED_PROJECTS_KEY),
    collapsed: readCollapsedProjects(),
    latestConversationId: projectConversationIds(
      sessions.order,
      sessions.conversations,
      project.id
    )[0],
  });
  if (!sameIds(readSidebarOrder(ARCHIVED_PROJECTS_KEY), follow.archivedIds)) {
    writeSidebarOrder(ARCHIVED_PROJECTS_KEY, follow.archivedIds);
  }
  if (JSON.stringify(readCollapsedProjects()) !== JSON.stringify(follow.collapsed)) {
    writeCollapsedProjects(follow.collapsed);
  }
  return { project, focus: follow.focus };
}

export type SelectConversation = (conversationId: string) => unknown;

export async function focusImportedProject(
  imported: LocalProjectImport,
  onSelect?: SelectConversation
): Promise<void> {
  const sessions = useSessionsStore.getState();
  if (imported.focus.kind === 'select') {
    await (onSelect ?? sessions.selectConversation)(imported.focus.conversationId);
    return;
  }
  const id = await sessions.newConversation(imported.project.id);
  if (!id) throw new Error('Failed to create a conversation for the project.');
}

/** 收尾与 Sidebar handleAddProject 一致；onSelect 传 Sidebar 封装以触发 onNavigate。 */
export async function importLocalProject(
  path: string,
  options: { groupId?: string; onSelect?: SelectConversation } = {}
): Promise<Project | undefined> {
  const imported = await addLocalProject(path, options.groupId);
  if (!imported) return undefined;
  await focusImportedProject(imported, options.onSelect);
  return imported.project;
}

import type { SecretaryState } from '@shared/types/secretary';

/** 秘书看不见、也不能接管的项目：与 Main 的 visibleProjects 同口径 */
const HIDDEN_PROJECT_KINDS = new Set(['secretary', 'scratch', 'bot-home']);

export interface TakeoverCandidate {
  archived?: boolean;
  parentId?: string;
  btwParentId?: string;
  secretaryOrigin?: unknown;
  projectId: string;
}

/** 只决定「交给秘书接管」按钮显不显示；能不能接管以 Main 的校验为准 */
export function canOfferTakeover(
  row: TakeoverCandidate | undefined,
  projectKind: string | undefined,
  secretary: Pick<SecretaryState, 'enabled' | 'profile'>
): boolean {
  if (!row || !secretary.enabled || !secretary.profile) return false;
  if (row.archived || row.parentId || row.btwParentId || row.secretaryOrigin) return false;
  if (HIDDEN_PROJECT_KINDS.has(projectKind ?? 'local')) return false;
  const visible = secretary.profile.visibleProjectIds;
  return visible === 'all' || visible.includes(row.projectId);
}

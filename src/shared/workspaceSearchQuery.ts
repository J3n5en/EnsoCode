import type { WorkspaceSearchScope } from './workspaceSearch';

export interface WorkspaceSearchQueryRequest {
  query: string;
  currentProjectId: string;
  scope: WorkspaceSearchScope;
}

export interface WorkspaceSearchQueryResult {
  hits: import('./workspaceSearch').WorkspaceSearchHit[];
}

const SCOPES = new Set<WorkspaceSearchScope>(['project', 'all', 'all-including-archived']);

export function parseWorkspaceSearchQueryRequest(
  value: unknown
): WorkspaceSearchQueryRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.query !== 'string') return null;
  if (typeof record.currentProjectId !== 'string' || record.currentProjectId.length === 0)
    return null;
  if (typeof record.scope !== 'string' || !SCOPES.has(record.scope as WorkspaceSearchScope))
    return null;
  return {
    query: record.query,
    currentProjectId: record.currentProjectId,
    scope: record.scope as WorkspaceSearchScope,
  };
}

import { queuedStartOf } from '@shared/secretary/queuedSession';
import type { PairCatalogPayload, PairCreatedSession } from '@shared/types/pair';

type CatalogEntry = PairCatalogPayload['catalog'][number];

export function patchCatalogEntry(
  catalog: CatalogEntry[],
  sessionId: string,
  patch: Partial<CatalogEntry>
): CatalogEntry[] {
  return catalog.map((entry) => (entry.id === sessionId ? { ...entry, ...patch } : entry));
}

export function upsertCatalogEntry(catalog: CatalogEntry[], entry: CatalogEntry): CatalogEntry[] {
  const index = catalog.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) return [entry, ...catalog];
  const next = catalog.slice();
  next[index] = { ...catalog[index], ...entry };
  return next;
}

export function catalogEntryFromPairSession(
  session: PairCreatedSession,
  projectName: string
): CatalogEntry {
  return {
    id: session.sessionId,
    title: '',
    projectName,
    projectId: session.projectId,
    status: 'idle',
    updatedAt: Date.now(),
    providerId: session.providerId,
    modelId: session.modelId,
    reasoningEnabled: session.reasoningEnabled,
    ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
  };
}

export function catalogQueued(
  queued: { id: string; text: string; images?: unknown[] }[] | undefined
): CatalogEntry['queued'] {
  if (!queued?.length) return undefined;
  return queued.map((item) => ({
    id: item.id,
    text: item.text,
    ...(item.images?.length ? { hasImages: true as const } : {}),
  }));
}

/** 带 queuedStart 的目录行是 queued。失败不改 status，原因放 queueFailed，旧客户端仍能显示。 */
export function catalogQueueOverride(
  row: unknown,
  position: number | undefined
):
  | { status: 'queued'; queuePosition: number }
  | { status: 'queued'; queueFailed: string }
  | undefined {
  const queued = queuedStartOf(row);
  if (!queued) return undefined;
  if (queued.failed) return { status: 'queued', queueFailed: queued.failed.error };
  return { status: 'queued', queuePosition: position ?? 1 };
}

import { estimateEntryTokens } from '../tokens.js';
import { type Entry, isObservationsRecordedEntry } from './types.js';

const SOURCE_ENTRY_TYPES = new Set(['message', 'custom_message', 'branch_summary']);

export function isSourceEntry(entry: Entry): boolean {
  return SOURCE_ENTRY_TYPES.has(entry.type);
}

export function latestCoverageIndex(entries: Entry[]): number {
  const indexes = new Map(entries.map((entry, index) => [entry.id, index]));
  let latest = -1;
  for (const entry of entries) {
    if (!isObservationsRecordedEntry(entry)) continue;
    const covered = indexes.get(entry.data.coversUpToId);
    if (covered !== undefined) latest = Math.max(latest, covered);
  }
  return latest;
}

export function rawTokensSinceObservationCoverage(entries: Entry[]): number {
  const start = latestCoverageIndex(entries) + 1;
  return entries
    .slice(start)
    .reduce((total, entry) => total + (isSourceEntry(entry) ? estimateEntryTokens(entry) : 0), 0);
}

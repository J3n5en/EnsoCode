import { computeFileHash } from './format';
import type { InMemorySnapshotStore } from './snapshots';

export function assertFreshSnapshot(
  store: InMemorySnapshotStore,
  path: string,
  tag: string,
  liveText: string
): void {
  if (store.get(path, tag) === undefined) {
    throw new Error(`hashline snapshot missing: ${path}#${tag}`);
  }
  if (computeFileHash(liveText) !== tag) {
    throw new Error(`hashline snapshot stale: ${path}#${tag}`);
  }
}

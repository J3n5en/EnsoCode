import { computeFileHash } from './format';
import { assertFreshSnapshot } from './guard';
import { applyHashlineInput, parseHashlineHeader } from './patch';
import type { InMemorySnapshotStore } from './snapshots';

export async function applyHashlineToFile(options: {
  store: InMemorySnapshotStore;
  readText: (path: string) => Promise<string>;
  writeText: (path: string, text: string) => Promise<void>;
  input: string;
}): Promise<{ path: string; previous: string; text: string; tag: string }> {
  const header = parseHashlineHeader(options.input);
  if (!header.path || !header.tag) {
    throw new Error('hashline edit requires [path#TAG] header from a prior read');
  }
  const liveText = await options.readText(header.path);
  assertFreshSnapshot(options.store, header.path, header.tag, liveText);
  const next = applyHashlineInput(liveText, options.input);
  await options.writeText(header.path, next);
  const tag = options.store.record(header.path, next);
  return { path: header.path, previous: liveText, text: next, tag: tag || computeFileHash(next) };
}

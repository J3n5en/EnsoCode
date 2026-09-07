import { computeFileHash } from './format';

export class InMemorySnapshotStore {
  private readonly versions = new Map<string, Map<string, string>>();

  record(path: string, text: string): string {
    const tag = computeFileHash(text);
    let byTag = this.versions.get(path);
    if (!byTag) {
      byTag = new Map();
      this.versions.set(path, byTag);
    }
    if (!byTag.has(tag)) byTag.set(tag, text);
    return tag;
  }

  get(path: string, tag: string): string | undefined {
    return this.versions.get(path)?.get(tag);
  }
}

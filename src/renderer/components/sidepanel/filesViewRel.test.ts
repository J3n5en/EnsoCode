import { describe, expect, it } from 'vitest';
import {
  fromPreviewKey,
  isPreviewKey,
  remapRelForRename,
  shouldCloseForDelete,
  toggleViewMode,
  toPreviewKey,
  wasPathInvalidated,
} from './filesViewRel';

describe('preview key identity', () => {
  it('round-trips a rel through toPreviewKey/fromPreviewKey', () => {
    const key = toPreviewKey('docs/readme.md');
    expect(isPreviewKey(key)).toBe(true);
    expect(fromPreviewKey(key)).toBe('docs/readme.md');
  });

  it('never collides with a real rel that happens to contain "#preview"', () => {
    const literal = 'docs/readme.md#preview';
    expect(isPreviewKey(literal)).toBe(false);
    expect(toPreviewKey('docs/readme.md')).not.toBe(literal);
  });

  it('fromPreviewKey is a no-op for non-preview keys', () => {
    expect(fromPreviewKey('docs/readme.md')).toBe('docs/readme.md');
  });
});

describe('shouldCloseForDelete', () => {
  it('matches the exact deleted rel', () => {
    expect(shouldCloseForDelete('src/a.ts', 'src/a.ts')).toBe(true);
  });

  it('matches descendants of a deleted directory', () => {
    expect(shouldCloseForDelete('src/dir/a.ts', 'src/dir')).toBe(true);
    expect(shouldCloseForDelete('src/dir/nested/b.ts', 'src/dir')).toBe(true);
  });

  it('does not match siblings with a shared prefix', () => {
    expect(shouldCloseForDelete('src/dir2/a.ts', 'src/dir')).toBe(false);
  });

  it('matches preview tabs of deleted files', () => {
    expect(shouldCloseForDelete(toPreviewKey('src/dir/a.md'), 'src/dir')).toBe(true);
    expect(shouldCloseForDelete(toPreviewKey('src/a.md'), 'src/a.md')).toBe(true);
  });
});

describe('toggleViewMode', () => {
  it('undefined (默认 source) 切到 preview', () => {
    expect(toggleViewMode(undefined)).toBe('preview');
  });

  it('source 切到 preview', () => {
    expect(toggleViewMode('source')).toBe('preview');
  });

  it('preview 切回 source', () => {
    expect(toggleViewMode('preview')).toBe('source');
  });
});

describe('wasPathInvalidated', () => {
  it('is false when no mutation happened after the epoch was captured', () => {
    const mutations = [{ epoch: 1, rel: 'src/a.ts' }];
    expect(wasPathInvalidated(mutations, 'src/a.ts', 1)).toBe(false);
  });

  it('is true when a later mutation deleted/renamed-away the exact rel', () => {
    const mutations = [{ epoch: 2, rel: 'src/a.ts' }];
    expect(wasPathInvalidated(mutations, 'src/a.ts', 1)).toBe(true);
  });

  it('is true when a later mutation affected an ancestor directory', () => {
    const mutations = [{ epoch: 2, rel: 'src/dir' }];
    expect(wasPathInvalidated(mutations, 'src/dir/a.ts', 1)).toBe(true);
  });

  it('is false for unrelated rels even after later mutations', () => {
    const mutations = [{ epoch: 2, rel: 'src/other.ts' }];
    expect(wasPathInvalidated(mutations, 'src/a.ts', 1)).toBe(false);
  });

  it('checks preview keys against their real rel', () => {
    const mutations = [{ epoch: 2, rel: 'src/a.md' }];
    expect(wasPathInvalidated(mutations, toPreviewKey('src/a.md'), 1)).toBe(true);
  });
});

describe('remapRelForRename', () => {
  it('remaps the exact renamed rel', () => {
    expect(remapRelForRename('src/a.ts', 'src/a.ts', 'src/b.ts')).toBe('src/b.ts');
  });

  it('remaps descendants of a renamed directory', () => {
    expect(remapRelForRename('src/dir/a.ts', 'src/dir', 'src/renamed')).toBe('src/renamed/a.ts');
    expect(remapRelForRename('src/dir/nested/a.ts', 'src/dir', 'src/renamed')).toBe(
      'src/renamed/nested/a.ts'
    );
  });

  it('returns null for unrelated rels', () => {
    expect(remapRelForRename('src/other.ts', 'src/dir', 'src/renamed')).toBeNull();
    expect(remapRelForRename('src/dir2/a.ts', 'src/dir', 'src/renamed')).toBeNull();
  });

  it('preserves the preview marker when remapping a preview tab', () => {
    const key = toPreviewKey('src/dir/a.md');
    const remapped = remapRelForRename(key, 'src/dir', 'src/renamed');
    expect(remapped).toBe(toPreviewKey('src/renamed/a.md'));
  });
});

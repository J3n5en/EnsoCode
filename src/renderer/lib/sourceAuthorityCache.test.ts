import type { SourceAuthorityProjection } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  noteSourceAuthorityProjection,
  readSharedSourceAuthority,
  resetSourceAuthorityCache,
} from './sourceAuthorityCache';

const proj = (projects: string[]): SourceAuthorityProjection => ({
  projects: projects.map((projectId) => ({
    projectId,
    kind: 'local' as const,
    canonicalPath: `/repo/${projectId}`,
    state: 'active' as const,
    selected: false,
    addedAt: 1,
    version: 1,
  })),
  conversations: [],
});

describe('sourceAuthorityCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    resetSourceAuthorityCache();
  });

  afterEach(() => {
    resetSourceAuthorityCache();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('并发读取共享同一请求，并在 5s TTL 内复用缓存', async () => {
    let resolveRead!: (value: SourceAuthorityProjection) => void;
    const read = vi.fn(
      () =>
        new Promise<SourceAuthorityProjection>((resolve) => {
          resolveRead = resolve;
        })
    );
    vi.stubGlobal('window', { electronAPI: { sourceAuthority: { read } } });

    const p1 = readSharedSourceAuthority();
    const p2 = readSharedSourceAuthority();
    expect(read).toHaveBeenCalledTimes(1);

    const first = proj(['p1']);
    resolveRead(first);
    expect(await p1).toEqual(first);
    expect(await p2).toEqual(first);

    expect(await readSharedSourceAuthority()).toEqual(first);
    expect(read).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    read.mockResolvedValueOnce(proj(['p2']));
    expect(await readSharedSourceAuthority()).toEqual(proj(['p2']));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('noteSourceAuthorityProjection 刷新缓存并在重置后失效', async () => {
    const read = vi.fn(async () => proj(['from-ipc']));
    vi.stubGlobal('window', { electronAPI: { sourceAuthority: { read } } });

    const pushed = proj(['pushed']);
    noteSourceAuthorityProjection(pushed);
    expect(await readSharedSourceAuthority()).toEqual(pushed);
    expect(read).not.toHaveBeenCalled();

    resetSourceAuthorityCache();
    expect(await readSharedSourceAuthority()).toEqual(proj(['from-ipc']));
    expect(read).toHaveBeenCalledTimes(1);
  });
});

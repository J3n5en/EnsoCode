import type { ProjectIconInfo } from '@shared/projectIcon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectIconsStore } from './projectIcons';

describe('useProjectIconsStore 批量加载', () => {
  beforeEach(() => {
    useProjectIconsStore.setState({ icons: {}, pending: new Set() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('同 tick 多次 ensure 合并为一次排序后的 projects.getIcons 批量请求', async () => {
    const getIcon = vi.fn();
    const getIcons = vi.fn(
      async (ids: string[]): Promise<Record<string, ProjectIconInfo>> =>
        Object.fromEntries(
          ids.map((id) => [id, { revision: `rev-${id}`, kind: 'scanned' as const }])
        )
    );
    vi.stubGlobal('window', { electronAPI: { projects: { getIcon, getIcons } } });

    const store = useProjectIconsStore.getState();
    store.ensure('proj-c');
    store.ensure('proj-a');
    store.ensure('proj-b');
    store.ensure('proj-a');

    await vi.waitFor(() => {
      expect(Object.keys(useProjectIconsStore.getState().icons)).toHaveLength(3);
    });

    expect(getIcon).not.toHaveBeenCalled();
    expect(getIcons).toHaveBeenCalledTimes(1);
    expect(getIcons).toHaveBeenCalledWith(['proj-a', 'proj-b', 'proj-c']);
    expect(useProjectIconsStore.getState().pending.size).toBe(0);
    expect(useProjectIconsStore.getState().icons['proj-b']).toEqual({
      revision: 'rev-proj-b',
      kind: 'scanned',
    });
  });

  it('已缓存的图标与未实现 getIcons 的旧 preload 退化到 getIcon', async () => {
    const getIcon = vi.fn(
      async (id: string): Promise<ProjectIconInfo> => ({ revision: `single-${id}`, kind: 'custom' })
    );
    vi.stubGlobal('window', { electronAPI: { projects: { getIcon } } });
    useProjectIconsStore.setState({
      icons: { cached: { revision: 'c', kind: 'none' } },
      pending: new Set(),
    });

    const store = useProjectIconsStore.getState();
    store.ensure('cached');
    store.ensure('proj-x');

    await vi.waitFor(() => {
      expect(useProjectIconsStore.getState().icons['proj-x']).toBeDefined();
    });

    expect(getIcon).toHaveBeenCalledTimes(1);
    expect(getIcon).toHaveBeenCalledWith('proj-x');
  });
});

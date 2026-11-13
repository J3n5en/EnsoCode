import { describe, expect, it, vi } from 'vitest';
import {
  type RendererPluginSource,
  rendererPluginKey,
  syncPluginRenderers,
} from './rendererReload';

const plugin = (
  id: string,
  version: string,
  extra: Partial<RendererPluginSource> = {}
): RendererPluginSource => ({
  id,
  version,
  build: `${id}@${version}`,
  state: 'enabled',
  renderer: 'ui.js',
  permissions: [],
  ...extra,
});

describe('syncPluginRenderers', () => {
  it('身份没变的插件不卸载也不重新加载', async () => {
    const keep = plugin('a.b', '1.0.0', { permissions: ['composer.draft'] });
    const dispose = vi.fn();
    const loaded = new Map([[keep.id, { key: rendererPluginKey(keep), dispose }]]);
    const load = vi.fn();
    await syncPluginRenderers(loaded, [keep], load, () => true);
    expect(dispose).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(loaded.get(keep.id)?.dispose).toBe(dispose);
  });

  it('同版本重新安装（安装代号变了）也重载', async () => {
    const old = plugin('a.b', '1.0.0');
    const dispose = vi.fn();
    const loaded = new Map([[old.id, { key: rendererPluginKey(old), dispose }]]);
    const load = vi.fn(async () => ({ dispose: vi.fn() }));
    await syncPluginRenderers(loaded, [{ ...old, build: 'next' }], load, () => true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it('只重载版本、渲染路径或草稿权限变了的插件，并卸掉停用或删除的', async () => {
    const same = plugin('keep.id', '1.0.0');
    const versioned = plugin('ver.id', '1.0.0');
    const renamed = plugin('path.id', '1.0.0', { renderer: 'old.js' });
    const drafted = plugin('draft.id', '1.0.0');
    const removed = plugin('gone.id', '1.0.0');
    const disabled = plugin('off.id', '1.0.0', { state: 'disabled' });
    const crashed = plugin('bad.id', '1.0.0', { state: 'crashed' });
    const headless = plugin('ui.id', '1.0.0', { renderer: undefined });
    const added = plugin('new.id', '2.0.0', { permissions: ['ui.slot'] });
    const disposeOf = new Map<string, ReturnType<typeof vi.fn>>();
    const loaded = new Map(
      [same, versioned, renamed, drafted, removed, disabled, crashed].map((item) => {
        const dispose = vi.fn();
        disposeOf.set(item.id, dispose);
        return [item.id, { key: rendererPluginKey(item), dispose }] as const;
      })
    );
    const loadedIds: string[] = [];
    await syncPluginRenderers(
      loaded,
      [
        same,
        plugin('ver.id', '1.0.1'),
        plugin('path.id', '1.0.0', { renderer: 'next.js' }),
        plugin('draft.id', '1.0.0', { permissions: ['composer.draft'] }),
        disabled,
        crashed,
        headless,
        added,
      ],
      async (item) => {
        loadedIds.push(item.id);
        return { dispose: vi.fn() };
      },
      () => true
    );
    expect(disposeOf.get(same.id)).not.toHaveBeenCalled();
    expect(disposeOf.get('ver.id')).toHaveBeenCalledOnce();
    expect(disposeOf.get('path.id')).toHaveBeenCalledOnce();
    expect(disposeOf.get('draft.id')).toHaveBeenCalledOnce();
    expect(disposeOf.get('gone.id')).toHaveBeenCalledOnce();
    expect(disposeOf.get('off.id')).toHaveBeenCalledOnce();
    expect(disposeOf.get('bad.id')).toHaveBeenCalledOnce();
    expect(loadedIds).toEqual(['ver.id', 'path.id', 'draft.id', 'new.id']);
    expect([...loaded.keys()]).toEqual(['keep.id', 'ver.id', 'path.id', 'draft.id', 'new.id']);
    expect(loaded.get('draft.id')?.key).toBe(
      rendererPluginKey(plugin('draft.id', '1.0.0', { permissions: ['composer.draft'] }))
    );
    expect(loaded.get('path.id')?.key).toContain('next.js');
  });

  it('过期的加载把新模块卸掉，不改已经登记的插件', async () => {
    const keep = plugin('keep.id', '1.0.0');
    const keepDispose = vi.fn();
    const loaded = new Map([[keep.id, { key: rendererPluginKey(keep), dispose: keepDispose }]]);
    let current = true;
    const staleDispose = vi.fn();
    await syncPluginRenderers(
      loaded,
      [keep, plugin('new.id', '1.0.0')],
      async () => {
        current = false;
        return { dispose: staleDispose };
      },
      () => current
    );
    expect(staleDispose).toHaveBeenCalledOnce();
    expect(keepDispose).not.toHaveBeenCalled();
    expect([...loaded.keys()]).toEqual(['keep.id']);
  });

  it('一个插件加载失败不影响其余插件', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = new Map<string, { key: string; dispose(): void }>();
    await syncPluginRenderers(
      loaded,
      [plugin('bad.id', '1.0.0'), plugin('ok.id', '1.0.0')],
      async (item) => {
        if (item.id === 'bad.id') throw new Error('boom');
        return { dispose: vi.fn() };
      },
      () => true
    );
    expect([...loaded.keys()]).toEqual(['ok.id']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad.id'), expect.any(Error));
    warn.mockRestore();
  });

  // 真实场景：一个插件的清理函数抛错，循环中断，其余停用插件的卸载与新插件的加载都被跳过
  it('一个插件卸载抛错不影响其余插件的卸载与加载', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = plugin('bad.id', '1.0.0');
    const gone = plugin('gone.id', '1.0.0');
    const goneDispose = vi.fn();
    const loaded = new Map<string, { key: string; dispose(): void }>([
      [
        bad.id,
        {
          key: rendererPluginKey(bad),
          dispose: () => {
            throw new Error('boom');
          },
        },
      ],
      [gone.id, { key: rendererPluginKey(gone), dispose: goneDispose }],
    ]);
    await expect(
      syncPluginRenderers(
        loaded,
        [plugin('new.id', '1.0.0')],
        async () => ({ dispose: vi.fn() }),
        () => true
      )
    ).resolves.toBeUndefined();
    expect(goneDispose).toHaveBeenCalledOnce();
    expect([...loaded.keys()]).toEqual(['new.id']);
    warn.mockRestore();
  });

  it('前面的插件卡住时，后面的插件仍然完成加载', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loaded = new Map<string, { key: string; dispose(): void }>();
    const done = syncPluginRenderers(
      loaded,
      [plugin('slow.id', '1.0.0'), plugin('fast.id', '1.0.0')],
      async (item) => {
        if (item.id === 'slow.id') await gate;
        return { dispose: vi.fn() };
      },
      () => true
    );
    await vi.waitFor(() => expect(loaded.has('fast.id')).toBe(true));
    expect(loaded.has('slow.id')).toBe(false);
    release?.();
    await done;
    expect(loaded.has('slow.id')).toBe(true);
  });

  it('并行加载期间代号过期时卸掉本次加载的模块，保留旧登记', async () => {
    const keep = plugin('keep.id', '1.0.0');
    const keepDispose = vi.fn();
    const loaded = new Map([[keep.id, { key: rendererPluginKey(keep), dispose: keepDispose }]]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    const stale = vi.fn();
    const done = syncPluginRenderers(
      loaded,
      [keep, plugin('a.id', '1.0.0'), plugin('b.id', '1.0.0')],
      async () => {
        await gate;
        return { dispose: stale };
      },
      () => current
    );
    current = false;
    release?.();
    await done;
    expect(stale).toHaveBeenCalledTimes(2);
    expect(keepDispose).not.toHaveBeenCalled();
    expect([...loaded.keys()]).toEqual(['keep.id']);
  });
});

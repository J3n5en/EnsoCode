export interface RendererPluginSource {
  id: string;
  version: string;
  build: string;
  state: string;
  renderer?: string;
  permissions: readonly string[];
}

export interface LoadedPluginRenderer {
  key: string;
  dispose(): void;
}

/** 渲染模块身份：id、安装代号、模块路径、是否带草稿权限 */
export function rendererPluginKey(plugin: RendererPluginSource): string {
  const draft = plugin.permissions.includes('composer.draft') ? '1' : '0';
  return `${plugin.id}\0${plugin.version}\0${plugin.build}\0${plugin.renderer ?? ''}\0${draft}`;
}

/**
 * 按身份对齐已加载的渲染模块。过期调用（isCurrent 变为 false）卸掉自己刚加载的模块后停止，
 * 不改动别的一代已经登记的插件。
 */
export async function syncPluginRenderers(
  loaded: Map<string, LoadedPluginRenderer>,
  plugins: readonly RendererPluginSource[],
  load: (plugin: RendererPluginSource & { renderer: string }) => Promise<{ dispose(): void }>,
  isCurrent: () => boolean
): Promise<void> {
  if (!isCurrent()) return;
  const desired = new Map<string, RendererPluginSource & { renderer: string }>();
  for (const plugin of plugins) {
    if (plugin.state === 'enabled' && plugin.renderer) {
      desired.set(plugin.id, { ...plugin, renderer: plugin.renderer });
    }
  }
  const drop: string[] = [];
  for (const [id, handle] of loaded) {
    const next = desired.get(id);
    if (!next || rendererPluginKey(next) !== handle.key) drop.push(id);
  }
  for (const id of drop) {
    loaded.get(id)?.dispose();
    loaded.delete(id);
  }
  await Promise.allSettled(
    [...desired.values()]
      .filter((plugin) => !loaded.has(plugin.id))
      .map(async (plugin) => {
        if (!isCurrent()) return;
        let handle: { dispose(): void };
        try {
          handle = await load(plugin);
        } catch (error) {
          if (!isCurrent()) return;
          console.warn(`[plugin] ${plugin.id} 渲染模块加载失败`, error);
          return;
        }
        if (!isCurrent()) {
          handle.dispose();
          return;
        }
        const key = rendererPluginKey(plugin);
        const existing = loaded.get(plugin.id);
        if (existing?.key === key) {
          handle.dispose();
          return;
        }
        existing?.dispose();
        loaded.set(plugin.id, { key, dispose: () => handle.dispose() });
      })
  );
}

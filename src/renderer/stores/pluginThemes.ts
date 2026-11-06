import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import { pluginAssetUrl } from '@shared/localImage';
import { resolveThemeAssets, resolveThemeBackground } from '@shared/theme/assets';
import { rewriteThemeCssUrls, themeCssReferencesLocalImage } from '@shared/theme/themeCss';
import { parseThemeFile } from '@shared/theme/themeFile';
import { pluginThemeKey } from '@shared/theme/themeKey';
import type { ThemeDefinition } from '@shared/theme/types';
import { create } from 'zustand';
import { decodeUtf8Base64 } from '@/plugins/viewBridge';

interface PluginThemesState {
  /** null：首轮加载还没完成，此时不能断定插件主题不存在 */
  themes: ThemeDefinition[] | null;
  /** 插件 id → 解析失败的主题说明 */
  errors: Record<string, string[]>;
}

export const usePluginThemesStore = create<PluginThemesState>(() => ({ themes: null, errors: {} }));

interface Loaded {
  themes: ThemeDefinition[];
  errors: string[];
}

async function readText(pluginId: string, rel: string): Promise<string> {
  const result = await window.electronAPI.extensionPlugins.asset(pluginId, rel);
  if (!result.ok) throw new Error(`${rel}：${result.error}`);
  return decodeUtf8Base64(result.base64);
}

async function loadPlugin(plugin: ExtensionPluginSummary): Promise<Loaded> {
  const loaded: Loaded = { themes: [], errors: [] };
  for (const contrib of plugin.themes) {
    try {
      const file = parseThemeFile(JSON.parse(await readText(plugin.id, contrib.path)));
      if (!file.ok) throw new Error(file.error);
      const { ok: _ok, assets, background, ...palettes } = file;
      const toUrl = (rel: string) => pluginAssetUrl(plugin.id, rel, plugin.build);
      let css: string | undefined;
      if (contrib.css) {
        const rawCss = await readText(plugin.id, contrib.css);
        if (themeCssReferencesLocalImage(rawCss)) throw new Error('主题 CSS 不能引用 local-image:');
        css = rewriteThemeCssUrls(rawCss, contrib.css, toUrl);
      }
      loaded.themes.push({
        id: pluginThemeKey(plugin.id, contrib.id),
        name: contrib.name,
        source: { kind: 'plugin', pluginId: plugin.id, pluginName: plugin.name },
        ...palettes,
        ...(assets ? { assets: resolveThemeAssets(assets, contrib.path, toUrl) } : {}),
        ...(background
          ? { background: resolveThemeBackground(background, contrib.path, toUrl) }
          : {}),
        ...(css !== undefined ? { css } : {}),
      });
    } catch (error) {
      loaded.errors.push(
        `${contrib.name}：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return loaded;
}

/** 安装代号随每次安装变化，同一代号的文件不会变 */
const cache = new Map<string, Promise<Loaded>>();
let started = false;
let generation = 0;

async function refresh(): Promise<void> {
  const current = ++generation;
  const plugins = await window.electronAPI.extensionPlugins.list().catch(() => []);
  const enabled = plugins.filter((p) => p.state === 'enabled' && p.themes.length > 0);
  const results = await Promise.all(
    enabled.map((plugin) => {
      const key = `${plugin.id}@${plugin.build}@${plugin.themes.map((t) => t.css ?? '').join()}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = loadPlugin(plugin);
        cache.set(key, pending);
      }
      return pending.then((loaded) => ({ id: plugin.id, ...loaded }));
    })
  );
  if (current !== generation) return;
  usePluginThemesStore.setState({
    themes: results.flatMap((result) => result.themes),
    errors: Object.fromEntries(
      results.filter((result) => result.errors.length > 0).map((r) => [r.id, r.errors])
    ),
  });
}

/** 已启用插件的主题；插件启停、安装卸载后重读 */
export function startPluginThemes(): void {
  if (started) return;
  started = true;
  window.electronAPI.extensionPlugins.onChanged(() => void refresh());
  void refresh();
}

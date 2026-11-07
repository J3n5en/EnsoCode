import type { SettingsDeepLink } from '../settingsDeepLink';
import { parsePluginInstallUrl } from './installUrl';

/** 网页唤起安装：enso://install-plugin?url=<百分号编码的 http(s) 插件地址> */
export function pluginInstallUrlFromLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'enso:' || url.hostname !== 'install-plugin') return null;
  const inner = url.searchParams.get('url');
  if (!inner) return null;
  const parsed = parsePluginInstallUrl(inner);
  return parsed.ok ? parsed.url.href : null;
}

/** Windows / Linux 冷启动或第二实例把链接放在 argv；其它参数忽略 */
export function pluginInstallUrlsFromArgv(argv: readonly string[]): string[] {
  const urls: string[] = [];
  for (const arg of argv) {
    const url = pluginInstallUrlFromLink(arg);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

export function pluginInstallSettingsLink(url: string): SettingsDeepLink {
  return { category: 'plugins', rowId: 'plugins.enso', pluginInstallUrl: url };
}

export function pluginFocusSettingsLink(pluginId: string): SettingsDeepLink {
  return { category: 'plugins', rowId: 'plugins.enso', pluginId };
}

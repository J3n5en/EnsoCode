import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 更新源，与 electron-builder.yml 的 publish 保持一致（单测守护）。
 * 只描述「从哪儿取」；渠道（latest / beta）不写进 feed，由 autoUpdater.channel / allowPrerelease 决定。
 */
export const UPDATE_FEED = {
  provider: 'github',
  owner: 'J3n5en',
  repo: 'EnsoCode',
  releaseType: 'draft',
} as const;

/** electron-builder 生成值：`${package.json name}-updater` */
const UPDATER_CACHE_DIR_NAME = 'enso-code-updater';
const APP_UPDATE_CONFIG_FILE = 'app-update.yml';

export const releasesBaseUrl = `https://github.com/${UPDATE_FEED.owner}/${UPDATE_FEED.repo}/releases`;

/**
 * electron-builder 只在 dmg/zip 等目标里写 app-update.yml，`--dir` 构建没有它，electron-updater 直接 ENOENT。
 * 正式包带配置时返回 null 不干预；缺失时写出与正式包同内容的配置并返回路径。
 */
export function ensureFallbackUpdateConfig(
  resourcesPath: string,
  fallbackDir: string
): string | null {
  if (existsSync(path.join(resourcesPath, APP_UPDATE_CONFIG_FILE))) return null;
  mkdirSync(fallbackDir, { recursive: true });
  const file = path.join(fallbackDir, APP_UPDATE_CONFIG_FILE);
  // JSON 是合法 YAML
  writeFileSync(
    file,
    `${JSON.stringify({ ...UPDATE_FEED, updaterCacheDirName: UPDATER_CACHE_DIR_NAME }, null, 2)}\n`
  );
  return file;
}

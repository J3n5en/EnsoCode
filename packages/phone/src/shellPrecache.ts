/**
 * 页面壳预缓存的构建期部分：从产物 HTML 收集壳文件、算版本、写进 sw.js 和页面。
 * 运行期逻辑在 public/sw.js（SHELL_*）和 shellUpdate.ts。
 */

export const SHELL_VERSION_META = 'enso-shell';
const VERSION_LINE = "const SHELL_VERSION = 'dev';";
const FILES_LINE = 'const SHELL_FILES = [];';

/** 页面引用的同源打包产物（入口脚本、modulepreload、样式） */
export function shellAssets(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\s(?:src|href)="(\/assets\/[^"?#]+)"/g))
    found.add(match[1] as string);
  return [...found].sort();
}

/** 壳清单：两个页面 + desk 入口依赖。精简版的包太大，不预缓存（用过一次后由 SW 留存） */
export function shellFiles(deskHtml: string): string[] {
  return ['/', '/desk', ...shellAssets(deskHtml)];
}

export function injectShellManifest(sw: string, version: string, files: string[]): string {
  if (!/^[0-9a-f]{8,64}$/.test(version)) throw new Error(`bad shell version: ${version}`);
  if (!sw.includes(VERSION_LINE) || !sw.includes(FILES_LINE))
    throw new Error('sw.js 里找不到 SHELL_VERSION / SHELL_FILES 占位');
  return sw
    .replace(VERSION_LINE, `const SHELL_VERSION = '${version}';`)
    .replace(FILES_LINE, `const SHELL_FILES = ${JSON.stringify(files)};`);
}

/** 页面记下自己是哪个版本的壳：SW 据此判断它是不是旧缓存出来的 */
export function stampShellVersion(html: string, version: string): string {
  const meta = `<meta name="${SHELL_VERSION_META}" content="${version}" />`;
  if (!html.includes('<head>')) throw new Error('页面缺少 <head>');
  return html.replace('<head>', `<head>\n    ${meta}`);
}

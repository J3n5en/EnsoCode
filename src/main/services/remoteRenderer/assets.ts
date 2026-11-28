import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import {
  encodeBase64,
  FRAME_V2_GZIP_MIN_BYTES,
  gzipRemoteJson,
  isIncompressibleMime,
  REMOTE_GZIP_MIN_CHARS,
} from '@enso/pair';

const gzipBytes = promisify(gzipCallback);

/** 浏览器 renderer 的入口：先跑 web-preload（经父页面隧道实现 window.electronAPI），再加载桌面原样产物 */
export const WEB_PRELOAD_FILE = 'web-preload.js';
const HTML_ENTRIES = new Set(['index.html']);
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

export const assetMime = (path: string): string =>
  MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

/** 只接受 renderer 产物目录内的相对路径（无 ..、无绝对路径、无反斜杠、无 NUL） */
export function normalizeAssetPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  const path = raw.split(/[?#]/, 1)[0] ?? '';
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) return null;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return path;
}

export function injectWebPreload(html: string): string {
  const tag = `<script src="./${WEB_PRELOAD_FILE}"></script>`;
  const withCsp = html.replace(/local-image:/g, 'blob:');
  return /<head[^>]*>/i.test(withCsp)
    ? withCsp.replace(/<head[^>]*>/i, (head) => `${head}\n    ${tag}`)
    : `${tag}\n${withCsp}`;
}

export interface RendererAsset {
  status: number;
  mime: string;
  body: Uint8Array;
}

const notFound = (): RendererAsset => ({
  status: 404,
  mime: 'text/plain; charset=utf-8',
  body: new TextEncoder().encode('Not found'),
});

export async function readRendererAsset(root: string, raw: string): Promise<RendererAsset> {
  const path = normalizeAssetPath(raw);
  if (!path) return notFound();
  try {
    // asar 内 realpath 可能不可用：路径已规范化（无 ..），回退原路径仍在根内；realpath 只防符号链接
    const realRoot = await realpath(root).catch(() => root);
    const candidate = join(realRoot, ...path.split('/'));
    const file = await realpath(candidate).catch(() => candidate);
    const rel = relative(realRoot, file);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return notFound();
    const data = await readFile(file);
    if (data.byteLength > MAX_ASSET_BYTES) return notFound();
    if (HTML_ENTRIES.has(path)) {
      return {
        status: 200,
        mime: assetMime(path),
        body: new TextEncoder().encode(injectWebPreload(data.toString('utf8'))),
      };
    }
    return { status: 200, mime: assetMime(path), body: new Uint8Array(data) };
  } catch {
    return notFound();
  }
}

/** 入口与 web-preload 的内容指纹：浏览器缓存按它分代，桌面升级后自动换新 */
export async function rendererBuildId(root: string, appVersion: string): Promise<string | null> {
  const hash = createHash('sha256').update(appVersion);
  for (const file of ['index.html', WEB_PRELOAD_FILE]) {
    try {
      hash.update(await readFile(join(root, file)));
    } catch {
      return null;
    }
  }
  return `${appVersion}-${hash.digest('hex').slice(0, 12)}`;
}

/** 首次加载必经的资源：入口页、web-preload 与入口页直接引用的 ./assets/*（懒加载块不算） */
export function initialAssetPaths(html: string): string[] {
  const paths = ['index.html', WEB_PRELOAD_FILE];
  for (const match of html.matchAll(/\b(?:src|href)="\.\/(assets\/[^"?#]+)"/g)) {
    const path = normalizeAssetPath(match[1] ?? '');
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

const estimates = new Map<string, Promise<number>>();

/** 首次下载的线上字节数估算（与 asset 帧同样编码，按浏览器是否接受 gzip / v2 计），按构建缓存 */
export function downloadEstimate(
  root: string,
  gzip: boolean,
  build = '',
  v2 = false
): Promise<number> {
  const key = `${root}\0${build}\0${gzip}\0${v2}`;
  const cached = build ? estimates.get(key) : undefined;
  if (cached) return cached;
  const task = (async () => {
    const entry = await readRendererAsset(root, 'index.html');
    if (entry.status !== 200) return 0;
    let total = 0;
    for (const path of initialAssetPaths(new TextDecoder().decode(entry.body))) {
      const file = await readRendererAsset(root, path);
      if (v2) {
        const rawBytes = file.body.byteLength;
        if (gzip && !isIncompressibleMime(file.mime) && rawBytes >= FRAME_V2_GZIP_MIN_BYTES) {
          const packed = await gzipBytes(file.body);
          total += Math.min(rawBytes, packed.byteLength);
        } else {
          total += rawBytes;
        }
        continue;
      }
      const json = JSON.stringify({
        type: 'asset',
        id: 0,
        status: file.status,
        mime: file.mime,
        data: encodeBase64(file.body),
      });
      total +=
        gzip && json.length >= REMOTE_GZIP_MIN_CHARS && !isIncompressibleMime(file.mime)
          ? Math.min(json.length, (await gzipRemoteJson(json)).data.length)
          : json.length;
    }
    return total;
  })().catch(() => 0);
  if (build) estimates.set(key, task);
  return task;
}

export interface BundleManifest {
  text: string;
  id: string;
}

const manifests = new Map<string, Promise<BundleManifest | null>>();

/**
 * 中继内置同一份 renderer 时手机直接从中继取：清单逐行「sha256  相对路径」按路径排序，
 * 不含入口页（宿主下发时会注入）、sourcemap 与符号链接；id 为清单的 sha256。
 * 算法须与 packages/relay-go/deskbundle.go 一致。
 */
export function bundleManifest(root: string, build: string): Promise<BundleManifest | null> {
  const key = `${root}\0${build}`;
  const cached = manifests.get(key);
  if (cached) return cached;
  const task = (async () => {
    const files: [path: string, hash: string][] = [];
    // 不用 readdir recursive：asar 内未必支持
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await walk(join(dir, entry.name), `${path}/`);
        else if (entry.isFile() && !HTML_ENTRIES.has(path) && !path.endsWith('.map')) {
          const data = await readFile(join(dir, entry.name));
          files.push([path, createHash('sha256').update(data).digest('hex')]);
        }
      }
    };
    await walk(root, '');
    if (files.length === 0) return null;
    files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const text = files.map(([path, hash]) => `${hash}  ${path}\n`).join('');
    return { text, id: createHash('sha256').update(text).digest('hex') };
  })().catch(() => null);
  manifests.set(key, task);
  return task;
}

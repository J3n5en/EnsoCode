import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { looksLikeSvg } from '@shared/imageSniff';
import { PROJECT_ICON_SCAN_MAX_BYTES } from '@shared/projectIcon';

/** ICO 是容器，老的 BMP 帧很多运行时解不了，只作最后兜底。 */
export const ICON_PATTERNS = [
  'favicon.svg',
  'favicon.png',
  'favicon-*.svg',
  'favicon-*.png',
  'favico.svg',
  'favico.png',
  'icon.svg',
  'icon.png',
  'app-icon.svg',
  'app-icon.png',
  'apple-touch-icon.png',
  'apple-touch-icon-*.png',
  'icon-*.png',
  'android-chrome-*.png',
  'safari-pinned-tab.svg',
  'mstile-*.png',
  'logo.svg',
  'logo.png',
  'favicon.ico',
  'favico.ico',
];

export const PRIORITY_DIRS = ['public', 'static', 'priv/static', 'assets', 'images', 'img'];
export const MONOREPO_PACKAGE_DIRS = ['packages', 'apps'];
export const IGNORED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.cache',
  'vendor',
  'src',
  'lib',
  'test',
  'tests',
  '__tests__',
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface LoadedProjectIcon {
  data: Buffer;
  mimeType: string;
  path: string;
  mtimeMs: number;
  bytesAreSourceFile: boolean;
}

interface ImageDimensions {
  width: number;
  height: number;
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * 扩展名会骗人：不少 favicon.ico 其实是改名的 PNG。
 * 按内容给 mime，否则客户端会按 image/x-icon 丢掉一张本来能画的图。
 */
function sniffMimeType(buffer: Buffer): string | null {
  if (isPng(buffer)) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    buffer.length >= 6 &&
    buffer.readUInt16LE(0) === 0 &&
    buffer.readUInt16LE(2) === 1 &&
    buffer.readUInt16LE(4) > 0
  ) {
    return 'image/x-icon';
  }
  return null;
}

function mimeFromName(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.ico':
      return 'image/x-icon';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function pngDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24 || !isPng(buffer)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc2) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function gifDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 10 || buffer.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function webpDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** 返回 null 表示这种格式尺寸不可测——由调用方决定按接受还是拒绝处理。 */
function measureSquare(buffer: Buffer, mimeType: string): boolean | null {
  let dimensions: ImageDimensions | null = null;
  switch (mimeType) {
    case 'image/png':
      dimensions = pngDimensions(buffer);
      break;
    case 'image/jpeg':
      dimensions = jpegDimensions(buffer);
      break;
    case 'image/gif':
      dimensions = gifDimensions(buffer);
      break;
    case 'image/webp':
      dimensions = webpDimensions(buffer);
      break;
    case 'image/x-icon':
    case 'image/svg+xml':
      return null;
    default:
      return false;
  }
  return dimensions !== null && dimensions.width === dimensions.height && dimensions.width > 0;
}

/**
 * ICO 里较大的帧通常是 PNG。原生图片组件解不了 ICO 容器，但能画 PNG，
 * 所以抽最大的 PNG 帧，按 image/png 返回。
 */
export function extractIcoPngFrame(buffer: Buffer): Buffer | null {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    return null;
  }
  const frameCount = buffer.readUInt16LE(4);
  let best: Buffer | null = null;
  let bestWidth = -1;
  for (let index = 0; index < frameCount; index += 1) {
    const entry = 6 + index * 16;
    if (entry + 16 > buffer.length) break;
    const width = buffer[entry] === 0 ? 256 : (buffer[entry] ?? 0);
    const dataSize = buffer.readUInt32LE(entry + 8);
    const dataOffset = buffer.readUInt32LE(entry + 12);
    if (dataOffset > buffer.length || dataSize > buffer.length - dataOffset) continue;
    const frame = buffer.subarray(dataOffset, dataOffset + dataSize);
    if (isPng(frame) && width > bestWidth) {
      best = Buffer.from(frame);
      bestWidth = width;
    }
  }
  return best;
}

function matchesPattern(filename: string, pattern: string): boolean {
  if (!pattern.includes('*')) return filename === pattern;
  const source = `^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`;
  return new RegExp(source).test(filename);
}

async function isFile(fullPath: string): Promise<boolean> {
  try {
    return (await stat(fullPath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(fullPath: string): Promise<boolean> {
  try {
    return (await stat(fullPath)).isDirectory();
  } catch {
    return false;
  }
}

async function findIconInDir(dir: string, patterns: readonly string[]): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const candidates: string[] = [];
  for (const pattern of patterns) {
    for (const entry of entries) {
      if (matchesPattern(entry, pattern)) candidates.push(join(dir, entry));
    }
  }
  const exists = await Promise.all(candidates.map((candidate) => isFile(candidate)));
  const index = exists.findIndex(Boolean);
  return index === -1 ? null : (candidates[index] ?? null);
}

function firstPath(results: Array<string | null>): string | null {
  return results.find((result): result is string => result !== null) ?? null;
}

async function searchDirRecursively(
  dir: string,
  patterns: readonly string[],
  ignored: ReadonlySet<string>,
  maxDepth: number,
  currentDepth = 0
): Promise<string | null> {
  if (currentDepth > maxDepth) return null;
  const found = await findIconInDir(dir, patterns);
  if (found || currentDepth === maxDepth) return found;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const children = entries.filter((entry) => !ignored.has(entry)).map((entry) => join(dir, entry));
  const isDir = await Promise.all(children.map((child) => isDirectory(child)));
  return firstPath(
    await Promise.all(
      children.map((child, index) =>
        isDir[index]
          ? searchDirRecursively(child, patterns, ignored, maxDepth, currentDepth + 1)
          : Promise.resolve(null)
      )
    )
  );
}

async function searchPriorityDirs(
  basePath: string,
  ignored: ReadonlySet<string>,
  remainingDepth: number
): Promise<string | null> {
  const paths = PRIORITY_DIRS.map((dir) => join(basePath, dir));
  const exists = await Promise.all(paths.map((dir) => isDirectory(dir)));
  return firstPath(
    await Promise.all(
      paths.map((dir, index) =>
        exists[index]
          ? searchDirRecursively(dir, ICON_PATTERNS, ignored, remainingDepth)
          : Promise.resolve(null)
      )
    )
  );
}

async function searchMonorepo(
  projectDir: string,
  ignored: ReadonlySet<string>,
  maxDepth: number
): Promise<string | null> {
  const roots = MONOREPO_PACKAGE_DIRS.map((dir) => join(projectDir, dir));
  const listings = await Promise.all(
    roots.map(async (root) => {
      try {
        return await readdir(root);
      } catch {
        return null;
      }
    })
  );
  return firstPath(
    await Promise.all(
      roots.map(async (root, index) => {
        const names = listings[index];
        if (!names) return null;
        const packages = names.map((name) => join(root, name));
        const isDir = await Promise.all(packages.map((dir) => isDirectory(dir)));
        return firstPath(
          await Promise.all(
            packages.map(async (dir, packageIndex) => {
              if (!isDir[packageIndex]) return null;
              return (
                (await searchPriorityDirs(dir, ignored, maxDepth - 1)) ??
                (await findIconInDir(dir, ICON_PATTERNS))
              );
            })
          )
        );
      })
    )
  );
}

async function scanShallow(
  dir: string,
  ignored: ReadonlySet<string>,
  priority: ReadonlySet<string>,
  depth = 0
): Promise<string | null> {
  if (depth > 2) return null;
  const found = await findIconInDir(dir, ICON_PATTERNS);
  if (found || depth === 2) return found;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const children = entries
    .filter((entry) => !ignored.has(entry) && !priority.has(entry))
    .map((entry) => join(dir, entry));
  const isDir = await Promise.all(children.map((child) => isDirectory(child)));
  return firstPath(
    await Promise.all(
      children.map((child, index) =>
        isDir[index] ? scanShallow(child, ignored, priority, depth + 1) : Promise.resolve(null)
      )
    )
  );
}

export async function findProjectIcon(projectDir: string, maxDepth = 3): Promise<string | null> {
  if (!projectDir) return null;
  const ignored = new Set(IGNORED_DIRS);
  const priority = await searchPriorityDirs(projectDir, ignored, maxDepth - 1);
  if (priority) return priority;
  const mono = await searchMonorepo(projectDir, ignored, maxDepth);
  if (mono) return mono;
  return scanShallow(projectDir, ignored, new Set(PRIORITY_DIRS));
}

export async function loadProjectIcon(projectDir: string): Promise<LoadedProjectIcon | null> {
  const iconPath = await findProjectIcon(projectDir);
  if (!iconPath) return null;
  try {
    const info = await stat(iconPath);
    if (!info.isFile() || info.size > PROJECT_ICON_SCAN_MAX_BYTES) return null;
    const fileBuffer = await readFile(iconPath);
    let mimeType = sniffMimeType(fileBuffer) ?? mimeFromName(iconPath);
    let buffer: Buffer = fileBuffer;
    if (mimeType === 'image/x-icon') {
      const pngFrame = extractIcoPngFrame(fileBuffer);
      if (pngFrame) {
        buffer = pngFrame;
        mimeType = 'image/png';
      }
    }
    if (mimeType === 'image/svg+xml' && !looksLikeSvg(buffer)) return null;
    // 非方形会进圆形遮罩被拉变形，拒绝；svg/ico 尺寸不可测，按方形接受。
    if (measureSquare(buffer, mimeType) === false) return null;
    return {
      data: buffer,
      mimeType,
      path: iconPath,
      mtimeMs: info.mtimeMs,
      bytesAreSourceFile: buffer.equals(fileBuffer),
    };
  } catch {
    return null;
  }
}

export async function getProjectIcon(
  projectDir: string
): Promise<{ data: Buffer; mimeType: string } | null> {
  const loaded = await loadProjectIcon(projectDir);
  return loaded ? { data: loaded.data, mimeType: loaded.mimeType } : null;
}

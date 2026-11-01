import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export interface ExtractZipOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEntryBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_EXTRA_ID = 0x0001;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const MADE_BY_UNIX = 3;
const MAX_LINK_TARGET_BYTES = 1024;

interface CentralEntry {
  name: string;
  madeBy: number;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttrs: number;
}

interface PlannedEntry {
  entry: CentralEntry;
  isDir: boolean;
  isLink: boolean;
  target: string;
}

export async function extractZip(
  zipPath: string,
  destDir: string,
  options?: ExtractZipOptions
): Promise<void> {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryBytes = options?.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const buf = await readZip(zipPath);
  const root = path.resolve(destDir);
  const plan = planEntries(
    readCentralDirectory(buf, maxEntries),
    root,
    maxEntryBytes,
    maxTotalBytes
  );
  const links: { path: string; target: string }[] = [];
  for (const item of plan) {
    if (!item.isLink) continue;
    const data = readEntryBytes(buf, item.entry);
    const label = entryLabel(item.entry.name);
    const target = data.toString('utf8');
    if (!Buffer.from(target, 'utf8').equals(data)) throw new Error(`符号链接越界：${label}`);
    assertContainedLinkTarget(root, item.target, target, label);
    links.push({ path: item.target, target });
  }

  await mkdir(root, { recursive: true });
  for (const item of plan) {
    if (item.isLink) continue;
    const data = readEntryBytes(buf, item.entry);
    if (item.isDir) {
      await mkdir(item.target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(item.target), { recursive: true });
    await writeFile(item.target, data, { mode: isExecutable(item.entry) ? 0o755 : 0o644 });
  }
  for (const link of links) {
    await mkdir(path.dirname(link.path), { recursive: true });
    await symlink(link.target, link.path);
  }
}

function isExecutable(entry: CentralEntry): boolean {
  return entry.madeBy >>> 8 === MADE_BY_UNIX && ((entry.externalAttrs >>> 16) & 0o111) !== 0;
}

async function readZip(zipPath: string): Promise<Buffer> {
  try {
    return await readFile(zipPath);
  } catch {
    throw new Error('无法读取压缩包');
  }
}

function findEocd(buf: Buffer): number {
  if (buf.length < 22) throw new Error('不是有效的 ZIP 文件');
  const minStart = Math.max(0, buf.length - (22 + 0xffff));
  for (let offset = buf.length - 22; offset >= minStart; offset -= 1) {
    if (buf.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = buf.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buf.length) return offset;
  }
  throw new Error('不是有效的 ZIP 文件');
}

function readCentralDirectory(buf: Buffer, maxEntries: number): CentralEntry[] {
  const eocd = findEocd(buf);
  const diskNumber = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (
    diskNumber === 0xffff ||
    cdDisk === 0xffff ||
    entriesOnDisk === 0xffff ||
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new Error('不支持 ZIP64 压缩包');
  }
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error('不支持分卷压缩包');
  }
  if (totalEntries > maxEntries) throw new Error('压缩包条目过多');
  if (cdOffset > eocd || cdSize > eocd - cdOffset) throw new Error('压缩包已损坏');

  const entries: CentralEntry[] = [];
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > cdEnd || buf.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error('压缩包已损坏');
    }
    const madeBy = buf.readUInt16LE(cursor + 4);
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const externalAttrs = buf.readUInt32LE(cursor + 38);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error('不支持 ZIP64 压缩包');
    }

    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > cdEnd) throw new Error('压缩包已损坏');
    assertNoZip64Extra(buf, extraStart, extraStart + extraLength);
    entries.push({
      name: buf.toString('utf8', nameStart, extraStart),
      madeBy,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttrs,
    });
    cursor = next;
  }
  return entries;
}

function assertNoZip64Extra(buf: Buffer, start: number, end: number): void {
  let cursor = start;
  while (cursor + 4 <= end) {
    const id = buf.readUInt16LE(cursor);
    const size = buf.readUInt16LE(cursor + 2);
    const next = cursor + 4 + size;
    if (next > end) throw new Error('压缩包已损坏');
    if (id === ZIP64_EXTRA_ID) throw new Error('不支持 ZIP64 压缩包');
    cursor = next;
  }
}

function planEntries(
  entries: CentralEntry[],
  root: string,
  maxEntryBytes: number,
  maxTotalBytes: number
): PlannedEntry[] {
  let total = 0;
  const planned: PlannedEntry[] = [];
  for (const entry of entries) {
    if ((entry.flags & 0x1) !== 0) throw new Error('不支持加密的压缩条目');
    if (entry.method !== 0 && entry.method !== 8) throw new Error('不支持的压缩方法');
    const isLink = ((entry.externalAttrs >>> 16) & S_IFMT) === S_IFLNK;
    if (entry.uncompressedSize > maxEntryBytes) {
      throw new Error(`压缩包单个条目超过大小限制：${entry.name}`);
    }
    if (isLink && entry.uncompressedSize > MAX_LINK_TARGET_BYTES) {
      throw new Error(`符号链接越界：${entryLabel(entry.name)}`);
    }
    if (total > maxTotalBytes - entry.uncompressedSize) {
      throw new Error('压缩包解压后总大小超过限制');
    }
    total += entry.uncompressedSize;
    const located = locateEntry(root, entry.name);
    planned.push({
      entry,
      isDir: located.isDir && !isLink,
      isLink,
      target: located.target,
    });
  }
  assertLinkLayout(root, planned);
  return planned;
}

export function assertContainedLinkTarget(
  root: string,
  linkPath: string,
  target: string,
  label: string
): void {
  const linkDir = path.resolve(path.dirname(linkPath));
  const resolved = path.resolve(linkDir, target);
  if (
    !isSafeRelativeTarget(target) ||
    !isInside(root, linkDir) ||
    !isInside(root, resolved) ||
    !staysWithin(root, linkDir, target)
  ) {
    throw new Error(`符号链接越界：${label}`);
  }
}

function isSafeRelativeTarget(target: string): boolean {
  if (target.length === 0 || Buffer.byteLength(target) > MAX_LINK_TARGET_BYTES) return false;
  if (target.includes('\0') || target.includes('\\')) return false;
  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) return false;
  return target.split('/').every((segment) => !/^[A-Za-z]:/.test(segment));
}

/** 逐段解析，中途不能离开 root。避免 ../<根目录名>/... 在目录改名后爬出去。 */
function staysWithin(root: string, linkDir: string, target: string): boolean {
  let current = linkDir;
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const parent = path.dirname(current);
      if (parent === current || !isInside(root, parent)) return false;
      current = parent;
      continue;
    }
    current = path.join(current, segment);
  }
  return isInside(root, current);
}

function assertLinkLayout(root: string, planned: PlannedEntry[]): void {
  const relOf = (item: PlannedEntry) => path.relative(root, item.target).split(path.sep).join('/');
  const seen = new Map<string, boolean>();
  for (const item of planned) {
    const rel = relOf(item);
    const previous = seen.get(rel);
    if (previous !== undefined && (previous || item.isLink)) {
      throw new Error(`符号链接路径冲突：${entryLabel(item.entry.name)}`);
    }
    if (previous === undefined) seen.set(rel, item.isLink);
  }
  const links = new Set(planned.filter((item) => item.isLink).map(relOf));
  for (const item of planned) {
    const parts = relOf(item).split('/');
    let prefix = '';
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      if (part === undefined) continue;
      prefix = prefix.length === 0 ? part : `${prefix}/${part}`;
      if (links.has(prefix)) throw new Error(`符号链接路径冲突：${entryLabel(item.entry.name)}`);
    }
  }
}

function entryLabel(name: string): string {
  return name.endsWith('/') ? name.slice(0, -1) : name;
}

function locateEntry(root: string, name: string): { isDir: boolean; target: string } {
  if (name.includes('\\')) throw new Error('压缩包条目名包含反斜杠');
  if (name.includes('\0')) throw new Error('压缩包条目名包含空字符');
  if (name.startsWith('/')) throw new Error('压缩包条目是绝对路径');

  const isDir = name.endsWith('/');
  const body = isDir ? name.slice(0, -1) : name;
  if (body.length === 0) throw new Error('压缩包条目名包含空路径段');
  const segments = body.split('/');
  for (const segment of segments) {
    if (segment.length === 0) throw new Error('压缩包条目名包含空路径段');
    if (segment === '..') throw new Error('压缩包条目名包含上级目录');
    if (/^[A-Za-z]:/.test(segment)) throw new Error('压缩包条目包含盘符');
  }

  const target = path.resolve(root, ...segments);
  if (!isInside(root, target) || (!isDir && target === root)) {
    throw new Error('压缩包条目路径越界');
  }
  return { isDir, target };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative.split(path.sep).every((part) => part !== '..');
}

function readEntryBytes(buf: Buffer, entry: CentralEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
    throw new Error('压缩包已损坏');
  }
  if ((buf.readUInt16LE(offset + 6) & 0x1) !== 0) throw new Error('不支持加密的压缩条目');

  const nameLength = buf.readUInt16LE(offset + 26);
  const extraLength = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < offset || dataEnd < dataStart || dataEnd > buf.length) {
    throw new Error('压缩包已损坏');
  }

  const compressed = buf.subarray(dataStart, dataEnd);
  if (entry.method === 0) {
    if (compressed.length !== entry.uncompressedSize) {
      throw new Error('条目解压后大小与声明不一致');
    }
    return Buffer.from(compressed);
  }
  return inflateDeflate(compressed, entry.uncompressedSize);
}

function inflateDeflate(compressed: Buffer, declared: number): Buffer {
  let out: Buffer;
  try {
    out = inflateRawSync(compressed, { maxOutputLength: declared === 0 ? 1 : declared });
  } catch (err) {
    if (errorCode(err) === 'ERR_BUFFER_TOO_LARGE') throw new Error('条目解压后大小与声明不一致');
    throw new Error('压缩包条目解压失败');
  }
  if (out.length !== declared) throw new Error('条目解压后大小与声明不一致');
  return out;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

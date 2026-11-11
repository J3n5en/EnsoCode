import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { parseExtensionPluginManifest } from '@shared/extensionPlugins/manifest';

export interface PackedPlugin {
  file: string;
  sha256: string;
  size: number;
  id: string;
  version: string;
}

/** DOS 日期 1980-01-01，固定时间戳才能让同内容得到同哈希。 */
const DOS_EPOCH = 0x21;
const ZIP_VERSION = 20;
const DEFLATE = 8;
const UTF8 = 0x800;

function readManifest(dir: string, hostVersion: string) {
  const path = join(dir, 'enso-plugin.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) throw new Error('找不到清单 enso-plugin.json');
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('清单不是合法 JSON');
  }
  const parsed = parseExtensionPluginManifest(raw, hostVersion);
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.manifest;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function collect(root: string): string[] {
  const names: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test') continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith('.zip')) continue;
      if (dir === root && entry.name === 'enso-testing.mjs') continue;
      names.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names;
}

function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_EPOCH, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_EPOCH, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDir, eocd]);
}

export function packPlugin(dir: string, opts: { hostVersion: string; out?: string }): PackedPlugin {
  const root = resolve(dir);
  const manifest = readManifest(root, opts.hostVersion);
  const bytes = buildZip(
    collect(root).map((name) => ({
      name,
      data: readFileSync(join(root, ...name.split('/'))),
    }))
  );
  const file = opts.out
    ? resolve(opts.out)
    : join(dirname(root), `${manifest.id}-${manifest.version}.zip`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return {
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    id: manifest.id,
    version: manifest.version,
  };
}

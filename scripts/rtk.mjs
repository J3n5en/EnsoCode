import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const VERSION = '0.49.0';
const BASE_URL = `https://github.com/rtk-ai/rtk/releases/download/v${VERSION}`;
const TARGETS = new Map([
  ['darwin-arm64', ['rtk-aarch64-apple-darwin.tar.gz', 'rtk']],
  ['darwin-x64', ['rtk-x86_64-apple-darwin.tar.gz', 'rtk']],
  ['linux-arm64', ['rtk-aarch64-unknown-linux-gnu.tar.gz', 'rtk']],
  ['linux-x64', ['rtk-x86_64-unknown-linux-musl.tar.gz', 'rtk']],
  ['win32-x64', ['rtk-x86_64-pc-windows-msvc.zip', 'rtk.exe']],
]);
const SHA256 = /^[a-f0-9]{64}$/;

function targetKey(platform, arch) {
  const key = `${platform}-${arch}`;
  if (!TARGETS.has(key)) throw new Error(`Unsupported RTK target: ${key}`);
  return key;
}

export function parseManifest(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid RTK manifest');
  if (value.schemaVersion !== 1) throw new Error('Invalid RTK manifest schema');
  if (value.version !== VERSION) throw new Error(`Invalid RTK manifest version: ${value.version}`);
  if (value.baseUrl !== BASE_URL) throw new Error('Invalid RTK manifest base URL');
  if (value.license !== 'Apache-2.0') throw new Error('Invalid RTK manifest license');
  if (!value.targets || typeof value.targets !== 'object') {
    throw new Error('Invalid RTK manifest targets');
  }
  for (const [key, target] of Object.entries(value.targets)) {
    const expected = TARGETS.get(key);
    if (!expected || !target || typeof target !== 'object') {
      throw new Error(`Invalid RTK manifest target: ${key}`);
    }
    if (target.asset !== expected[0] || target.executable !== expected[1]) {
      throw new Error(`Invalid RTK manifest asset: ${key}`);
    }
    if (!SHA256.test(target.sha256) || !SHA256.test(target.binarySha256)) {
      throw new Error(`Invalid SHA-256 for RTK target: ${key}`);
    }
  }
  return value;
}

export function targetFor(manifest, platform, arch) {
  const key = targetKey(platform, arch);
  const target = manifest.targets[key];
  if (!target) throw new Error(`Missing RTK manifest target: ${key}`);
  return { key, ...target };
}

export function resourceBinaryPath(root, platform, arch) {
  const key = targetKey(platform, arch);
  return path.join(root, 'resources', 'rtk', key, platform === 'win32' ? 'rtk.exe' : 'rtk');
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function extractTarGz(archive, executable) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const start = offset + 512;
    if (!Number.isSafeInteger(size) || size < 0 || start + size > tar.length) {
      throw new Error('Invalid RTK tar archive');
    }
    if (path.posix.basename(name) === executable) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`RTK archive does not contain ${executable}`);
}

function extractZip(archive, executable) {
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Invalid RTK zip archive');
  const entries = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid RTK zip directory');
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (path.posix.basename(name) === executable) {
      if (archive.readUInt32LE(localOffset) !== 0x04034b50)
        throw new Error('Invalid RTK zip entry');
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(start, start + compressedSize);
      const binary = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (!binary || binary.length !== uncompressedSize) {
        throw new Error('Unsupported or invalid RTK zip entry');
      }
      return binary;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`RTK archive does not contain ${executable}`);
}

function extractBinary(archive, target) {
  return target.asset.endsWith('.zip')
    ? extractZip(archive, target.executable)
    : extractTarGz(archive, target.executable);
}

async function fileSha256(file) {
  try {
    return sha256(await readFile(file));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadManifest(root) {
  const file = path.join(root, 'resources', 'rtk', 'manifest.json');
  return parseManifest(JSON.parse(await readFile(file, 'utf8')));
}

export async function prepareRtk({
  root,
  platform = process.platform,
  arch = process.arch,
  manifest,
  fetchImpl = globalThis.fetch,
  downloadTimeoutMs = 60_000,
}) {
  const checkedManifest = manifest ? parseManifest(manifest) : await loadManifest(root);
  const target = targetFor(checkedManifest, platform, arch);
  const destination = resourceBinaryPath(root, platform, arch);
  if ((await fileSha256(destination)) === target.binarySha256) return destination;

  await rm(destination, { force: true });
  let response;
  try {
    response = await fetchImpl(`${checkedManifest.baseUrl}/${target.asset}`, {
      signal: AbortSignal.timeout(downloadTimeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new Error(`Timed out downloading RTK ${target.asset} after ${downloadTimeoutMs}ms`, {
        cause: error,
      });
    }
    throw new Error(`Failed to download RTK ${target.asset}: ${error?.message ?? String(error)}`, {
      cause: error,
    });
  }
  if (!response.ok)
    throw new Error(`Failed to download RTK ${target.asset}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actualArchiveSha = sha256(archive);
  if (actualArchiveSha !== target.sha256) {
    throw new Error(
      `RTK archive SHA-256 mismatch: expected ${target.sha256}, got ${actualArchiveSha}`
    );
  }

  const binary = extractBinary(archive, target);
  const actualBinarySha = sha256(binary);
  if (actualBinarySha !== target.binarySha256) {
    throw new Error(
      `RTK binary SHA-256 mismatch: expected ${target.binarySha256}, got ${actualBinarySha}`
    );
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, binary, { mode: 0o755 });
    if (platform !== 'win32') await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

export async function copyRtkDistribution(root, destination, platform, arch) {
  const binary = await prepareRtk({ root, platform, arch });
  const executable = platform === 'win32' ? 'rtk.exe' : 'rtk';
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await Promise.all([
    copyFile(binary, path.join(destination, executable)),
    copyFile(path.join(root, 'resources', 'rtk', 'LICENSE'), path.join(destination, 'LICENSE')),
    copyFile(path.join(root, 'resources', 'rtk', 'NOTICE'), path.join(destination, 'NOTICE')),
    copyFile(
      path.join(root, 'resources', 'rtk', 'manifest.json'),
      path.join(destination, 'manifest.json')
    ),
  ]);
  if (platform !== 'win32') await chmod(path.join(destination, executable), 0o755);
  return path.join(destination, executable);
}

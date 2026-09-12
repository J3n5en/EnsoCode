import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

/** 安装包必须排除的 glob，与 electron-builder.yml 同步。不含 node-llama-cpp 本体。 */
export const ELECTRON_BUILDER_GPU_EXCLUDES = [
  '!node_modules/@node-llama-cpp/**',
  '!node_modules/.pnpm/@node-llama-cpp+*/**',
] as const;

const READY_MARKER = '.ready';
const TAR_BLOCK = 512;

export function selectGpuBackendPackage(input: {
  platform: string;
  arch: string;
  supportedGpus: readonly (string | boolean)[];
}): { name: string } | null {
  const os =
    input.platform === 'darwin' || input.platform === 'mac'
      ? 'mac'
      : input.platform === 'win32' || input.platform === 'win'
        ? 'win'
        : input.platform === 'linux'
          ? 'linux'
          : null;
  if (!os) return null;
  if (os === 'mac') {
    if (input.arch === 'arm64') return { name: '@node-llama-cpp/mac-arm64-metal' };
    if (input.arch === 'x64') return { name: '@node-llama-cpp/mac-x64' };
    return null;
  }
  const gpu = input.supportedGpus.includes('cuda')
    ? 'cuda'
    : input.supportedGpus.includes('vulkan')
      ? 'vulkan'
      : false;
  if (os === 'linux') {
    if (input.arch === 'x64') {
      if (gpu === 'cuda') return { name: '@node-llama-cpp/linux-x64-cuda' };
      if (gpu === 'vulkan') return { name: '@node-llama-cpp/linux-x64-vulkan' };
      return { name: '@node-llama-cpp/linux-x64' };
    }
    if (input.arch === 'arm64') return { name: '@node-llama-cpp/linux-arm64' };
    if (input.arch === 'arm') return { name: '@node-llama-cpp/linux-armv7l' };
    if (input.arch === 'riscv64') return { name: '@node-llama-cpp/linux-riscv64' };
    return null;
  }
  if (input.arch === 'x64') {
    if (gpu === 'cuda') return { name: '@node-llama-cpp/win-x64-cuda' };
    if (gpu === 'vulkan') return { name: '@node-llama-cpp/win-x64-vulkan' };
    return { name: '@node-llama-cpp/win-x64' };
  }
  if (input.arch === 'arm64') return { name: '@node-llama-cpp/win-arm64' };
  return null;
}

export function gpuBackendInstallDir(root: string, name: string, version: string): string {
  if (!name || name.includes('..') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`package escapes backend root: ${name}`);
  }
  assertSegment(version, 'version');
  const id = name.split('/').pop() ?? '';
  assertSegment(id, 'package id');
  const dest = path.resolve(root, `${id}@${version}`);
  const base = path.resolve(root);
  if (dest !== base && !dest.startsWith(base + path.sep)) {
    throw new Error(`gpu backend path escapes install root: ${name}@${version}`);
  }
  return dest;
}

export function isGpuBackendReady(dir: string): boolean {
  return fs.existsSync(path.join(dir, READY_MARKER)) && hasLlamaAddon(dir);
}

export function hasLlamaAddon(root: string): boolean {
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const next = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(next);
      else if (entry.name === 'llama-addon.node') return true;
    }
  }
  return false;
}

export function npmPackumentUrl(registry: string, name: string): string {
  return `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2f')}`;
}

export function verifyIntegrity(body: Buffer, integrity: string): void {
  const match = /^sha512-(.+)$/.exec(integrity);
  if (!match) throw new Error(`unsupported integrity: ${integrity}`);
  const actual = createHash('sha512').update(body).digest('base64');
  if (actual !== match[1]) throw new Error('gpu backend tarball integrity mismatch');
}

export function extractNpmPackageBins(tgz: Buffer, dest: string): void {
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    unpackPackageTar(gunzipSync(tgz), tmp);
    if (!hasLlamaAddon(tmp)) throw new Error('gpu backend tarball missing llama-addon.node');
    fs.writeFileSync(path.join(tmp, READY_MARKER), new Date().toISOString());
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

function assertSegment(value: string, label: string): void {
  if (
    !value ||
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${label} escapes backend root: ${value}`);
  }
}

function unpackPackageTar(tar: Buffer, dest: string): void {
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    offset += TAR_BLOCK;
    if (header.every((byte) => byte === 0)) break;
    const name = tarName(header);
    const size = parseInt(readOctal(header.subarray(124, 136)), 8) || 0;
    const type = String.fromCharCode(header[156] ?? 0);
    const dataEnd = offset + size;
    const data = tar.subarray(offset, dataEnd);
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (!name.startsWith('package/')) continue;
    const rel = name.slice('package/'.length);
    if (!rel || rel.endsWith('/')) continue;
    if (type !== '0' && type !== '\0' && type !== '') continue;
    const out = safeJoin(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
}

function tarName(header: Buffer): string {
  const prefix = cString(header.subarray(345, 500));
  const name = cString(header.subarray(0, 100));
  return prefix ? `${prefix}/${name}` : name;
}

function cString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf
    .subarray(0, end === -1 ? buf.length : end)
    .toString('utf8')
    .trim();
}

function readOctal(buf: Buffer): string {
  return buf.toString('utf8').replace(/\0/g, '').trim();
}

function safeJoin(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`gpu backend path escapes install dir: ${rel}`);
  }
  return resolved;
}

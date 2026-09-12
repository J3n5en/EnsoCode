import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ELECTRON_BUILDER_GPU_EXCLUDES,
  extractNpmPackageBins,
  gpuBackendInstallDir,
  isGpuBackendReady,
  npmPackumentUrl,
  selectGpuBackendPackage,
  verifyIntegrity,
} from './gpuBackend';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-llama-gpu-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('selectGpuBackendPackage', () => {
  it('does not download on macOS — Metal is already bundled', () => {
    expect(
      selectGpuBackendPackage({
        platform: 'darwin',
        arch: 'arm64',
        supportedGpus: ['metal'],
      })
    ).toBeNull();
    expect(
      selectGpuBackendPackage({
        platform: 'darwin',
        arch: 'x64',
        supportedGpus: ['cuda'],
      })
    ).toBeNull();
  });

  it('picks CUDA over Vulkan on linux/win x64', () => {
    expect(
      selectGpuBackendPackage({
        platform: 'linux',
        arch: 'x64',
        supportedGpus: ['cuda', 'vulkan', false],
      })
    ).toEqual({ name: '@node-llama-cpp/linux-x64-cuda' });
    expect(
      selectGpuBackendPackage({
        platform: 'win32',
        arch: 'x64',
        supportedGpus: ['cuda', 'vulkan'],
      })
    ).toEqual({ name: '@node-llama-cpp/win-x64-cuda' });
  });

  it('falls back to Vulkan when CUDA is absent', () => {
    expect(
      selectGpuBackendPackage({
        platform: 'linux',
        arch: 'x64',
        supportedGpus: ['vulkan', false],
      })
    ).toEqual({ name: '@node-llama-cpp/linux-x64-vulkan' });
  });

  it('stays on the bundled CPU binary when no GPU is present', () => {
    expect(
      selectGpuBackendPackage({
        platform: 'linux',
        arch: 'x64',
        supportedGpus: [false],
      })
    ).toBeNull();
  });

  it('does not fetch extra-arch GPU packages', () => {
    expect(
      selectGpuBackendPackage({
        platform: 'linux',
        arch: 'arm64',
        supportedGpus: ['cuda'],
      })
    ).toBeNull();
  });
});

describe('gpuBackendInstallDir', () => {
  it('nests the package id and version under the root', () => {
    expect(gpuBackendInstallDir(dir, '@node-llama-cpp/linux-x64-cuda', '3.20.0')).toBe(
      path.join(dir, 'linux-x64-cuda@3.20.0')
    );
  });

  it('rejects names that would escape the root', () => {
    expect(() => gpuBackendInstallDir(dir, '@node-llama-cpp/../etc', '1')).toThrow(/escapes/);
    expect(() => gpuBackendInstallDir(dir, '@node-llama-cpp/linux-x64-cuda', '../x')).toThrow(
      /escapes/
    );
  });
});

describe('isGpuBackendReady', () => {
  it('requires a ready marker and a native addon', () => {
    const dest = path.join(dir, 'linux-x64-cuda@3.20.0');
    mkdirSync(dest, { recursive: true });
    expect(isGpuBackendReady(dest)).toBe(false);
    writeFileSync(path.join(dest, '.ready'), 'ok');
    expect(isGpuBackendReady(dest)).toBe(false);
  });

  it('is true only when bins contain llama-addon.node and .ready', () => {
    const dest = path.join(dir, 'pkg');
    const addon = path.join(dest, 'bins', 'linux-x64-cuda', 'llama-addon.node');
    mkdirSync(path.dirname(addon), { recursive: true });
    writeFileSync(addon, 'fake');
    expect(isGpuBackendReady(dest)).toBe(false);
    writeFileSync(path.join(dest, '.ready'), 'ok');
    expect(isGpuBackendReady(dest)).toBe(true);
  });
});

describe('extractNpmPackageBins', () => {
  it('extracts package contents and writes a ready marker', () => {
    const dest = path.join(dir, 'out');
    const tgz = makeTgz({
      'package/package.json': '{"name":"x"}',
      'package/bins/linux-x64-cuda/llama-addon.node': 'addon',
      'package/bins/linux-x64-cuda/_nlcBuildMetadata.json': '{}',
      'package/dist/index.js': 'export function getBinsDir() {}',
      'README.md': 'skip me',
    });
    extractNpmPackageBins(tgz, dest);
    expect(readFileSync(path.join(dest, 'bins/linux-x64-cuda/llama-addon.node'), 'utf8')).toBe(
      'addon'
    );
    expect(readFileSync(path.join(dest, 'dist/index.js'), 'utf8')).toContain('getBinsDir');
    expect(existsSync(path.join(dest, 'README.md'))).toBe(false);
    expect(isGpuBackendReady(dest)).toBe(true);
  });

  it('rejects tar entries that escape package/', () => {
    const dest = path.join(dir, 'out');
    const tgz = makeTgz({
      'package/bins/linux-x64-cuda/llama-addon.node': 'ok',
      'package/bins/../../evil.node': 'nope',
    });
    expect(() => extractNpmPackageBins(tgz, dest)).toThrow(/escapes/);
    expect(existsSync(path.join(dir, 'evil.node'))).toBe(false);
    expect(isGpuBackendReady(dest)).toBe(false);
  });
});

describe('npmPackumentUrl', () => {
  it('encodes the scoped name against the registry', () => {
    expect(npmPackumentUrl('https://registry.npmjs.org', '@node-llama-cpp/linux-x64-cuda')).toBe(
      'https://registry.npmjs.org/@node-llama-cpp%2flinux-x64-cuda'
    );
  });
});

describe('verifyIntegrity', () => {
  it('accepts a matching sha512 and rejects a mismatch', () => {
    const body = Buffer.from('hello-gpu');
    const digest = createHash('sha512').update(body).digest('base64');
    expect(() => verifyIntegrity(body, `sha512-${digest}`)).not.toThrow();
    expect(() => verifyIntegrity(body, 'sha512-aaaaaaaa')).toThrow(/integrity/);
  });
});

describe('electron-builder GPU excludes', () => {
  it('keeps CUDA/Vulkan llama backends out of the installer', () => {
    const yml = readFileSync(path.resolve(__dirname, '../../../../electron-builder.yml'), 'utf8');
    for (const glob of ELECTRON_BUILDER_GPU_EXCLUDES) {
      expect(yml).toContain(glob);
    }
  });
});

/** ustar + gzip，只够覆盖 extract 的正向与越界路径 */
function makeTgz(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(`${data.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    let checksum = 0;
    header.fill(0x20, 148, 156);
    for (const b of header) checksum += b;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

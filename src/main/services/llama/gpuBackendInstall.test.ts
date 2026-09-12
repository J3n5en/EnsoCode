import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isGpuBackendReady } from './gpuBackend';
import { ensureGpuBackend, hasPackagedAddon } from './gpuBackendInstall';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-llama-gpu-install-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureGpuBackend', () => {
  it('does nothing on macOS', async () => {
    const detectGpus = vi.fn(async () => ['metal']);
    const fetchImpl = vi.fn();
    await ensureGpuBackend({
      platform: 'darwin',
      arch: 'arm64',
      root: dir,
      detectGpus,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(detectGpus).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips download when the packaged optional binary is already present', async () => {
    const fetchImpl = vi.fn();
    await ensureGpuBackend({
      platform: 'linux',
      arch: 'x64',
      root: dir,
      detectGpus: async () => ['cuda'],
      hasPackagedAddon: () => true,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('downloads and extracts the CUDA package when GPU is present', async () => {
    const resolved: string[] = [];
    const tgz = makeTgz({
      'package/package.json': '{"name":"@node-llama-cpp/linux-x64-cuda","version":"3.20.0"}',
      'package/dist/index.js':
        'export function getBinsDir() { return { binsDir: ".", packageVersion: "3.20.0" } }',
      'package/bins/linux-x64-cuda/llama-addon.node': 'addon',
    });
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/3.20.0') && !url.includes('tarball')) {
        return new Response(
          JSON.stringify({ dist: { tarball: 'https://example.test/cuda.tgz', integrity } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      return new Response(Uint8Array.from(tgz), { status: 200 });
    };
    await ensureGpuBackend({
      platform: 'linux',
      arch: 'x64',
      root: dir,
      version: '3.20.0',
      detectGpus: async () => ['cuda', false],
      hasPackagedAddon: () => false,
      fetch: fetchImpl,
      resolvePackage: (name, dest) => {
        resolved.push(`${name} -> ${dest}`);
      },
    });
    const dest = path.join(dir, 'linux-x64-cuda@3.20.0');
    expect(isGpuBackendReady(dest)).toBe(true);
    expect(resolved).toEqual([`@node-llama-cpp/linux-x64-cuda -> ${dest}`]);
  });
});

describe('hasPackagedAddon', () => {
  it('returns false for a package that is not installed', () => {
    expect(hasPackagedAddon('@node-llama-cpp/does-not-exist-gpu')).toBe(false);
  });
});

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
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const b of header) checksum += b;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

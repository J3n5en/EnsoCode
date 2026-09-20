import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseManifest, prepareRtk, resourceBinaryPath, targetFor } from './rtk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = parseManifest(
  JSON.parse(await readFile(path.join(root, 'resources', 'rtk', 'manifest.json'), 'utf8'))
);

test('maps supported Node platform and architecture to the pinned official asset', () => {
  const expected = new Map([
    ['darwin-arm64', 'rtk-aarch64-apple-darwin.tar.gz'],
    ['darwin-x64', 'rtk-x86_64-apple-darwin.tar.gz'],
    ['linux-arm64', 'rtk-aarch64-unknown-linux-gnu.tar.gz'],
    ['linux-x64', 'rtk-x86_64-unknown-linux-musl.tar.gz'],
    ['win32-x64', 'rtk-x86_64-pc-windows-msvc.zip'],
  ]);
  for (const [key, asset] of expected) {
    const [platform, arch] = key.split('-');
    assert.equal(targetFor(manifest, platform, arch).asset, asset);
  }
  assert.equal(
    resourceBinaryPath('/repo', 'win32', 'x64'),
    path.join('/repo', 'resources', 'rtk', 'win32-x64', 'rtk.exe')
  );
});

test('rejects unsupported targets instead of falling back to the host binary', () => {
  assert.throws(() => targetFor(manifest, 'linux', 'ia32'), /Unsupported RTK target/);
  assert.throws(() => resourceBinaryPath('/repo', 'darwin', 'universal'), /Unsupported RTK target/);
});

test('rejects an unpinned or malformed manifest before downloading', () => {
  assert.throws(
    () => parseManifest({ ...manifest, version: 'latest' }),
    /Invalid RTK manifest version/
  );
  assert.throws(
    () =>
      parseManifest({
        ...manifest,
        targets: {
          ...manifest.targets,
          'darwin-arm64': { ...manifest.targets['darwin-arm64'], sha256: 'not-a-sha' },
        },
      }),
    /Invalid SHA-256/
  );
});

test('does not leave an executable behind when archive verification fails', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'enso-rtk-'));
  try {
    await assert.rejects(
      prepareRtk({
        root: temporaryRoot,
        platform: 'darwin',
        arch: 'arm64',
        manifest,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from('not the official archive'),
        }),
      }),
      /archive SHA-256 mismatch/
    );
    await assert.rejects(
      readFile(resourceBinaryPath(temporaryRoot, 'darwin', 'arm64')),
      (error) => error.code === 'ENOENT'
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('bounds a stalled download with an abort timeout', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'enso-rtk-timeout-'));
  try {
    await assert.rejects(
      prepareRtk({
        root: temporaryRoot,
        platform: 'darwin',
        arch: 'arm64',
        manifest,
        downloadTimeoutMs: 5,
        fetchImpl: async (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      }),
      /Timed out downloading RTK.*after 5ms/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

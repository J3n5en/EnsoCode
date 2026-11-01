import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DCG_VERSION, dcgAsset, dcgStatus, installDcg, uninstallDcg } from './dcgBinary';

const roots: string[] = [];
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-dcg-install-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('dcgAsset', () => {
  it('按平台选固定版本的发布包，Windows ARM 走 x64 包，不支持的平台返回 null', () => {
    expect(dcgAsset('darwin', 'arm64')).toMatchObject({
      url: `https://github.com/Dicklesworthstone/destructive_command_guard/releases/download/v${DCG_VERSION}/dcg-aarch64-apple-darwin.tar.xz`,
      binary: 'dcg',
    });
    expect(dcgAsset('linux', 'x64')?.url).toMatch(/dcg-x86_64-unknown-linux-musl\.tar\.xz$/);
    expect(dcgAsset('win32', 'arm64')).toMatchObject({ binary: 'dcg.exe' });
    expect(dcgAsset('win32', 'arm64')?.url).toMatch(/dcg-x86_64-pc-windows-msvc\.zip$/);
    expect(dcgAsset('linux', 'ia32')).toBeNull();
    expect(dcgAsset('darwin', 'x64')?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('installDcg', () => {
  const payload = Buffer.from('fake-archive');
  const asset = {
    url: 'https://example.test/dcg.tar.xz',
    sha256: createHash('sha256').update(payload).digest('hex'),
    binary: 'dcg',
  };
  const okFetch = vi.fn(async () => new Response(payload));
  const extract = vi.fn(async (_archive: string, dir: string) => {
    fs.writeFileSync(path.join(dir, 'dcg'), '#!/bin/sh\n');
  });

  it('下载、校验、解压后可用，卸载后清空', async () => {
    const root = tempRoot();
    expect(dcgStatus(root, 'darwin', 'arm64')).toEqual({
      supported: true,
      installed: false,
      version: DCG_VERSION,
    });
    const binary = await installDcg({ root, asset, fetch: okFetch, extract });
    expect(binary).toBe(path.join(root, 'dcg', DCG_VERSION, 'dcg'));
    expect(fs.existsSync(binary)).toBe(true);
    expect(dcgStatus(root, 'darwin', 'arm64').installed).toBe(true);
    expect(fs.readdirSync(path.join(root, 'dcg'))).toEqual([DCG_VERSION]);
    await uninstallDcg(root);
    expect(fs.existsSync(path.join(root, 'dcg'))).toBe(false);
  });

  it('校验和不符、HTTP 失败、包内缺二进制都不留下安装', async () => {
    const root = tempRoot();
    await expect(
      installDcg({ root, asset: { ...asset, sha256: '0'.repeat(64) }, fetch: okFetch, extract })
    ).rejects.toThrow(/sha256/i);
    await expect(
      installDcg({
        root,
        asset,
        fetch: async () => new Response('nope', { status: 404 }),
        extract,
      })
    ).rejects.toThrow(/404/);
    await expect(
      installDcg({ root, asset, fetch: okFetch, extract: async () => {} })
    ).rejects.toThrow(/dcg/);
    expect(fs.existsSync(path.join(root, 'dcg', DCG_VERSION))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'dcg'))).toEqual([]);
  });

  it('不支持的平台直接拒绝', async () => {
    await expect(installDcg({ root: tempRoot(), platform: 'linux', arch: 'ia32' })).rejects.toThrow(
      /unsupported/i
    );
  });
});

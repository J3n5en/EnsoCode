import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkDcgUpdate,
  compareDcgVersions,
  DCG_LATEST_RELEASE_API,
  DCG_VERSION,
  dcgAsset,
  dcgStatus,
  installDcg,
  resolveInstalledDcg,
  uninstallDcg,
} from './dcgBinary';

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
  it('按平台选固定版本的发布包，Windows ARM 有原生包，不支持的平台返回 null', () => {
    expect(dcgAsset('darwin', 'arm64')).toMatchObject({
      url: `https://github.com/Dicklesworthstone/destructive_command_guard/releases/download/v${DCG_VERSION}/dcg-aarch64-apple-darwin.tar.xz`,
      binary: 'dcg',
    });
    expect(dcgAsset('linux', 'x64')?.url).toMatch(/dcg-x86_64-unknown-linux-musl\.tar\.xz$/);
    expect(dcgAsset('win32', 'arm64')).toMatchObject({ binary: 'dcg.exe' });
    expect(dcgAsset('win32', 'arm64')?.url).toMatch(/dcg-aarch64-pc-windows-msvc\.zip$/);
    // 校验值取自上游 release 实算（2025-12 复核两次一致）
    expect(dcgAsset('win32', 'arm64')?.sha256).toBe(
      '84d3672201810d05bbaa4e3988eb2abfccb183de8c2cf204fcda0b620c1c3bae'
    );
    expect(dcgAsset('win32', 'x64')?.url).toMatch(/dcg-x86_64-pc-windows-msvc\.zip$/);
    expect(dcgAsset('linux', 'ia32')).toBeNull();
    expect(dcgAsset('darwin', 'x64')?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('resolveInstalledDcg', () => {
  const plant = (root: string, version: string, binary = 'dcg') => {
    const dir = path.join(root, 'dcg', version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, binary), '#!/bin/sh\n');
  };

  it('没有安装时返回 null', () => {
    expect(resolveInstalledDcg(tempRoot(), 'darwin')).toBeNull();
  });

  it('目标版本存在时直接命中', () => {
    const root = tempRoot();
    plant(root, DCG_VERSION);
    expect(resolveInstalledDcg(root, 'darwin')).toEqual({
      path: path.join(root, 'dcg', DCG_VERSION, 'dcg'),
      version: DCG_VERSION,
    });
  });

  it('目标版本缺失时回退到最高 semver 版本，老用户升级后旧二进制继续生效', () => {
    const root = tempRoot();
    plant(root, '0.15.1');
    plant(root, '0.16.0');
    const resolved = resolveInstalledDcg(root, 'darwin');
    expect(resolved?.version).toBe('0.16.0');
    expect(resolved?.path).toBe(path.join(root, 'dcg', '0.16.0', 'dcg'));
  });

  it('忽略 .tmp-*、非 semver 目录、目录里缺二进制的版本', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'dcg', '.tmp-abc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dcg', '.tmp-abc', 'dcg'), 'x');
    fs.mkdirSync(path.join(root, 'dcg', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dcg', 'notes', 'dcg'), 'x');
    fs.mkdirSync(path.join(root, 'dcg', '0.99.0'), { recursive: true });
    plant(root, '0.16.0');
    expect(resolveInstalledDcg(root, 'darwin')?.version).toBe('0.16.0');
  });

  it('win32 下找 dcg.exe', () => {
    const root = tempRoot();
    plant(root, '0.16.0', 'dcg.exe');
    expect(resolveInstalledDcg(root, 'win32')).toEqual({
      path: path.join(root, 'dcg', '0.16.0', 'dcg.exe'),
      version: '0.16.0',
    });
  });

  it('dcgStatus 报告实际落盘版本与目标内置版本', () => {
    const root = tempRoot();
    expect(dcgStatus(root, 'darwin', 'arm64')).toEqual({
      supported: true,
      installed: false,
      installedVersion: null,
      version: DCG_VERSION,
    });
    plant(root, '0.16.0');
    expect(dcgStatus(root, 'darwin', 'arm64')).toEqual({
      supported: true,
      installed: true,
      installedVersion: '0.16.0',
      version: DCG_VERSION,
    });
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
      installedVersion: null,
      version: DCG_VERSION,
    });
    const binary = await installDcg({ root, asset, fetch: okFetch, extract });
    expect(binary).toBe(path.join(root, 'dcg', DCG_VERSION, 'dcg'));
    expect(fs.existsSync(binary)).toBe(true);
    expect(dcgStatus(root, 'darwin', 'arm64').installed).toBe(true);
    expect(dcgStatus(root, 'darwin', 'arm64').installedVersion).toBe(DCG_VERSION);
    expect(fs.readdirSync(path.join(root, 'dcg'))).toEqual([DCG_VERSION]);
    await uninstallDcg(root);
    expect(fs.existsSync(path.join(root, 'dcg'))).toBe(false);
  });

  it('升级时只清理 semver 版本目录，保留无关目录和文件', async () => {
    const root = tempRoot();
    const base = path.join(root, 'dcg');
    fs.mkdirSync(path.join(base, '0.16.0'), { recursive: true });
    fs.writeFileSync(path.join(base, '0.16.0', 'dcg'), 'old');
    fs.mkdirSync(path.join(base, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(base, 'notes', 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(base, 'stray.txt'), 'keep');
    await installDcg({ root, asset, fetch: okFetch, extract });
    expect(fs.existsSync(path.join(base, '0.16.0'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'notes', 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'stray.txt'))).toBe(true);
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

describe('compareDcgVersions', () => {
  it('按数字比较 major.minor.patch，容忍 v 前缀，非法版本返回 null', () => {
    expect(compareDcgVersions('v0.16.0', '0.16.0')).toBe(0);
    expect(compareDcgVersions('0.16.1', '0.16.0')).toBeGreaterThan(0);
    expect(compareDcgVersions('0.9.0', '0.16.0')).toBeLessThan(0);
    expect(compareDcgVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareDcgVersions('latest', '0.16.0')).toBeNull();
    expect(compareDcgVersions('0.17.0-rc.1', '0.16.0')).toBeNull();
  });
});

describe('checkDcgUpdate', () => {
  const release = (tag: unknown) =>
    vi.fn(async (_url: string) => new Response(JSON.stringify({ tag_name: tag })));

  it('请求 GitHub latest release，与内置版本比较', async () => {
    const fetch = release('v0.17.2');
    expect(await checkDcgUpdate({ current: '0.16.0', fetch })).toEqual({
      status: 'available',
      current: '0.16.0',
      latest: '0.17.2',
    });
    expect(fetch).toHaveBeenCalledWith(DCG_LATEST_RELEASE_API, expect.anything());
    expect(DCG_LATEST_RELEASE_API).toBe(
      'https://api.github.com/repos/Dicklesworthstone/destructive_command_guard/releases/latest'
    );
  });

  it('相等或上游更旧都算已是最新', async () => {
    for (const tag of ['v0.16.0', '0.15.3']) {
      expect(await checkDcgUpdate({ current: '0.16.0', fetch: release(tag) })).toMatchObject({
        status: 'latest',
      });
    }
  });

  it('限流单独识别：403 + remaining=0 或 429', async () => {
    const limited = async () =>
      new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    expect(await checkDcgUpdate({ current: '0.16.0', fetch: limited })).toEqual({
      status: 'failed',
      current: '0.16.0',
      reason: 'rate-limited',
    });
    const tooMany = async () => new Response('{}', { status: 429 });
    expect(await checkDcgUpdate({ current: '0.16.0', fetch: tooMany })).toMatchObject({
      reason: 'rate-limited',
    });
  });

  it('断网、其它 HTTP 错误、坏响应都降级为失败结果而不是抛错', async () => {
    const offline = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await checkDcgUpdate({ current: '0.16.0', fetch: offline })).toMatchObject({
      status: 'failed',
      reason: 'network',
    });
    const forbidden = async () => new Response('{}', { status: 403 });
    expect(await checkDcgUpdate({ current: '0.16.0', fetch: forbidden })).toMatchObject({
      reason: 'network',
    });
    for (const fetch of [release(42), release('nightly'), async () => new Response('not json')]) {
      expect(await checkDcgUpdate({ current: '0.16.0', fetch })).toMatchObject({
        status: 'failed',
        reason: 'invalid',
      });
    }
  });
});

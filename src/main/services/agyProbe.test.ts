import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgyAuthStatus } from '@shared/agy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  binary: '/usr/local/bin/agy' as string | undefined,
  probe: vi.fn<() => Promise<AgyAuthStatus>>(),
}));

vi.mock('@platform', () => ({ app: { getPath: () => mocks.userData } }));
vi.mock('../../agent/agy/launch', () => ({
  agyChildEnv: () => ({}),
  agyCommandArgs: () => ['acp'],
  agyOnPath: () => undefined,
  resolveAgyBinary: () => mocks.binary,
}));
vi.mock('../../agent/agy/probe', () => ({ probeAgyAuth: () => mocks.probe() }));

const CACHE = 'agy-models-cache.json';
const models = [
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
];

/** 每次重新 import 等于一次 Main 重启：内存缓存清空，只剩磁盘文件。 */
async function boot() {
  vi.resetModules();
  return import('./agyProbe');
}

function cacheFile(): string {
  return path.join(mocks.userData, CACHE);
}

beforeEach(() => {
  mocks.userData = mkdtempSync(path.join(tmpdir(), 'enso-agy-models-'));
  mocks.binary = '/usr/local/bin/agy';
  mocks.probe.mockReset();
});

describe('agy 模型清单落盘', () => {
  it('没有缓存文件时只有空清单，且不触发探测', async () => {
    const probe = await boot();
    expect(probe.cachedAgyModels()).toEqual([]);
    expect(probe.cachedAgyAuth()).toEqual({ status: 'unknown' });
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('登录态探测写入文件，重启后不探测就能取回模型', async () => {
    mocks.probe.mockResolvedValue({ status: 'signed-in', version: '1.5.18', models });
    const first = await boot();
    await first.detectAgyAuth('', true);
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8')).models).toEqual(models);

    mocks.probe.mockClear();
    const second = await boot();
    expect(second.cachedAgyAuth()).toEqual({ status: 'unknown' });
    expect(second.cachedAgyModels()).toEqual(models);
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('每次登录态探测都重写文件', async () => {
    const probe = await boot();
    mocks.probe.mockResolvedValue({ status: 'signed-in', version: '1.5.18', models });
    await probe.detectAgyAuth('', true);
    const next = [{ id: 'gemini-4', name: 'Gemini 4' }];
    mocks.probe.mockResolvedValue({ status: 'signed-in', version: '1.5.19', models: next });
    await probe.detectAgyAuth('', true);
    expect(probe.cachedAgyModels()).toEqual(next);
    expect((await boot()).cachedAgyModels()).toEqual(next);
  });

  it('坏文件当空清单', async () => {
    for (const content of ['{not json', '[]', '{"models":"x"}', 'null', '']) {
      writeFileSync(cacheFile(), content);
      expect((await boot()).cachedAgyModels()).toEqual([]);
    }
    writeFileSync(cacheFile(), JSON.stringify({ models: [{ id: 'ok' }, { id: '' }, 5] }));
    expect((await boot()).cachedAgyModels()).toEqual([{ id: 'ok', name: 'ok' }]);
  });

  it('未登录 / 未安装不改文件：本次只给默认，重启后状态未知仍给上次清单', async () => {
    mocks.probe.mockResolvedValue({ status: 'signed-in', version: '1.5.18', models });
    await (await boot()).detectAgyAuth('', true);
    const before = readFileSync(cacheFile(), 'utf8');

    const signedOut = await boot();
    mocks.probe.mockResolvedValue({ status: 'signed-out', version: '1.5.18' });
    await signedOut.detectAgyAuth('', true);
    expect(signedOut.cachedAgyModels()).toEqual([]);
    expect(readFileSync(cacheFile(), 'utf8')).toBe(before);

    const missing = await boot();
    mocks.binary = undefined;
    await missing.detectAgyAuth('', true);
    expect(missing.cachedAgyAuth()).toEqual({ status: 'not-installed' });
    expect(missing.cachedAgyModels()).toEqual([]);
    expect(readFileSync(cacheFile(), 'utf8')).toBe(before);

    expect((await boot()).cachedAgyModels()).toEqual(models);
  });

  it('探测超时（unknown）仍提供上次登录探测的清单', async () => {
    mocks.probe.mockResolvedValue({ status: 'signed-in', version: '1.5.18', models });
    const probe = await boot();
    await probe.detectAgyAuth('', true);
    mocks.probe.mockResolvedValue({ status: 'unknown' });
    await probe.detectAgyAuth('', true);
    expect(probe.cachedAgyModels()).toEqual(models);
  });

  it('写文件失败不影响探测结果', async () => {
    mocks.userData = path.join(cacheFileParentThatIsAFile(), 'nested');
    mocks.probe.mockResolvedValue({ status: 'signed-in', version: '1.5.18', models });
    const probe = await boot();
    await expect(probe.detectAgyAuth('', true)).resolves.toMatchObject({ status: 'signed-in' });
    expect(probe.cachedAgyModels()).toEqual(models);
    expect(existsSync(path.join(mocks.userData, CACHE))).toBe(false);
  });
});

function cacheFileParentThatIsAFile(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'enso-agy-blocked-')), 'blocker');
  writeFileSync(file, '');
  return file;
}

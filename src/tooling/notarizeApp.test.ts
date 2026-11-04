import { describe, expect, it, vi } from 'vitest';
import { notarizeApp, notaryCredentials, shouldNotarize } from './notarizeApp.mjs';

const creds = { appleId: 'a@b.c', password: 'pw', teamId: 'TEAM' };

function fakeExec(handlers: Record<string, () => { stdout: string }>) {
  const calls: string[][] = [];
  const exec = vi.fn(async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    const key = file === 'xcrun' ? `${args[0]} ${args[1]}` : file;
    const handler = handlers[key];
    if (!handler) return { stdout: '' };
    return handler();
  });
  return { exec, calls };
}

const accepted = () => ({ stdout: JSON.stringify({ id: 'sub-1', status: 'Accepted' }) });

describe('notaryCredentials', () => {
  it('三个变量齐全才返回凭据', () => {
    expect(
      notaryCredentials({
        APPLE_ID: 'a@b.c',
        APPLE_APP_SPECIFIC_PASSWORD: 'pw',
        APPLE_TEAM_ID: 'TEAM',
      })
    ).toEqual(creds);
    expect(notaryCredentials({ APPLE_ID: 'a@b.c', APPLE_TEAM_ID: 'TEAM' })).toBeNull();
    expect(notaryCredentials({})).toBeNull();
  });
});

describe('shouldNotarize', () => {
  it('只有 mac 且不是纯 dir 目标时公证', () => {
    expect(
      shouldNotarize({
        electronPlatformName: 'darwin',
        targets: [{ name: 'dmg' }, { name: 'zip' }],
      })
    ).toBe(true);
    expect(shouldNotarize({ electronPlatformName: 'darwin', targets: [{ name: 'dir' }] })).toBe(
      false
    );
    expect(shouldNotarize({ electronPlatformName: 'win32', targets: [{ name: 'nsis' }] })).toBe(
      false
    );
  });
});

describe('notarizeApp', () => {
  it('提交一次公证，staple 网络失败时按间隔重试直到成功', async () => {
    let staples = 0;
    const { exec, calls } = fakeExec({
      'notarytool submit': accepted,
      'stapler staple': () => {
        staples += 1;
        if (staples < 3) throw new Error('Failed to staple: code 68');
        return { stdout: '' };
      },
    });
    const sleep = vi.fn(async (_ms: number) => {});
    await notarizeApp('/out/EnsoCode.app', creds, {
      exec,
      sleep,
      delays: [10, 20, 40],
      log: () => {},
    });
    expect(calls.filter((c) => c[1] === 'notarytool')).toHaveLength(1);
    expect(staples).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
    expect(calls.some((c) => c[1] === 'stapler' && c[2] === 'validate')).toBe(true);
  });

  it('staple 重试用完仍失败时抛错', async () => {
    const { exec } = fakeExec({
      'notarytool submit': accepted,
      'stapler staple': () => {
        throw new Error('Failed to staple: code 68');
      },
    });
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(
      notarizeApp('/out/EnsoCode.app', creds, { exec, sleep, delays: [1, 1], log: () => {} })
    ).rejects.toThrow(/code 68/);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('公证结果不是 Accepted 时抛错且不 staple', async () => {
    const { exec, calls } = fakeExec({
      'notarytool submit': () => ({ stdout: JSON.stringify({ id: 'sub-2', status: 'Invalid' }) }),
    });
    await expect(
      notarizeApp('/out/EnsoCode.app', creds, {
        exec,
        sleep: async () => {},
        delays: [],
        log: () => {},
      })
    ).rejects.toThrow(/Invalid/);
    expect(calls.some((c) => c[1] === 'stapler')).toBe(false);
    expect(calls.some((c) => c[1] === 'notarytool' && c[2] === 'log' && c[3] === 'sub-2')).toBe(
      true
    );
  });
});

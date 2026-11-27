import { existsSync } from 'node:fs';
import os from 'node:os';
import { AGY_PROVIDER_ID } from '@shared/agy/constants';
import type { AgyAuthStatus, AgyModelOption } from '@shared/agy/types';
import { version } from '../../../package.json';
import { agyChildEnv, agyCommandArgs, agyOnPath, resolveAgyBinary } from '../../agent/agy/launch';
import { probeAgyAuth } from '../../agent/agy/probe';

let cached: AgyAuthStatus = { status: 'unknown' };
let inflight: Promise<AgyAuthStatus> | undefined;

export function cachedAgyAuth(): AgyAuthStatus {
  return cached;
}

export function cachedAgyModels(): AgyModelOption[] {
  return cached.status === 'signed-in' ? cached.models : [];
}

/**
 * 显式探测。设置页打开、重新检测、会话 -32000 才能调用。
 * 不在窗口聚焦时调用：未登录的 agy 会反复尝试打开浏览器。
 */
export function detectAgyAuth(binaryPath: string, refresh: boolean): Promise<AgyAuthStatus> {
  if (!refresh && cached.status !== 'unknown') return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = run(binaryPath).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function run(binaryPath: string): Promise<AgyAuthStatus> {
  const binary = resolveAgyBinary({
    configured: binaryPath,
    pathHit: agyOnPath(),
    home: os.homedir(),
    exists: existsSync,
  });
  if (!binary) {
    cached = { status: 'not-installed' };
    return cached;
  }
  cached = await probeAgyAuth({
    command: binary,
    args: agyCommandArgs(false),
    env: agyChildEnv(process.env),
    clientVersion: version,
  });
  return cached;
}

export function agyProviderId(): string {
  return AGY_PROVIDER_ID;
}

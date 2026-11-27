import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { app } from '@platform';
import { offeredAgyModels, parseAgyModels } from '@shared/agy/catalog';
import { AGY_PROVIDER_ID } from '@shared/agy/constants';
import type { AgyAuthStatus, AgyModelOption } from '@shared/agy/types';
import { version } from '../../../package.json';
import { agyChildEnv, agyCommandArgs, agyOnPath, resolveAgyBinary } from '../../agent/agy/launch';
import { probeAgyAuth } from '../../agent/agy/probe';
import { readJson, writeJsonAtomic } from './bots/files';

/** 上次登录态探测拿到的模型清单；与登录状态分开存，重启后状态未知也能先列出模型。 */
const MODELS_CACHE_NAME = 'agy-models-cache.json';

let cached: AgyAuthStatus = { status: 'unknown' };
let inflight: Promise<AgyAuthStatus> | undefined;
let persisted: AgyModelOption[] | undefined;

function modelsCachePath(): string {
  return join(app.getPath('userData'), MODELS_CACHE_NAME);
}

/** 首次取用时读盘（Main 启动后第一次推 worker / 列 provider 时）；缺文件、坏文件当空清单。 */
function persistedModels(): AgyModelOption[] {
  if (persisted === undefined) {
    const raw = readJson(modelsCachePath());
    const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
    persisted = parseAgyModels((row as { models?: unknown } | undefined)?.models);
  }
  return persisted;
}

/** 只在登录态探测后调用：每次都重写。未登录 / 未安装不碰文件，存量会话仍可能引用这些模型。 */
function persistModels(models: AgyModelOption[]): void {
  persisted = models;
  try {
    writeJsonAtomic(modelsCachePath(), { models });
  } catch {
    // 缓存是派生数据；写失败只影响下次启动前的清单
  }
}

export function cachedAgyAuth(): AgyAuthStatus {
  return cached;
}

/** 不探测：登录态用实时清单，状态未知用落盘清单，明确不可用时为空。 */
export function cachedAgyModels(): AgyModelOption[] {
  return offeredAgyModels(cached, persistedModels());
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
  if (cached.status === 'signed-in') persistModels(cached.models);
  return cached;
}

export function agyProviderId(): string {
  return AGY_PROVIDER_ID;
}

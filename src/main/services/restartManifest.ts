import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RestartCheckpoint, RestartNextStep } from '@shared/gracefulRestart';
import type { AgentSpawnRequest } from '@shared/types/agent';

/**
 * 应用退出 / 安装更新前的恢复清单，与 worker 写的 restart-checkpoint.json 同放 dataDir。
 * 冷启动按它重走普通 spawn：模型只记 provider / model id，凭据由 Main 从现有来源重新取，
 * 所以这里绝不出现 API key、token、OAuth 凭证。
 */
export const RESTART_MANIFEST_FILE = 'restart-manifest.json';
export const RESTART_MANIFEST_ARCHIVE = 'restart-manifest.consumed.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type RestartExitReason = 'quit' | 'update';
export type RestartSessionSettings = Omit<AgentSpawnRequest, 'sessionId' | 'resumeFile'>;

export interface RestartManifestEntry {
  sessionId: string;
  generation: string;
  sessionFile: string;
  settings: RestartSessionSettings;
  turnId: string | null;
  nextStep: RestartNextStep;
  lastCompletedToolCallId: string | null;
  seq: number;
}

export interface RestartManifest {
  version: 1;
  reason: RestartExitReason;
  writtenAt: number;
  /** 对应断点的 writtenAt：冷启动只接管与清单配套的那份断点 */
  checkpointWrittenAt: number;
  sessions: RestartManifestEntry[];
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNonEmpty = (value: unknown): value is string => isString(value) && value.length > 0;
const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** 只按白名单逐项复制会话设置：多出来的字段（哪怕叫 apiKey）一律不进清单 */
export function pickRestartSettings(value: unknown): RestartSessionSettings | null {
  const v = asRecord(value);
  if (!v || !isNonEmpty(v.providerId) || !isNonEmpty(v.modelId) || !isString(v.cwd)) return null;
  const relay = asRecord(v.askRelay);
  return {
    providerId: v.providerId,
    modelId: v.modelId,
    cwd: v.cwd,
    ...(typeof v.reasoningEnabled === 'boolean' ? { reasoningEnabled: v.reasoningEnabled } : {}),
    ...(isString(v.thinkingLevel)
      ? { thinkingLevel: v.thinkingLevel as RestartSessionSettings['thinkingLevel'] }
      : {}),
    ...(typeof v.loadLocalSkills === 'boolean' ? { loadLocalSkills: v.loadLocalSkills } : {}),
    ...(Array.isArray(v.disabledTools) && v.disabledTools.every(isString)
      ? { disabledTools: [...v.disabledTools] }
      : {}),
    ...(isString(v.presetId) ? { presetId: v.presetId } : {}),
    ...(isString(v.approvalMode)
      ? { approvalMode: v.approvalMode as RestartSessionSettings['approvalMode'] }
      : {}),
    ...(typeof v.autoRejectApprovals === 'boolean'
      ? { autoRejectApprovals: v.autoRejectApprovals }
      : {}),
    ...(relay && isNonEmpty(relay.name) ? { askRelay: { name: relay.name } } : {}),
    ...(typeof v.planMode === 'boolean' ? { planMode: v.planMode } : {}),
  };
}

/** 断点里每个会话配上 Main 记着的设置；没有设置的（Bot、旁路等非普通根会话）不进清单 */
export function buildRestartManifest(input: {
  reason: RestartExitReason;
  checkpoint: RestartCheckpoint;
  settingsOf: (sessionId: string, generation: string) => unknown;
  now?: number;
}): RestartManifest {
  const sessions: RestartManifestEntry[] = [];
  for (const entry of input.checkpoint.sessions) {
    const settings = pickRestartSettings(input.settingsOf(entry.sessionId, entry.generation));
    if (!settings) continue;
    sessions.push({
      sessionId: entry.sessionId,
      generation: entry.generation,
      sessionFile: entry.sessionFile,
      settings,
      turnId: entry.turnId,
      nextStep: entry.nextStep,
      lastCompletedToolCallId: entry.lastCompletedToolCallId,
      seq: entry.seq,
    });
  }
  return {
    version: 1,
    reason: input.reason,
    writtenAt: input.now ?? Date.now(),
    checkpointWrittenAt: input.checkpoint.writtenAt,
    sessions,
  };
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret|client[_-]?secret|authorization|credentials?|oauth)"\s*:/i,
];

const SENSITIVE_KEY = /key|token|secret|password|authorization|credential|cookie/i;

/** 收集对象里敏感键下的字符串值和请求头值：用来核对清单里没有 Main 内存里真实的凭据 */
export function secretValuesOf(value: unknown, sensitive = false, out: string[] = []): string[] {
  if (isString(value)) {
    if (sensitive && value.length >= 8) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) secretValuesOf(item, sensitive, out);
    return out;
  }
  const record = asRecord(value);
  if (!record) return out;
  for (const [key, item] of Object.entries(record)) {
    secretValuesOf(item, sensitive || SENSITIVE_KEY.test(key) || /headers?$/i.test(key), out);
  }
  return out;
}

/** 返回命中的规则（不回显命中的内容本身） */
export function findSecretLikeStrings(
  text: string,
  knownSecrets: readonly string[] = []
): string[] {
  const hits = SECRET_PATTERNS.filter((pattern) => pattern.test(text)).map((p) => p.source);
  if (knownSecrets.some((secret) => secret.length >= 8 && text.includes(secret)))
    hits.push('known-credential');
  return hits;
}

export function restartManifestPath(dir: string): string {
  return path.join(dir, RESTART_MANIFEST_FILE);
}

/**
 * 先写临时文件再改名；落盘后读回来扫一遍，命中密钥样式或已知凭据就删掉文件并抛错（宁可不恢复）。
 * 没有可恢复的会话时不留文件。
 */
export function writeRestartManifest(
  dir: string,
  manifest: RestartManifest,
  knownSecrets: readonly string[] = []
): boolean {
  const file = restartManifestPath(dir);
  if (manifest.sessions.length === 0) {
    rmSync(file, { force: true });
    return false;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(manifest), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  const hits = findSecretLikeStrings(readFileSync(file, 'utf8'), knownSecrets);
  if (hits.length > 0) {
    rmSync(file, { force: true });
    throw new Error(`restart manifest looked like it contained credentials (${hits.join(', ')})`);
  }
  return true;
}

function parseEntry(value: unknown): RestartManifestEntry | null {
  const v = asRecord(value);
  if (!v) return null;
  const settings = pickRestartSettings(v.settings);
  if (
    !settings ||
    !isNonEmpty(v.sessionId) ||
    !isNonEmpty(v.generation) ||
    !isNonEmpty(v.sessionFile) ||
    !(v.turnId === null || isNonEmpty(v.turnId)) ||
    !(v.nextStep === 'model-request' || v.nextStep === 'await-user') ||
    !(v.lastCompletedToolCallId === null || isNonEmpty(v.lastCompletedToolCallId)) ||
    !isCount(v.seq)
  )
    return null;
  return {
    sessionId: v.sessionId,
    generation: v.generation,
    sessionFile: v.sessionFile,
    settings,
    turnId: v.turnId,
    nextStep: v.nextStep,
    lastCompletedToolCallId: v.lastCompletedToolCallId,
    seq: v.seq,
  };
}

export function parseRestartManifest(value: unknown, now = Date.now()): RestartManifest | null {
  const v = asRecord(value);
  if (
    v?.version !== 1 ||
    (v.reason !== 'quit' && v.reason !== 'update') ||
    !isCount(v.writtenAt) ||
    !isCount(v.checkpointWrittenAt) ||
    now - v.writtenAt > MAX_AGE_MS ||
    !Array.isArray(v.sessions)
  )
    return null;
  const sessions = v.sessions.map(parseEntry);
  if (sessions.some((entry) => entry === null)) return null;
  return {
    version: 1,
    reason: v.reason,
    writtenAt: v.writtenAt,
    checkpointWrittenAt: v.checkpointWrittenAt,
    sessions: sessions as RestartManifestEntry[],
  };
}

/** 读到即改名归档：同一份清单只恢复一次 */
export function takeRestartManifest(dir: string, now = Date.now()): RestartManifest | null {
  const file = restartManifestPath(dir);
  if (!existsSync(file)) return null;
  const archive = path.join(dir, RESTART_MANIFEST_ARCHIVE);
  renameSync(file, archive);
  try {
    return parseRestartManifest(JSON.parse(readFileSync(archive, 'utf8')), now);
  } catch {
    return null;
  }
}

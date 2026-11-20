// 优雅重启的安全点判定与断点文件。agent worker 与 scripts/graceful-restart-sim.mjs 共用本文件
// （模拟器由 Node 直接剥类型执行），所以只依赖 node:fs、只用可擦除的 TS 语法。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type {
  RestartCheckpoint,
  RestartCheckpointEntry,
  RestartDeferReason,
  RestartNextStep,
} from './types/gracefulRestart';

export type { RestartCheckpoint, RestartCheckpointEntry, RestartDeferReason, RestartNextStep };

export const RESTART_CHECKPOINT_FILE = 'restart-checkpoint.json';
export const RESTART_CHECKPOINT_ARCHIVE = 'restart-checkpoint.consumed.json';
/** Main 只在优雅重启拉起新 worker 时设置：新 worker 据此接管断点 */
export const RESTART_CHECKPOINT_ENV = 'ENSO_AGENT_RESTART_CHECKPOINT';

export interface RestartGateInput {
  toolsInFlight: readonly string[];
  /** 回合在跑：流式输出、等收口、重试倒计时、压缩 */
  turnActive: boolean;
  /** loop 停在工具批全部返回之后、下一次模型请求之前 */
  atModelRequestBoundary: boolean;
}

export type RestartGate =
  | { ready: true; nextStep: RestartNextStep }
  | { ready: false; reason: RestartDeferReason };

export function restartGate(input: RestartGateInput): RestartGate {
  if (input.toolsInFlight.length > 0) return { ready: false, reason: 'tool-in-flight' };
  if (input.atModelRequestBoundary) return { ready: true, nextStep: 'model-request' };
  if (input.turnActive) return { ready: false, reason: 'turn-in-progress' };
  return { ready: true, nextStep: 'await-user' };
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNonEmpty = (value: unknown): value is string => isString(value) && value.length > 0;
const isCount = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0;
const ENTRY_KEYS = [
  'sessionId',
  'generation',
  'sessionFile',
  'seq',
  'nextStep',
  'turnId',
  'lastCompletedToolCallId',
  'messageCount',
  'toolsInFlight',
];

function parseEntry(value: unknown): RestartCheckpointEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (keys.length !== ENTRY_KEYS.length || !ENTRY_KEYS.every((key) => key in entry)) return null;
  return isNonEmpty(entry.sessionId) &&
    isNonEmpty(entry.generation) &&
    isNonEmpty(entry.sessionFile) &&
    isCount(entry.seq) &&
    (entry.nextStep === 'model-request' || entry.nextStep === 'await-user') &&
    (entry.turnId === null || isNonEmpty(entry.turnId)) &&
    (entry.lastCompletedToolCallId === null || isNonEmpty(entry.lastCompletedToolCallId)) &&
    isCount(entry.messageCount) &&
    Array.isArray(entry.toolsInFlight) &&
    entry.toolsInFlight.every(isNonEmpty)
    ? (entry as unknown as RestartCheckpointEntry)
    : null;
}

export function parseRestartCheckpoint(value: unknown): RestartCheckpoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isCount(record.pid) || !isCount(record.writtenAt)) return null;
  if (!Array.isArray(record.sessions)) return null;
  const sessions = record.sessions.map(parseEntry);
  return sessions.every((entry) => entry !== null)
    ? (record as unknown as RestartCheckpoint)
    : null;
}

/** 先写临时文件再改名：新进程只会读到完整断点 */
export function writeRestartCheckpoint(file: string, checkpoint: RestartCheckpoint): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(checkpoint));
  renameSync(`${file}.tmp`, file);
}

/** 读到即改名归档：同一个断点只被接管一次 */
export function takeRestartCheckpoint(file: string, archive: string): RestartCheckpoint | null {
  if (!existsSync(file)) return null;
  renameSync(file, archive);
  try {
    return parseRestartCheckpoint(JSON.parse(readFileSync(archive, 'utf8')));
  } catch {
    return null;
  }
}

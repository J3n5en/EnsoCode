import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type ChildSessionIdentity, parseChildSessionIdentity } from '@shared/builtinAgents';
import type {
  AgentControlSpawnRequest,
  AgentMode,
  AgentOwnerIdentity,
  AgentRunGate,
  AgentRunStatus,
} from '@shared/types/agent';

/** 子代理派发参数：重启后重建子会话时按它重新解析同一套模型、思考档、类型 */
export interface AgentSpawnSpec {
  description: string;
  name?: string;
  agentType?: string;
  model?: string;
  thinking?: AgentControlSpawnRequest['thinking'];
}

/** 重启时还在跑的 Run：新 Main 据此重建 Agent 与 Run，接着原子会话续跑 */
export interface AgentRunRestartRecord {
  child: ChildSessionIdentity;
  spawn: AgentSpawnSpec;
  prompt: string;
  schema?: unknown;
  gate?: AgentRunGate;
  /** 手动 resume 已用次数 */
  resumes: number;
  /** 重启后已自动续跑的次数 */
  restartResumes: number;
  /** 已用的模型请求数：请求预算接着累计 */
  requests: number;
}

/** 子代理 Run 的身份台账：只存 id 与状态，Main 重启后据此认出旧 runId / agentId */
export interface AgentRunLedgerEntry {
  runId: string;
  agentId: string;
  ownerId: string;
  projectId: string;
  ownerKind: AgentOwnerIdentity['kind'];
  mode: AgentMode;
  status: AgentRunStatus;
  createdAt: number;
  finishedAt?: number;
  title?: string;
  /** 父会话已得知它的结局；false = 重启后父会话就绪时要补通知 */
  notified?: boolean;
  restart?: AgentRunRestartRecord;
}

export interface AgentRunLedgerStore {
  load(): AgentRunLedgerEntry[];
  save(entries: readonly AgentRunLedgerEntry[]): void;
}

export const AGENT_RUN_LEDGER_LIMIT = 500;

const STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'validating',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';
const count = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;
const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || nonEmpty(value);

function parseRestart(value: unknown): AgentRunRestartRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const child = parseChildSessionIdentity(record.child);
  const spawn = record.spawn as Record<string, unknown> | undefined;
  const gate = record.gate as Record<string, unknown> | undefined;
  if (
    !child ||
    !spawn ||
    typeof spawn !== 'object' ||
    !nonEmpty(spawn.description) ||
    !optionalString(spawn.name) ||
    !optionalString(spawn.agentType) ||
    !optionalString(spawn.model) ||
    !optionalString(spawn.thinking) ||
    typeof record.prompt !== 'string' ||
    (gate !== undefined && (typeof gate !== 'object' || !nonEmpty(gate?.commandRef))) ||
    !count(record.resumes) ||
    !count(record.restartResumes) ||
    !count(record.requests)
  ) {
    return null;
  }
  return {
    child,
    spawn: {
      description: spawn.description,
      ...(spawn.name ? { name: spawn.name } : {}),
      ...(spawn.agentType ? { agentType: spawn.agentType } : {}),
      ...(spawn.model ? { model: spawn.model } : {}),
      ...(spawn.thinking
        ? { thinking: spawn.thinking as AgentControlSpawnRequest['thinking'] }
        : {}),
    },
    prompt: record.prompt,
    ...(record.schema !== undefined ? { schema: record.schema } : {}),
    ...(gate ? { gate: { commandRef: gate.commandRef as string } } : {}),
    resumes: record.resumes,
    restartResumes: record.restartResumes,
    requests: record.requests,
  };
}

function parseEntry(value: unknown): AgentRunLedgerEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    !nonEmpty(entry.runId) ||
    !nonEmpty(entry.agentId) ||
    !nonEmpty(entry.ownerId) ||
    !nonEmpty(entry.projectId) ||
    entry.ownerKind !== 'chatSession' ||
    (entry.mode !== 'task' && entry.mode !== 'coworker') ||
    typeof entry.status !== 'string' ||
    !STATUSES.has(entry.status) ||
    typeof entry.createdAt !== 'number' ||
    !Number.isFinite(entry.createdAt)
  ) {
    return null;
  }
  const restart = entry.restart === undefined ? undefined : parseRestart(entry.restart);
  return {
    runId: entry.runId,
    agentId: entry.agentId,
    ownerId: entry.ownerId,
    projectId: entry.projectId,
    ownerKind: entry.ownerKind,
    mode: entry.mode,
    status: entry.status as AgentRunStatus,
    createdAt: entry.createdAt,
    ...(typeof entry.finishedAt === 'number' && Number.isFinite(entry.finishedAt)
      ? { finishedAt: entry.finishedAt }
      : {}),
    ...(typeof entry.title === 'string' && entry.title ? { title: entry.title.slice(0, 200) } : {}),
    ...(typeof entry.notified === 'boolean' ? { notified: entry.notified } : {}),
    ...(restart ? { restart } : {}),
  };
}

/** 坏文件、坏条目一律丢弃：台账只用于报错时说明原因，不能阻断子代理 */
export function parseAgentRunLedger(value: unknown): AgentRunLedgerEntry[] {
  const entries =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { runs?: unknown }).runs
      : undefined;
  if (!Array.isArray(entries)) return [];
  return entries
    .map(parseEntry)
    .filter((entry): entry is AgentRunLedgerEntry => entry !== null)
    .slice(-AGENT_RUN_LEDGER_LIMIT);
}

export function fileAgentRunLedger(file: string): AgentRunLedgerStore {
  return {
    load() {
      try {
        return parseAgentRunLedger(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        return [];
      }
    },
    save(entries) {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({ version: 1, runs: entries }));
        renameSync(temp, file);
      } catch (error) {
        console.warn('[agentRunLedger] save failed', error);
      }
    },
  };
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentMode, AgentOwnerIdentity, AgentRunStatus } from '@shared/types/agent';

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

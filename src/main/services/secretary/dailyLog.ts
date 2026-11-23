import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAILY_RETENTION_DAYS, dayKey } from '@shared/secretary/daily';
import { parseGoalResultView } from '@shared/secretary/goalResult';
import type { SecretaryDailyRecord, SecretaryResultKind } from '@shared/types/secretary';

/** 单文件上限：超过就按保留天数重写一次，平时只追加 */
const MAX_BYTES = 4 * 1024 * 1024;

const RESULT_KINDS: ReadonlySet<string> = new Set<SecretaryResultKind>([
  'goal-complete',
  'goal-blocked',
  'turn-ended',
  'needs-user',
  'failed',
  'stalled',
  'interrupted',
]);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 逐行校验：坏行跳过，不让一行脏数据挡住整天 */
function parseRecord(value: unknown): SecretaryDailyRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const at = time(raw.at);
  const conversationId = text(raw.conversationId);
  const kind = text(raw.kind);
  if (at === undefined || !conversationId || !kind || !RESULT_KINDS.has(kind)) return null;
  const record: SecretaryDailyRecord = {
    at,
    conversationId,
    kind: kind as SecretaryResultKind,
  };
  const projectId = text(raw.projectId);
  if (projectId) record.projectId = projectId;
  const title = text(raw.title);
  if (title) record.title = title;
  const body = text(raw.text);
  if (body) record.text = body;
  const branch = text(raw.branch);
  if (branch) record.branch = branch;
  const commit = text(raw.commit);
  if (commit) record.commit = commit;
  if (raw.merged === true) record.merged = true;
  const goalResult = parseGoalResultView(raw.goalResult);
  if (goalResult) record.goalResult = goalResult;
  return record;
}

/** userData/secretary/daily.jsonl：一行一条结果，追加写，按天回看靠它 */
export function appendDailyRecord(dir: string, record: SecretaryDailyRecord): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'daily.jsonl');
  pruneIfLarge(dir, file);
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/** 读全部结果记录；调用方按天过滤。文件有上限，一次读完比分段读省事 */
export function readDailyRecords(dir: string): SecretaryDailyRecord[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, 'daily.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const records: SecretaryDailyRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parseRecord(JSON.parse(trimmed));
      if (parsed) records.push(parsed);
    } catch {
      // 半行（写盘中断）直接跳过
    }
  }
  return records;
}

/** 超过上限时按保留天数重写：只留最近 DAILY_RETENTION_DAYS 天 */
function pruneIfLarge(dir: string, file: string): void {
  try {
    if (statSync(file).size < MAX_BYTES) return;
  } catch {
    return;
  }
  const cutoff = dayKey(Date.now() - DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const kept = readDailyRecords(dir).filter((record) => dayKey(record.at) >= cutoff);
  writeFileSync(file, kept.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
}

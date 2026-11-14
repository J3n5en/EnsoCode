import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretaryAuditEntry } from '../../../shared/types/secretary';

const MAX_BYTES = 5 * 1024 * 1024;

/** userData/secretary/audit.jsonl：只追加，超过 5MB 轮转一份 */
export function appendAudit(dir: string, entry: SecretaryAuditEntry): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'audit.jsonl');
  rotate(file, join(dir, 'audit.1.jsonl'));
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

function rotate(file: string, rotated: string): void {
  try {
    if (statSync(file).size < MAX_BYTES) return;
  } catch {
    return;
  }
  renameSync(file, rotated);
}

function parseLine(line: string): SecretaryAuditEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
    if (typeof value.op !== 'string' || value.op.length === 0) return null;
    const entry: SecretaryAuditEntry = {
      at: value.at,
      secretaryConversationId:
        typeof value.secretaryConversationId === 'string' ? value.secretaryConversationId : null,
      op: value.op,
      ok: value.ok === true,
    };
    if (typeof value.targetId === 'string') entry.targetId = value.targetId;
    if (typeof value.detail === 'string') entry.detail = value.detail;
    return entry;
  } catch {
    return null;
  }
}

/**
 * 读审计用于按天回看：当前文件加轮转出去的那一份（最多两份），按时间升序。
 * 轮转只保留一份，所以能回看多久取决于 5MB 写完要多久。
 */
export function readAudit(dir: string): SecretaryAuditEntry[] {
  const entries: SecretaryAuditEntry[] = [];
  for (const name of ['audit.1.jsonl', 'audit.jsonl']) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const parsed = parseLine(line);
      if (parsed) entries.push(parsed);
    }
  }
  return entries.sort((left, right) => left.at - right.at);
}

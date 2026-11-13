import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
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

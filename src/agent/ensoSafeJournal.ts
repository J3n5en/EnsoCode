import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type { CapabilityExecutionEnvelope } from '@shared/capabilities/types';
import type { SafeJournalProjection, SafeJournalRecord } from '@shared/types/agent';

interface Header {
  type: 'enso-safe-session';
  version: 1;
  child: ChildSessionIdentity;
  cwd: string;
  createdAt: number;
}

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  /\b(?:sk|ghp|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g,
];

export function redactSafeText(text: string): string {
  return SECRET_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, '[REDACTED]'),
    text
  ).slice(0, 100_000);
}

export class EnsoSafeJournal {
  readonly sessionFile: string;

  constructor(sessionDir: string, child: ChildSessionIdentity, cwd: string, resumeFile?: string) {
    mkdirSync(sessionDir, { recursive: true });
    this.sessionFile =
      resumeFile ??
      path.join(
        sessionDir,
        `enso-${child.sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}-${child.generation}.jsonl`
      );
    if (!resumeFile) {
      const header: Header = {
        type: 'enso-safe-session',
        version: 1,
        child,
        cwd,
        createdAt: Date.now(),
      };
      writeFileSync(this.sessionFile, `${JSON.stringify(header)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    }
  }

  append(record: SafeJournalRecord): void {
    appendFileSync(this.sessionFile, `${JSON.stringify(this.sanitize(record))}\n`, 'utf8');
  }

  appendUserText(text: string): void {
    this.append({ type: 'safe-user-text', text: redactSafeText(text), at: Date.now() });
  }

  appendAssistantText(text: string): void {
    this.append({ type: 'safe-assistant-text', text: redactSafeText(text), at: Date.now() });
  }

  appendCapabilityResult(toolCallId: string, envelope: CapabilityExecutionEnvelope): void {
    this.append({
      type: 'safe-model-result',
      toolCallId,
      modelResult: envelope.modelResult,
      at: Date.now(),
    });
    this.append({ type: 'capability-receipt', receipt: envelope.receipt, at: Date.now() });
  }

  static restore(sessionFile: string): SafeJournalProjection {
    const records: SafeJournalRecord[] = [];
    let partial = false;
    let lines: string[];
    try {
      lines = readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
    } catch {
      return { records, partial: true };
    }
    for (let index = 0; index < lines.length; index += 1) {
      try {
        const value = JSON.parse(lines[index]) as Record<string, unknown>;
        if (index === 0 && value.type === 'enso-safe-session' && value.version === 1) continue;
        const parsed = parseRecord(value);
        if (parsed) records.push(parsed);
        else partial = true;
      } catch {
        partial = true;
      }
    }
    return { records, partial };
  }

  private sanitize(record: SafeJournalRecord): SafeJournalRecord {
    if (record.type === 'safe-user-text' || record.type === 'safe-assistant-text') {
      return { ...record, text: redactSafeText(record.text) };
    }
    return record;
  }
}

function parseRecord(value: Record<string, unknown>): SafeJournalRecord | null {
  if (
    (value.type === 'safe-user-text' || value.type === 'safe-assistant-text') &&
    typeof value.text === 'string' &&
    typeof value.at === 'number'
  ) {
    return value as unknown as SafeJournalRecord;
  }
  if (
    value.type === 'enso-operation' &&
    typeof value.operationId === 'string' &&
    typeof value.capabilityId === 'string' &&
    typeof value.toolCallId === 'string' &&
    typeof value.at === 'number'
  ) {
    return value as unknown as SafeJournalRecord;
  }
  if (
    value.type === 'safe-model-result' &&
    typeof value.toolCallId === 'string' &&
    value.modelResult &&
    typeof value.modelResult === 'object' &&
    typeof value.at === 'number'
  ) {
    return value as unknown as SafeJournalRecord;
  }
  if (
    value.type === 'capability-receipt' &&
    value.receipt &&
    typeof value.receipt === 'object' &&
    typeof value.at === 'number'
  ) {
    return value as unknown as SafeJournalRecord;
  }
  return null;
}

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit } from './audit';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-audit-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));

describe('appendAudit', () => {
  it('appends one JSON line per entry and creates the directory', () => {
    const nested = join(dir, 'secretary');
    appendAudit(nested, { at: 1, secretaryConversationId: 's1', op: 'session_create', ok: true });
    appendAudit(nested, {
      at: 2,
      secretaryConversationId: null,
      op: 'session_send',
      targetId: 'c1',
      ok: false,
      detail: 'not visible',
    });
    expect(lines(join(nested, 'audit.jsonl'))).toEqual([
      { at: 1, secretaryConversationId: 's1', op: 'session_create', ok: true },
      {
        at: 2,
        secretaryConversationId: null,
        op: 'session_send',
        targetId: 'c1',
        ok: false,
        detail: 'not visible',
      },
    ]);
  });

  it('rotates the log to audit.1.jsonl once it passes 5MB', () => {
    const file = join(dir, 'audit.jsonl');
    writeFileSync(file, `${'x'.repeat(5 * 1024 * 1024)}\n`);
    appendAudit(dir, { at: 3, secretaryConversationId: 's1', op: 'session_stop', ok: true });

    expect(statSync(join(dir, 'audit.1.jsonl')).size).toBe(5 * 1024 * 1024 + 1);
    expect(lines(file)).toEqual([
      { at: 3, secretaryConversationId: 's1', op: 'session_stop', ok: true },
    ]);
  });

  it('keeps appending below the rotation threshold', () => {
    const file = join(dir, 'audit.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({ at: 0, secretaryConversationId: null, op: 'seed', ok: true })}\n`
    );
    appendAudit(dir, { at: 4, secretaryConversationId: 's1', op: 'profile_save', ok: true });
    expect(lines(file).map((line) => line.op)).toEqual(['seed', 'profile_save']);
  });
});

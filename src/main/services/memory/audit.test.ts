import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendMemoryAudit, editAuditEntry } from './audit';
import type { Memory } from './types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-audit-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  id: 'm1',
  title: 'Old',
  content: 'secret token abc',
  unitType: 'fact',
  importance: 0.6,
  spaceId: 'global',
} as Memory;

it('编辑审计只记字段变化，正文只留 hash 与长度', () => {
  const entry = editAuditEntry(
    {
      before: base,
      memory: { ...base, title: 'New', content: 'cleaned', importance: 0.9 },
      semanticChanged: true,
      embedded: true,
    },
    new Date('2026-01-01T00:00:00Z')
  );
  appendMemoryAudit(dir, entry);
  const raw = readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
  expect(raw).not.toContain('secret token');
  const parsed = JSON.parse(raw.trim());
  expect(parsed).toMatchObject({
    ts: '2026-01-01T00:00:00.000Z',
    action: 'memory.edit',
    actor: 'user',
    memoryId: 'm1',
    changes: {
      title: { from: 'Old', to: 'New' },
      importance: { from: 0.6, to: 0.9 },
      content: { fromChars: 16, toChars: 7 },
    },
  });
  expect(parsed.changes.unitType).toBeUndefined();
});

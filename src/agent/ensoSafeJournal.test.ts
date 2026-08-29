import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ChildSessionIdentity } from '@shared/builtinAgents';
import { afterEach, describe, expect, it } from 'vitest';
import { EnsoSafeJournal } from './ensoSafeJournal';

const roots: string[] = [];
const child: ChildSessionIdentity = {
  sessionId: 'parent::agent:enso:1',
  generation: '22222222-2222-4222-8222-222222222222',
  parent: { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' },
  typeKey: 'agent:enso',
  instanceId: 'enso-1',
  instanceName: 'Enso',
  profileId: 'enso-locked-v1',
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('EnsoSafeJournal', () => {
  it('persists only safe projections and never raw enso_app params or secrets', () => {
    const root = path.join(process.cwd(), 'temp', `enso-journal-${crypto.randomUUID()}`);
    roots.push(root);
    const journal = new EnsoSafeJournal(root, child, '/project');
    const secrets = [
      'sk-live-secret-1234567890',
      'Bearer oauth-token-1234567890',
      'https://alice:password@example.com/private',
      'apiKey=top-secret-value',
    ];
    journal.appendUserText(secrets.join(' '));
    journal.append({
      type: 'enso-operation',
      operationId: 'op-1',
      capabilityId: 'appearance.status-line-segments',
      toolCallId: 'tool-1',
      at: 1,
    });
    journal.appendCapabilityResult('tool-1', {
      modelResult: { ok: true, data: { summary: 'Updated safely.' } },
      receipt: {
        receiptId: 'receipt-1',
        operationId: 'op-1',
        child,
        turnId: 'turn-1',
        requestId: 'request-1',
        capabilityId: 'appearance.status-line-segments',
        risk: 'reversible',
        subject: { kind: 'setting', id: 'statusLineSegments', label: 'Status line segments' },
        outcome: 'succeeded',
        summary: 'Updated safely.',
        occurredAt: 1,
        sequence: 1,
      },
    });

    const disk = readFileSync(journal.sessionFile, 'utf8');
    expect(disk).not.toContain('params');
    for (const secret of secrets) expect(disk).not.toContain(secret);
    expect(disk).toContain('enso-operation');
    expect(EnsoSafeJournal.restore(journal.sessionFile)).toMatchObject({ partial: false });
  });

  it('strictly skips unknown or corrupt records and reports partial recovery', () => {
    const root = path.join(process.cwd(), 'temp', `enso-journal-${crypto.randomUUID()}`);
    roots.push(root);
    const journal = new EnsoSafeJournal(root, child, '/project');
    journal.appendAssistantText('safe output');
    appendFileSync(
      journal.sessionFile,
      '{broken\n{"type":"raw-tool-call","params":{"apiKey":"secret"}}\n'
    );
    const restored = EnsoSafeJournal.restore(journal.sessionFile);
    expect(restored.partial).toBe(true);
    expect(restored.records).toHaveLength(1);
    expect(JSON.stringify(restored.records)).not.toContain('secret');
  });
});

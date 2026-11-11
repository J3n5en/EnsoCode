import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findLatestSessionForCwd, findSessionById, readRunLast, writeRunLast } from './sessions';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function session(dir: string, name: string, id: string, cwd: string, mtime: Date): void {
  const file = path.join(dir, name);
  writeFileSync(file, `${JSON.stringify({ type: 'session', id, cwd })}\n{"type":"message"}\n`);
  utimesSync(file, mtime, mtime);
}

describe('session lookup', () => {
  it('finds a session by id and the newest file for a cwd', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-run-sessions-'));
    dirs.push(dir);
    const nested = path.join(dir, 'nested');
    writeFileSync(path.join(dir, 'junk.jsonl'), 'not json\n');
    session(dir, 'old.jsonl', 'old', '/work', new Date('2026-01-01T00:00:00Z'));
    mkdirSync(nested);
    session(nested, 'new.jsonl', 'new', '/work', new Date('2026-02-01T00:00:00Z'));
    session(dir, 'other.jsonl', 'other', '/else', new Date('2026-03-01T00:00:00Z'));

    expect(findSessionById(dir, 'new')?.sessionId).toBe('new');
    expect(findSessionById(dir, 'missing')).toBeNull();
    expect(findLatestSessionForCwd(dir, '/work')?.sessionId).toBe('new');
  });

  it('round-trips the last run pointer and skips dirty entries', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-run-last-'));
    dirs.push(dir);
    const file = path.join(dir, 'run-last.json');
    writeRunLast(file, '/work', { sessionId: 's', sessionFile: '/tmp/s.jsonl' });
    expect(readRunLast(file)['/work']).toEqual({ sessionId: 's', sessionFile: '/tmp/s.jsonl' });
    writeFileSync(file, '{"/work":{"sessionId":1},"ok":{"sessionId":"a","sessionFile":"b"}}');
    expect(readRunLast(file)).toEqual({ ok: { sessionId: 'a', sessionFile: 'b' } });
    expect(readRunLast(path.join(dir, 'missing.json'))).toEqual({});
  });
});

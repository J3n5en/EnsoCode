import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMemoryRoot } from '../localMemory';
import { loadJobs } from './jobs';
import { runMemorySlash } from './slash';

describe('runMemorySlash', () => {
  it('view returns guidance; enqueue marks dirty; clear removes the root', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-slash-'));
    const cwd = '/Users/me/proj';
    const root = getMemoryRoot(agentDir, cwd);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'memory_summary.md'), 'keep this\n');
    const viewed = await runMemorySlash({
      action: 'view',
      agentDir,
      cwd,
      localMemoryEnabled: true,
    });
    expect(viewed.ok).toBe(true);
    if (viewed.ok) expect(viewed.snapshot.summary).toContain('keep this');

    const queued = await runMemorySlash({
      action: 'enqueue',
      agentDir,
      cwd,
      localMemoryEnabled: true,
    });
    expect(queued.ok).toBe(true);
    expect((await loadJobs(root)).global.dirty).toBe(true);
    if (queued.ok) expect(queued.snapshot.notice).toBe('Merging now…');

    const cleared = await runMemorySlash({
      action: 'clear',
      agentDir,
      cwd,
      localMemoryEnabled: true,
    });
    expect(cleared.ok).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('rejects when memory is disabled or remote', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-slash-'));
    const off = await runMemorySlash({
      action: 'view',
      agentDir,
      cwd: '/x',
      localMemoryEnabled: false,
    });
    expect(off).toMatchObject({ ok: false });
    const remote = await runMemorySlash({
      action: 'view',
      agentDir,
      cwd: '/x',
      localMemoryEnabled: true,
      remote: true,
    });
    expect(remote).toMatchObject({ ok: false });
  });

  it('save writes summary and learned, then returns the snapshot', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-slash-'));
    const cwd = '/Users/me/proj';
    const saved = await runMemorySlash({
      action: 'save',
      agentDir,
      cwd,
      localMemoryEnabled: true,
      patch: { summary: '  keep the auth middleware  ', learned: ['use learn for durable facts'] },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.snapshot.summary).toBe('keep the auth middleware');
    expect(saved.snapshot.learned).toEqual(['use learn for durable facts']);
  });
});

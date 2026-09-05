import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMemoryRoot, saveLearnedLesson } from '../localMemory';
import { loadSessionMemoryInjection, shouldRunMemoryStartup } from './startup';

function agentDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'enso-agent-'));
}

const cwd = '/Users/me/proj';

describe('shouldRunMemoryStartup', () => {
  it('is true only when enabled and not remote/coworker/child', () => {
    expect(shouldRunMemoryStartup({ localMemoryEnabled: true })).toBe(true);
    expect(
      shouldRunMemoryStartup({
        localMemoryEnabled: true,
        remote: false,
        coworker: false,
        child: false,
      })
    ).toBe(true);
    expect(shouldRunMemoryStartup({ localMemoryEnabled: false })).toBe(false);
    expect(shouldRunMemoryStartup({ localMemoryEnabled: true, remote: true })).toBe(false);
    expect(shouldRunMemoryStartup({ localMemoryEnabled: true, coworker: true })).toBe(false);
    expect(shouldRunMemoryStartup({ localMemoryEnabled: true, child: true })).toBe(false);
  });
});

describe('loadSessionMemoryInjection', () => {
  it('returns the GUIDANCE.md path under the memory root, with guidance content', async () => {
    const dir = agentDir();
    const result = await loadSessionMemoryInjection(dir, cwd);
    expect(result.path).toBe(path.join(getMemoryRoot(dir, cwd), 'GUIDANCE.md'));
    expect(result.content).toContain('Memory Guidance');
  });

  it('includes memory_summary.md content when present', async () => {
    const dir = agentDir();
    const root = getMemoryRoot(dir, cwd);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'memory_summary.md'), 'Project uses pnpm workspaces.');
    const result = await loadSessionMemoryInjection(dir, cwd);
    expect(result.content).toContain('Memory summary');
    expect(result.content).toContain('Project uses pnpm workspaces.');
  });

  it('includes learned.md content when present', async () => {
    const dir = agentDir();
    await saveLearnedLesson(dir, cwd, { content: 'Prefer Bun.file over readFileSync.' });
    const result = await loadSessionMemoryInjection(dir, cwd);
    expect(result.content).toContain('Learned lessons');
    expect(result.content).toContain('Prefer Bun.file over readFileSync.');
  });

  it('never reads or mentions {cwd}/.enso/learned.md', async () => {
    const dir = agentDir();
    const staleCwd = mkdtempSync(path.join(tmpdir(), 'enso-cwd-'));
    mkdirSync(path.join(staleCwd, '.enso'), { recursive: true });
    writeFileSync(
      path.join(staleCwd, '.enso', 'learned.md'),
      '- STALE_MARKER_SHOULD_NOT_APPEAR\n'
    );
    const result = await loadSessionMemoryInjection(dir, staleCwd);
    expect(result.content).not.toContain('STALE_MARKER_SHOULD_NOT_APPEAR');
  });
});

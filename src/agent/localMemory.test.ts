import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeProjectPath,
  getMemoryRoot,
  LEARNED_FILE_NAME,
  readLearnedLessons,
  saveLearnedLesson,
} from './localMemory';

describe('localMemory (OMP-aligned)', () => {
  it('encodeProjectPath strips leading slash and replaces separators', () => {
    expect(encodeProjectPath('/Users/me/proj:one')).toBe('--Users-me-proj-one--');
  });

  it('getMemoryRoot joins agentDir/memories/<encoded>', () => {
    expect(getMemoryRoot('/agentDir', '/Users/me/proj')).toBe(
      path.join('/agentDir', 'memories', encodeProjectPath('/Users/me/proj'))
    );
  });

  it('saveLearnedLesson writes newest bullet, collapses whitespace, inlines context', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-agent-'));
    const cwd = '/Users/me/proj';
    const result = await saveLearnedLesson(agentDir, cwd, {
      content: 'Prefer Bun.file\nover\n\nreadFileSync.',
      context: 'from   the   build',
    });
    expect(result.stored).toBe(1);
    const file = path.join(getMemoryRoot(agentDir, cwd), LEARNED_FILE_NAME);
    expect(await readLearnedLessons(getMemoryRoot(agentDir, cwd))).toContain(
      'Prefer Bun.file over readFileSync. _(context: from the build)_'
    );
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(file, 'utf8')).toBe(
      '- Prefer Bun.file over readFileSync. _(context: from the build)_\n'
    );
  });

  it('empty/whitespace-only content is not stored and file is not created', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-agent-'));
    const cwd = '/Users/me/proj';
    const result = await saveLearnedLesson(agentDir, cwd, { content: '   \n  ' });
    expect(result.stored).toBe(0);
    const file = path.join(getMemoryRoot(agentDir, cwd), LEARNED_FILE_NAME);
    expect(existsSync(file)).toBe(false);
  });

  it('newest-first with exact-line dedupe', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-agent-'));
    const cwd = '/Users/me/proj';
    await saveLearnedLesson(agentDir, cwd, { content: 'A' });
    await saveLearnedLesson(agentDir, cwd, { content: 'B' });
    await saveLearnedLesson(agentDir, cwd, { content: 'A' });
    const text = await readLearnedLessons(getMemoryRoot(agentDir, cwd));
    expect(text.trim().split('\n')).toEqual(['- A', '- B']);
  });

  it('preserves hand-edited heading/prose above the first bullet run', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-agent-'));
    const cwd = '/Users/me/proj';
    const root = getMemoryRoot(agentDir, cwd);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });
    const file = path.join(root, LEARNED_FILE_NAME);
    writeFileSync(file, '# My Notes\n\nSome hand-written prose.\n\n- old bullet\n');
    await saveLearnedLesson(agentDir, cwd, { content: 'new bullet' });
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(file, 'utf8')).toBe(
      '# My Notes\n\nSome hand-written prose.\n\n- new bullet\n- old bullet\n'
    );
  });

  it('does not create or write {cwd}/.enso/learned.md', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-agent-'));
    const cwd = mkdtempSync(path.join(tmpdir(), 'enso-cwd-'));
    await saveLearnedLesson(agentDir, cwd, { content: 'alpha' });
    expect(existsSync(path.join(cwd, '.enso', 'learned.md'))).toBe(false);
  });

  it('readLearnedLessons returns "" when missing, stored text after save', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-agent-'));
    const cwd = '/Users/me/proj';
    expect(await readLearnedLessons(getMemoryRoot(agentDir, cwd))).toBe('');
    await saveLearnedLesson(agentDir, cwd, { content: 'alpha' });
    expect((await readLearnedLessons(getMemoryRoot(agentDir, cwd))).trim()).toBe('- alpha');
  });
});

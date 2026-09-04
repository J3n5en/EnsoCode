import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendLearnedFile,
  extractLearnedNotes,
  LEARNED_RELATIVE_PATH,
  mergeLearnedMarkdown,
} from './localMemory';

describe('localMemory', () => {
  it('extracts bullet notes and drops empty / errored replies', () => {
    expect(
      extractLearnedNotes({
        content: [{ type: 'text', text: '- uses pnpm\n- tests in vitest\n\n-  ' }],
      })
    ).toEqual(['uses pnpm', 'tests in vitest']);
    expect(
      extractLearnedNotes({ stopReason: 'error', content: [{ type: 'text', text: '- x' }] })
    ).toEqual([]);
  });

  it('merges notes with fingerprint de-dupe', () => {
    const first = mergeLearnedMarkdown('', ['uses pnpm']);
    expect(first).toBe('- uses pnpm\n');
    expect(mergeLearnedMarkdown(first, ['Uses pnpm', 'TDD required'])).toBe(
      '- uses pnpm\n- TDD required\n'
    );
  });

  it('appends to {cwd}/.enso/learned.md', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'enso-learned-'));
    expect(appendLearnedFile(cwd, ['alpha'])).toBe(true);
    const file = path.join(cwd, LEARNED_RELATIVE_PATH);
    expect(readFileSync(file, 'utf8')).toBe('- alpha\n');
    writeFileSync(file, '- alpha\n');
    expect(appendLearnedFile(cwd, ['alpha'])).toBe(false);
  });
});

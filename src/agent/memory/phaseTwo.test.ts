import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyConsolidation, parsePhaseTwoResponse, type PhaseTwoOutput } from './phaseTwo';

function memoryRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'enso-memroot-'));
}

describe('parsePhaseTwoResponse', () => {
  it('parses exact JSON; rejects extra keys and non-JSON; keeps empty strings', () => {
    expect(
      parsePhaseTwoResponse('{"memory_md":"m","memory_summary":"s","skills":[]}')
    ).toEqual({ memory_md: 'm', memory_summary: 's', skills: [] });
    expect(
      parsePhaseTwoResponse('{"memory_md":"","memory_summary":"","skills":[]}')
    ).toEqual({ memory_md: '', memory_summary: '', skills: [] });
    expect(
      parsePhaseTwoResponse('{"memory_md":"m","memory_summary":"s","skills":[],"extra":1}')
    ).toBeUndefined();
    expect(parsePhaseTwoResponse('not json')).toBeUndefined();
  });

  it('unwraps a fenced ```json block', () => {
    const fenced = '```json\n{"memory_md":"m","memory_summary":"s","skills":[]}\n```';
    expect(parsePhaseTwoResponse(fenced)).toEqual({ memory_md: 'm', memory_summary: 's', skills: [] });
  });
});

describe('applyConsolidation', () => {
  it('writes MEMORY.md and memory_summary.md with a trailing newline', async () => {
    const root = memoryRoot();
    const output: PhaseTwoOutput = { memory_md: '  # M\ncontent  ', memory_summary: '  short  ', skills: [] };
    await applyConsolidation(root, output);
    expect(readFileSync(path.join(root, 'MEMORY.md'), 'utf8')).toBe('# M\ncontent\n');
    expect(readFileSync(path.join(root, 'memory_summary.md'), 'utf8')).toBe('short\n');
  });

  it('writes skills/<name>/SKILL.md and prunes stale skill dirs not present in output', async () => {
    const root = memoryRoot();
    mkdirSync(path.join(root, 'skills', 'old-skill'), { recursive: true });
    writeFileSync(path.join(root, 'skills', 'old-skill', 'SKILL.md'), 'stale');
    const output: PhaseTwoOutput = {
      memory_md: 'm',
      memory_summary: 's',
      skills: [{ name: 'new-skill', content: 'new content' }],
    };
    await applyConsolidation(root, output);
    expect(readFileSync(path.join(root, 'skills', 'new-skill', 'SKILL.md'), 'utf8')).toBe(
      'new content'
    );
    expect(existsSync(path.join(root, 'skills', 'old-skill'))).toBe(false);
  });

  it('does not modify an existing learned.md', async () => {
    const root = memoryRoot();
    const learnedFile = path.join(root, 'learned.md');
    writeFileSync(learnedFile, '- keep me\n');
    await applyConsolidation(root, { memory_md: 'm', memory_summary: 's', skills: [] });
    expect(readFileSync(learnedFile, 'utf8')).toBe('- keep me\n');
  });
});

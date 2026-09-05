import { describe, expect, it } from 'vitest';
import { buildMemoryGuidance, MEMORY_SUMMARY_CHAR_BUDGET } from './guidance';

describe('buildMemoryGuidance', () => {
  it('always includes the heading and core rules, even when both inputs are empty', () => {
    const text = buildMemoryGuidance({});
    expect(text).toMatch(/Memory Guidance/);
    expect(text).toContain('memory://root/memory_summary.md');
    expect(text).toContain('memory://root/MEMORY.md');
    expect(text.toLowerCase()).toContain('stale');
    expect(text.toLowerCase()).toMatch(/never sufficient/);
    expect(text).not.toMatch(/Memory summary:/);
    expect(text).not.toMatch(/Learned lessons/);
  });

  it('includes a "Memory summary:" section with the provided text', () => {
    const text = buildMemoryGuidance({ summary: 'Project uses pnpm workspaces.' });
    expect(text).toMatch(/Memory summary:/);
    expect(text).toContain('Project uses pnpm workspaces.');
  });

  it('includes a "Learned lessons" section with the provided text', () => {
    const text = buildMemoryGuidance({ learned: '- Prefer Bun.file over readFileSync.' });
    expect(text).toMatch(/Learned lessons/);
    expect(text).toContain('- Prefer Bun.file over readFileSync.');
  });

  it('truncates summary+learned so the included bodies stay within the char budget', () => {
    const summary = 'S'.repeat(MEMORY_SUMMARY_CHAR_BUDGET + 5_000);
    const learned = 'L'.repeat(5_000);
    const text = buildMemoryGuidance({ summary, learned });
    // summary alone exceeds budget: it is sliced and learned is omitted entirely.
    expect(text).not.toContain('L'.repeat(5_000));
    const summaryRun = (text.match(/S+/) ?? [''])[0];
    expect(summaryRun.length).toBeLessThanOrEqual(MEMORY_SUMMARY_CHAR_BUDGET);
    expect(summaryRun.length).toBeGreaterThan(0);
  });
});

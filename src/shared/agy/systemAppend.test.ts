import { describe, expect, it } from 'vitest';
import { AGY_SYSTEM_APPEND_MAX_BYTES, ensoSystemAppend } from './systemAppend';

const PREAMBLE =
  'You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.';

/** 与 pi buildSystemPromptSections 的渲染一致：preamble 裸放，其余每段 `<name>\n…\n</name>` */
function piPrompt(sections: Record<string, string>): string {
  return [
    PREAMBLE,
    ...Object.entries(sections).map(([name, body]) => `<${name}>\n${body}\n</${name}>`),
  ].join('\n\n');
}

const FULL = piPrompt({
  tools: '- read: Read file contents\n\nAdditional tools may be available.',
  rules: '- Be concise in your responses',
  docs: 'Pi documentation (read only when the user asks about the harness itself)',
  addendum:
    '# Working in the workspace\n- act\n\n# Rich visualizations\n- reply with an ```html-viz fenced block\n\n<unattended>\nThis session has no human watching it.\n</unattended>',
  project_context:
    'Project-specific instructions and guidelines:\n\n<project_instructions path="/w/AGENTS.md">\nrules\n</project_instructions>',
  skills: '<available_skills>\n- tdd\n</available_skills>',
  cwd: '/Users/me/project',
  tool_catalog: 'These tools are declared to you as well',
  codemode_forbidden_tools: 'codemode',
  preset_tail: 'Load the poteto skill first.',
  preset_boost: 'Think harder.',
});

describe('ensoSystemAppend', () => {
  it('keeps the addendum and preset sections, drops pi sections', () => {
    const text = ensoSystemAppend(FULL);
    expect(text).toContain('# Working in the workspace');
    expect(text).toContain('```html-viz');
    expect(text).toContain('<unattended>\nThis session has no human watching it.\n</unattended>');
    expect(text).toContain('<preset_tail>\nLoad the poteto skill first.\n</preset_tail>');
    expect(text).toContain('<preset_boost>\nThink harder.\n</preset_boost>');
    for (const banned of [
      'running inside pi',
      '<tools>',
      '<rules>',
      '<docs>',
      '<skills>',
      '<project_context>',
      'project_instructions',
      '<cwd>',
      '/Users/me/project',
      'tool_catalog',
      'codemode_forbidden_tools',
      '<addendum>',
    ]) {
      expect(text).not.toContain(banned);
    }
    expect(text.indexOf('# Working in the workspace')).toBeLessThan(text.indexOf('<preset_tail>'));
  });

  it('returns empty text when there is nothing Enso-authored', () => {
    expect(ensoSystemAppend('')).toBe('');
    expect(ensoSystemAppend(PREAMBLE)).toBe('');
    expect(ensoSystemAppend(piPrompt({ tools: '- read', cwd: '/w' }))).toBe('');
  });

  it('strips any line naming the pi client identity, in any casing', () => {
    const text = ensoSystemAppend(
      piPrompt({
        addendum: 'keep me\nYou are RUNNING INSIDE PI here\nkeep me too',
        preset_tail: 'as a coding assistant running inside pi, do x\ntail line',
      })
    );
    expect(text.toLowerCase()).not.toContain('running inside pi');
    expect(text).toContain('keep me\nkeep me too');
    expect(text).toContain('tail line');
  });

  it('reads a forced (persona) prompt that has the same tagged sections', () => {
    const forced = `You are Ada, the secretary.\n\n<addendum>\n# Rich visualizations\n</addendum>\n\n<cwd>\n/w\n</cwd>`;
    expect(ensoSystemAppend(forced)).toBe('# Rich visualizations');
  });

  it('ignores tag names mentioned inline rather than as section lines', () => {
    const prompt = `${PREAMBLE}\nsee <addendum> below\n\n<addendum>\nreal\n</addendum>`;
    expect(ensoSystemAppend(prompt)).toBe('real');
  });

  it('handles CRLF line endings', () => {
    const prompt = `${PREAMBLE}\r\n\r\n<addendum>\r\nline one\r\nline two\r\n</addendum>\r\n`;
    expect(ensoSystemAppend(prompt)).toBe('line one\nline two');
  });

  it('caps the text at the byte budget on a line boundary', () => {
    const line = '雨'.repeat(100);
    const huge = piPrompt({ addendum: Array.from({ length: 400 }, () => line).join('\n') });
    const text = ensoSystemAppend(huge);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(AGY_SYSTEM_APPEND_MAX_BYTES);
    expect(text.endsWith('[EnsoCode instructions truncated]')).toBe(true);
    expect(
      text
        .split('\n')
        .slice(0, -1)
        .every((row) => row === line)
    ).toBe(true);
  });
});

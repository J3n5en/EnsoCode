import { describe, expect, it } from 'vitest';
import {
  AGY_ENSO_SECTIONS_MAX_BYTES,
  AGY_SYSTEM_APPEND_MAX_BYTES,
  ensoSystemAppend,
} from './systemAppend';

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

  it('puts the role first, whole, ahead of the Enso sections', () => {
    const forced = `You are Ada, the secretary.\n\n<addendum>\n# Rich visualizations\n</addendum>\n\n<cwd>\n/w\n</cwd>`;
    expect(ensoSystemAppend(forced, 'You are Ada, the secretary.\nNoise: call silence_turn.')).toBe(
      '<role>\nYou are Ada, the secretary.\nNoise: call silence_turn.\n</role>\n\n# Rich visualizations'
    );
    expect(ensoSystemAppend('', 'Only a role')).toBe('<role>\nOnly a role\n</role>');
    expect(ensoSystemAppend('', 'a\r\nb')).toBe('<role>\na\nb\n</role>');
    expect(ensoSystemAppend('', 'keep\nYou are running inside pi\nkeep too')).toBe(
      '<role>\nkeep\nkeep too\n</role>'
    );
  });

  it('leaves a session without a role exactly as before', () => {
    const plain =
      '# Working in the workspace\n- act\n\n# Rich visualizations\n- reply with an ```html-viz fenced block\n\n<unattended>\nThis session has no human watching it.\n</unattended>\n\n<preset_tail>\nLoad the poteto skill first.\n</preset_tail>\n\n<preset_boost>\nThink harder.\n</preset_boost>';
    expect(ensoSystemAppend(FULL)).toBe(plain);
    expect(ensoSystemAppend(FULL, '')).toBe(plain);
    expect(ensoSystemAppend(FULL, '  \n ')).toBe(plain);
  });

  it('keeps the role whole over the cap and lets the other sections give way in priority order', () => {
    const encoder = new TextEncoder();
    const size = (text: string) => encoder.encode(text).length;
    const rule = 'R'.repeat(99);
    const role = Array.from({ length: 300 }, (_, index) => `${index} ${rule}`).join('\n');
    const line = 'a'.repeat(99);
    const prompt = piPrompt({
      addendum: Array.from({ length: 200 }, () => line).join('\n'),
      preset_tail: 'TAIL',
      preset_boost: 'BOOST',
    });
    expect(size(role) + size(line) * 200).toBeGreaterThan(AGY_SYSTEM_APPEND_MAX_BYTES);

    const text = ensoSystemAppend(prompt, role);
    expect(size(text)).toBeLessThanOrEqual(AGY_SYSTEM_APPEND_MAX_BYTES);
    expect(text.startsWith(`<role>\n${role}\n</role>\n\n${line}\n`)).toBe(true);
    expect(text.endsWith('[EnsoCode instructions truncated]')).toBe(true);
    expect(text).not.toContain('TAIL');
    expect(text).not.toContain('BOOST');

    // 高优先级段放得下就整段保留，放不下的是排在后面的那段
    const small = piPrompt({
      addendum: 'ADDENDUM',
      preset_tail: line.repeat(300),
      preset_boost: 'BOOST',
    });
    const squeezed = ensoSystemAppend(small, role);
    expect(squeezed.startsWith(`<role>\n${role}\n</role>\n\nADDENDUM\n\n`)).toBe(true);
    expect(squeezed).not.toContain('BOOST');
    expect(size(squeezed)).toBeLessThanOrEqual(AGY_SYSTEM_APPEND_MAX_BYTES);

    // 规则段自己就超了上限：照样整段发，其余段全部让位
    const huge = Array.from({ length: 3 }, () => role).join('\n');
    expect(size(huge)).toBeGreaterThan(AGY_SYSTEM_APPEND_MAX_BYTES);
    expect(ensoSystemAppend(prompt, huge)).toBe(
      `<role>\n${huge}\n</role>\n\n[EnsoCode instructions truncated]`
    );
    expect(ensoSystemAppend('', huge)).toBe(`<role>\n${huge}\n</role>`);
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
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(AGY_ENSO_SECTIONS_MAX_BYTES);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(
      AGY_ENSO_SECTIONS_MAX_BYTES - 400
    );
    expect(text.endsWith('[EnsoCode instructions truncated]')).toBe(true);
    expect(
      text
        .split('\n')
        .slice(0, -1)
        .every((row) => row === line)
    ).toBe(true);
  });
});

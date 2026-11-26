import { describe, expect, it } from 'vitest';
import { buildAgyPrompt } from './promptBuilder';

const PREAMBLE = 'You are a coding assistant running inside pi';

describe('buildAgyPrompt', () => {
  it('sends only the latest user text and images, never pi context', () => {
    const blocks = buildAgyPrompt({
      messages: [
        {
          role: 'system',
          content: `${PREAMBLE}\n<skills>secret-skill</skills>\n<rules>secret-rule</rules>\nproject_context`,
        },
        {
          role: 'custom',
          customType: 'injected',
          content: [{ type: 'text', text: 'injected custom message' }],
        },
        { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'earlier answer with a summary' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'fix the bug' },
            { type: 'image', mimeType: 'image/png', data: 'abc' },
          ],
        },
      ],
      interactionMode: 'default',
      includeInstructions: true,
      includeRuntimeInfo: true,
      modelLabel: 'gemini-4-hydrogen',
    });
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).not.toContain(PREAMBLE);
    expect(text).not.toContain('<skills>');
    expect(text).not.toContain('<rules>');
    expect(text).not.toContain('project_context');
    expect(text).not.toContain('injected custom message');
    expect(text).not.toContain('earlier question');
    expect(text).not.toContain('earlier answer');
    expect(text).toContain('<enso_instructions>');
    expect(text).toContain('EnsoCode interaction mode: Default');
    expect(text).toContain('<user_request>\nfix the bug\n</user_request>');
    expect(text).toContain(
      'you are running in EnsoCode through the Antigravity harness, as gemini-4-hydrogen'
    );
    expect(blocks).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'abc' });
  });

  it('sends a slash command as the raw text and images only', () => {
    const blocks = buildAgyPrompt({
      messages: [
        { role: 'system', content: PREAMBLE },
        {
          role: 'user',
          content: [
            { type: 'text', text: '  /help' },
            { type: 'image', mimeType: 'image/jpeg', data: 'img' },
          ],
        },
      ],
      interactionMode: 'plan',
      includeInstructions: true,
      includeRuntimeInfo: true,
      modelLabel: 'm',
    });
    expect(blocks).toEqual([
      { type: 'text', text: '  /help' },
      { type: 'image', mimeType: 'image/jpeg', data: 'img' },
    ]);
  });

  it('omits instructions and runtime info until the caller asks for them', () => {
    const blocks = buildAgyPrompt({
      messages: [{ role: 'user', content: 'hello' }],
      interactionMode: 'plan',
      includeInstructions: false,
      includeRuntimeInfo: false,
      modelLabel: 'm',
    });
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('wraps plan mode with the plan instructions', () => {
    const blocks = buildAgyPrompt({
      messages: [{ role: 'user', content: 'plan this' }],
      interactionMode: 'plan',
      includeInstructions: true,
      includeRuntimeInfo: false,
      modelLabel: 'm',
    });
    const text = blocks[0]?.type === 'text' ? blocks[0].text : '';
    expect(text).toContain('EnsoCode interaction mode: Plan');
    expect(text).toContain('do not edit files');
    expect(text).not.toContain('interaction mode: Default');
  });
});

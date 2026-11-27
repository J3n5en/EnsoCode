import { describe, expect, it } from 'vitest';
import { prependTurnNote } from '../turnNotes';
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

  it('explains the Enso tools only when Host MCP carries them, by the names agy shows', () => {
    const textOf = (ensoTools: string[]) => {
      const blocks = buildAgyPrompt({
        messages: [
          { role: 'system', content: `${PREAMBLE}\n<skills>s</skills>\n<rules>r</rules>` },
          { role: 'user', content: 'go' },
        ],
        interactionMode: 'default',
        includeInstructions: true,
        includeRuntimeInfo: false,
        modelLabel: 'm',
        ensoTools,
      });
      return blocks[0]?.type === 'text' ? blocks[0].text : '';
    };
    const without = textOf([]);
    expect(without).not.toContain('mcp_enso_');
    expect(without).not.toContain('`enso` MCP server');

    const full = textOf(['ask_user', 'todo', 'subagent', 'remind_me']);
    expect(full).toContain('`enso` MCP server');
    for (const name of ['ask_user', 'todo', 'subagent', 'remind_me']) {
      expect(full).toContain(`mcp_enso_${name}`);
    }
    expect(full.indexOf('mcp_enso_todo')).toBeLessThan(full.indexOf('<user_request>'));
    expect(full).not.toContain(PREAMBLE);
    expect(full).not.toContain('<skills>');
    expect(full).not.toContain('<rules>');

    const todoOnly = textOf(['todo']);
    expect(todoOnly).toContain('mcp_enso_todo');
    expect(todoOnly).not.toContain('mcp_enso_ask_user');
    expect(todoOnly).not.toContain('mcp_enso_subagent');
  });

  it('routes subagents to the Enso tool, never native ones, only when subagent is exposed', () => {
    const textOf = (ensoTools: string[]) => {
      const blocks = buildAgyPrompt({
        messages: [{ role: 'user', content: 'go' }],
        interactionMode: 'default',
        includeInstructions: true,
        includeRuntimeInfo: false,
        modelLabel: 'm',
        ensoTools,
      });
      return blocks[0]?.type === 'text' ? blocks[0].text : '';
    };
    const withSubagent = textOf(['subagent', 'workflow', 'todo']);
    expect(withSubagent).toContain(
      'Subagents, delegation and parallel work: always use `mcp_enso_subagent`'
    );
    expect(withSubagent).toContain('`mcp_enso_workflow` when a workflow was asked');
    expect(withSubagent).toContain('Never use your native `invoke_subagent`/`manage_subagents`');
    expect(withSubagent).toContain(
      'Fall back to native subagents only when no `mcp_enso_subagent`'
    );
    expect(withSubagent).toContain(
      'Enso tools may load late. Try the name once before you call it absent.'
    );
    expect(withSubagent).toContain(
      'As a subagent or child, do the work yourself. Start no subagents unless your task says to.'
    );

    const subagentOnly = textOf(['subagent']);
    expect(subagentOnly).toContain('always use `mcp_enso_subagent`');
    expect(subagentOnly).not.toContain('mcp_enso_workflow');

    for (const tools of [['todo', 'ask_user'], ['workflow'], []]) {
      const text = textOf(tools);
      expect(text).not.toContain('invoke_subagent');
      expect(text).not.toContain('always use `mcp_enso_subagent`');
    }
  });

  it('lists the core tools by name and points to search / call for the lazy rest', () => {
    const textOf = (ensoTools: string[]) => {
      const blocks = buildAgyPrompt({
        messages: [{ role: 'user', content: 'go' }],
        interactionMode: 'default',
        includeInstructions: true,
        includeRuntimeInfo: false,
        modelLabel: 'm',
        ensoTools,
      });
      return blocks[0]?.type === 'text' ? blocks[0].text : '';
    };
    const text = textOf(['subagent', 'todo', 'enso_tool_search', 'enso_tool_call']);
    expect(text).toContain(
      'EnsoCode tools come from the `enso` MCP server: `mcp_enso_subagent`, `mcp_enso_todo`.'
    );
    expect(text).toContain(
      '- Other EnsoCode tools (plugins and MCP servers EnsoCode connects to) are not listed: find them with `mcp_enso_enso_tool_search` and call them with `mcp_enso_enso_tool_call`.'
    );
    expect(textOf(['subagent', 'todo'])).not.toContain('enso_tool_search');
    // 只有懒加载工具
    const lazyOnly = textOf(['enso_tool_search', 'enso_tool_call']);
    expect(lazyOnly).toContain('EnsoCode tools come from the `enso` MCP server.');
    expect(lazyOnly).toContain('`mcp_enso_enso_tool_search`');
  });

  it('passes a one-off turn note prefixed to the user text through unchanged', () => {
    // 一次性提示（无人值守开关等）由 supervisor 前置到用户文字，原样随本轮发给 agy
    const note =
      '<unattended>\nUnattended mode is ON: this session has no human watching it.\n</unattended>';
    const noted = buildAgyPrompt({
      messages: [{ role: 'user', content: prependTurnNote(note, 'go on') }],
      interactionMode: 'default',
      includeInstructions: false,
      includeRuntimeInfo: false,
      modelLabel: 'm',
    });
    expect(noted).toEqual([{ type: 'text', text: `${note}\n\ngo on` }]);
  });

  it('puts the Enso system append inside the instructions, before the request', () => {
    const blocks = buildAgyPrompt({
      messages: [{ role: 'user', content: 'chart it' }],
      interactionMode: 'default',
      includeInstructions: true,
      includeRuntimeInfo: false,
      modelLabel: 'm',
      systemAppend: '# Rich visualizations\n- ```html-viz',
    });
    const text = blocks[0]?.type === 'text' ? blocks[0].text : '';
    const start = text.indexOf('<enso_instructions>');
    const append = text.indexOf('# Rich visualizations');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(append).toBeGreaterThan(start);
    expect(append).toBeLessThan(text.indexOf('</enso_instructions>'));
    expect(text).toContain('<user_request>\nchart it\n</user_request>');

    const bare = buildAgyPrompt({
      messages: [{ role: 'user', content: 'chart it' }],
      interactionMode: 'default',
      includeInstructions: false,
      includeRuntimeInfo: false,
      modelLabel: 'm',
      systemAppend: '# Rich visualizations',
    });
    expect(bare).toEqual([{ type: 'text', text: 'chart it' }]);
  });
});

import { describe, expect, it } from 'vitest';
import { emptyTranslatorState, reduceAgyUpdate, stopFromPrompt } from './translator';

describe('reduceAgyUpdate', () => {
  it('appends text and thinking, and projects native tool names', () => {
    let state = emptyTranslatorState();
    const text = reduceAgyUpdate(state, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello' },
    });
    state = text.state;
    const thought = reduceAgyUpdate(state, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'hmm' },
    });
    state = thought.state;
    const tool = reduceAgyUpdate(state, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'Running client_view_file',
      kind: 'read',
      status: 'in_progress',
      rawInput: { name: 'client_view_file', absolute_path: '/work/a.ts' },
    });
    expect(text.effects).toEqual([{ type: 'text', delta: 'Hello' }]);
    expect(thought.effects).toEqual([{ type: 'thinking', delta: 'hmm' }]);
    expect(tool.state.tools).toEqual([
      expect.objectContaining({
        id: 'call-1',
        name: 'read_file',
        status: 'in_progress',
      }),
    ]);
    expect(tool.effects[0]).toMatchObject({ type: 'tool', name: 'read_file', id: 'call-1' });
  });

  it('repairs a failed read that Enso already served', () => {
    const started = reduceAgyUpdate(
      emptyTranslatorState(),
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: 'Running client_view_file',
        status: 'in_progress',
        rawInput: { absolute_path: '/work/a.ts' },
      },
      ['/work/a.ts']
    );
    const failed = reduceAgyUpdate(
      started.state,
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-1',
        title: 'Running client_view_file',
        status: 'failed',
        rawOutput: 'step error',
      },
      ['/work/a.ts']
    );
    expect(failed.state.tools[0]).toMatchObject({ id: 'read-1', status: 'completed' });
    expect(failed.effects[0]).toMatchObject({ type: 'tool', status: 'completed' });
  });

  it('keeps a plan update and maps prompt stop reasons', () => {
    const planned = reduceAgyUpdate(emptyTranslatorState(), {
      sessionUpdate: 'plan',
      entries: [{ content: 'read the file', status: 'pending' }],
    });
    expect(planned.state.plan).toEqual([{ content: 'read the file', status: 'pending' }]);
    expect(stopFromPrompt('end_turn')).toBe('stop');
    expect(stopFromPrompt('max_tokens')).toBe('length');
    expect(stopFromPrompt('refusal')).toBe('error');
    expect(stopFromPrompt('cancelled')).toBe('aborted');
  });

  it('uses content text when a tool update has no rawOutput, and maps native inputs', () => {
    const command = reduceAgyUpdate(emptyTranslatorState(), {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-1',
      title: 'Running run_command',
      status: 'in_progress',
      rawInput: { CommandLine: 'ls' },
    });
    const updated = reduceAgyUpdate(command.state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'cmd-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    });
    expect(command.state.tools[0]).toMatchObject({ name: 'run_command', args: { command: 'ls' } });
    expect(updated.state.tools[0]?.output).toBe('ok');
    const mcp = reduceAgyUpdate(emptyTranslatorState(), {
      sessionUpdate: 'tool_call',
      toolCallId: 'mcp-1',
      rawInput: { name: 'mcp_t3-code_search', query: 'x' },
      status: 'completed',
    });
    expect(mcp.state.tools[0]?.name).toBe('mcp_t3-code_search');
  });
});

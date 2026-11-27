import { describe, expect, it } from 'vitest';
import { emptyTranslatorState, holdsTurn, reduceAgyUpdate, stopFromPrompt } from './translator';

describe('background work after end_turn', () => {
  const started = (toolCallId: string, extra: Record<string, unknown>) =>
    reduceAgyUpdate(emptyTranslatorState(), {
      sessionUpdate: 'tool_call',
      toolCallId,
      status: 'in_progress',
      ...extra,
    }).state;

  it('holds the turn for a running command, and lets go once it completes', () => {
    const running = started('cmd-1', {
      name: 'run_command',
      kind: 'execute',
      title: 'sleep 5 && echo done',
      rawInput: { CommandLine: 'sleep 5 && echo done' },
    });
    expect(holdsTurn(running.tools)).toBe(true);
    // 后续 update 不再带 kind / rawInput，判定沿用开始时的
    const done = reduceAgyUpdate(running, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'cmd-1',
      status: 'completed',
    }).state;
    expect(holdsTurn(done.tools)).toBe(false);
  });

  it('holds for a pending command and a running agy subagent', () => {
    const pending = reduceAgyUpdate(emptyTranslatorState(), {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-2',
      status: 'pending',
      name: 'run_command',
      kind: 'execute',
      rawInput: { CommandLine: 'make' },
    }).state;
    expect(holdsTurn(pending.tools)).toBe(true);
    expect(
      holdsTurn(started('sub-1', { title: 'Running start_subagent', kind: 'other' }).tools)
    ).toBe(true);
  });

  it('does not hold for a daemon, a scheduled wake, or another native tool', () => {
    const daemon = started('cmd-3', {
      name: 'run_command',
      kind: 'execute',
      rawInput: { CommandLine: 'pnpm dev', IsDaemon: true },
    });
    const schedule = started('wake-1', {
      kind: 'other',
      title: 'Run schedule',
      rawInput: { DurationSeconds: 30, Prompt: 'Reply DONE.' },
    });
    const list = started('ls-1', {
      kind: 'other',
      title: 'Run list_dir',
      rawInput: { DirectoryPath: '/w' },
    });
    expect(holdsTurn([...daemon.tools, ...schedule.tools, ...list.tools])).toBe(false);
  });
});

describe('reduceAgyUpdate', () => {
  it('keeps the context size from the latest usage_update, and ignores malformed ones', () => {
    const first = reduceAgyUpdate(emptyTranslatorState(), {
      sessionUpdate: 'usage_update',
      used: 30_000,
      size: 1_048_576,
    });
    expect(first.effects).toEqual([]);
    expect(first.state.context).toEqual({ used: 30_000, size: 1_048_576 });
    const later = reduceAgyUpdate(first.state, {
      sessionUpdate: 'usage_update',
      used: 31_000,
      size: 250_000,
    });
    expect(later.state.context).toEqual({ used: 31_000, size: 250_000 });
    for (const bad of [
      { sessionUpdate: 'usage_update' },
      { sessionUpdate: 'usage_update', used: '5', size: 10 },
      { sessionUpdate: 'usage_update', used: -1, size: 10 },
      { sessionUpdate: 'usage_update', used: Number.NaN },
    ]) {
      expect(reduceAgyUpdate(later.state, bad).state.context).toEqual(later.state.context);
    }
    // size 缺省时仍记 used
    expect(
      reduceAgyUpdate(emptyTranslatorState(), { sessionUpdate: 'usage_update', used: 12 }).state
        .context
    ).toEqual({ used: 12 });
  });

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

  // agy 1.5.18 的真实形状：update 上带 name / args，title 是给人看的，rawOutput 是对象
  it('reads the tool name and output agy 1.5.18 sends', () => {
    const path = '/private/tmp/w/note.txt';
    const read = reduceAgyUpdate(emptyTranslatorState(), {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      name: 'read_file',
      args: { Path: path },
      status: 'in_progress',
      kind: 'read',
      title: 'File note.txt',
      locations: [{ path }],
      rawInput: { Path: path },
    });
    expect(read.effects[0]).toMatchObject({ name: 'read_file', args: { path } });
    const started = reduceAgyUpdate(emptyTranslatorState(), {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_2',
      name: 'run_command',
      status: 'in_progress',
      kind: 'execute',
      title: 'echo ok',
      rawInput: { CommandLine: 'echo ok', WaitMsBeforeAsync: 5000, toolSummary: 'Echo' },
    });
    const done = reduceAgyUpdate(started.state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_2',
      name: 'run_command',
      status: 'completed',
      kind: 'execute',
      title: 'echo ok',
      rawInput: { CommandLine: 'echo ok', WaitMsBeforeAsync: 5000, toolSummary: 'Echo' },
      rawOutput: { output: 'Command exited with code 0.\n\nCommand output:\nok\r\n', exit_code: 0 },
      content: [{ type: 'content', content: { type: 'text', text: 'from content' } }],
    });
    expect(started.effects[0]).toMatchObject({ name: 'run_command', args: { command: 'echo ok' } });
    expect(done.state.tools[0]).toMatchObject({ name: 'run_command', status: 'completed' });
    expect(done.state.tools[0]?.output).toContain('Command output:\nok');
  });

  it('drops the agy-side card of an Enso host MCP tool', () => {
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_3',
      name: 'mcp_enso_ask_user',
      status: 'in_progress',
      kind: 'other',
      title: 'Run mcp_enso_ask_user',
      rawInput: { question: 'why', toolSummary: 'Ask' },
    };
    const reduced = reduceAgyUpdate(emptyTranslatorState(), update);
    expect(reduced.effects).toEqual([]);
    expect(reduced.state.tools).toEqual([]);
    const other = reduceAgyUpdate(emptyTranslatorState(), {
      ...update,
      name: 'mcp_github_list',
      title: 'Run mcp_github_list',
    });
    expect(other.effects[0]).toMatchObject({ name: 'mcp_github_list' });
  });

  it('drops the card of an Enso tool agy proxies through call_mcp_tool, follow-ups included', () => {
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_4',
      name: 'call_mcp_tool',
      status: 'pending',
      kind: 'other',
      title: 'MCP Tool subagent',
      rawInput: { ServerName: 'enso', ToolName: 'subagent', Arguments: { operation: 'spawn' } },
    };
    const started = reduceAgyUpdate(emptyTranslatorState(), update);
    expect(started.effects).toEqual([]);
    expect(started.state.tools).toEqual([]);
    // 后续 update 只带 id 和状态
    const done = reduceAgyUpdate(started.state, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_4',
      status: 'completed',
    });
    expect(done.effects).toEqual([]);
    expect(done.state.tools).toEqual([]);
    // 无名、只有 title 的形状也认
    const { name: _name, ...titled } = update;
    expect(reduceAgyUpdate(emptyTranslatorState(), titled).effects).toEqual([]);
  });

  it('keeps proxied calls to other servers and look-alikes', () => {
    const base = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_5',
      status: 'pending',
      kind: 'other',
    };
    for (const update of [
      {
        ...base,
        name: 'call_mcp_tool',
        title: 'MCP Tool subagent',
        rawInput: { ServerName: 'browse', ToolName: 'subagent' },
      },
      {
        ...base,
        name: 'call_mcp_tool',
        title: 'MCP Tool create_issue',
        rawInput: { ServerName: 'enso', ToolName: 'subagent' },
      },
      {
        ...base,
        name: 'mcp_github_create_issue',
        title: 'Run mcp_github_create_issue',
        rawInput: { ServerName: 'enso', ToolName: 'subagent' },
      },
    ]) {
      expect(reduceAgyUpdate(emptyTranslatorState(), update).effects).toHaveLength(1);
    }
  });
});

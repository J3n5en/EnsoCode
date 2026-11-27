import { describe, expect, it } from 'vitest';
import { decidePermission, permissionOutcome, sessionModeFor } from './permission';

const options = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow' },
  { optionId: 'always', kind: 'allow_always', name: 'Always' },
  { optionId: 'no', kind: 'reject_once', name: 'Deny' },
];

const edit = {
  toolCall: {
    toolCallId: 't1',
    title: 'edit src/a.ts',
    kind: 'edit',
    rawInput: { path: '/work/src/a.ts' },
  },
  options,
};

describe('decidePermission', () => {
  it('asks in supervised and assistant, and allows in-workspace edits in auto-edits', () => {
    expect(
      decidePermission({ approvalMode: 'supervised', request: edit, workspaceRoot: '/work' })
    ).toEqual({
      kind: 'ask',
    });
    expect(
      decidePermission({ approvalMode: 'assistant', request: edit, workspaceRoot: '/work' })
    ).toEqual({
      kind: 'ask',
    });
    expect(
      decidePermission({ approvalMode: 'auto-edits', request: edit, workspaceRoot: '/work' })
    ).toEqual({
      kind: 'selected',
      optionId: 'once',
    });
  });

  it('asks auto-edits when a path leaves the workspace or the call is not an edit', () => {
    expect(
      decidePermission({
        approvalMode: 'auto-edits',
        workspaceRoot: '/work',
        request: {
          ...edit,
          toolCall: { ...edit.toolCall, rawInput: { path: '/etc/passwd' } },
        },
      })
    ).toEqual({ kind: 'ask' });
    expect(
      decidePermission({
        approvalMode: 'auto-edits',
        workspaceRoot: '/work',
        request: {
          toolCall: {
            toolCallId: 't2',
            title: 'run tests',
            kind: 'execute',
            rawInput: { command: 'ls' },
          },
          options,
        },
      })
    ).toEqual({ kind: 'ask' });
  });

  it('allows once in full, and falls back to allow_always when once is missing', () => {
    expect(
      decidePermission({ approvalMode: 'full', request: edit, workspaceRoot: '/work' })
    ).toEqual({
      kind: 'selected',
      optionId: 'once',
    });
    expect(
      decidePermission({
        approvalMode: 'full',
        workspaceRoot: '/work',
        request: { ...edit, options: options.filter((option) => option.kind !== 'allow_once') },
      })
    ).toEqual({ kind: 'selected', optionId: 'always' });
  });

  it('maps a user decision onto the option agy offered', () => {
    expect(permissionOutcome('allow', options)).toEqual({ outcome: 'selected', optionId: 'once' });
    expect(permissionOutcome('allowSession', options)).toEqual({
      outcome: 'selected',
      optionId: 'always',
    });
    expect(
      permissionOutcome(
        'allowSession',
        options.filter((option) => option.kind !== 'allow_always')
      )
    ).toEqual({
      outcome: 'selected',
      optionId: 'once',
    });
    expect(permissionOutcome('deny', options)).toEqual({ outcome: 'selected', optionId: 'no' });
    expect(permissionOutcome('cancel', options)).toEqual({ outcome: 'cancelled' });
  });

  it('sends plan only while Enso is in plan mode', () => {
    expect(sessionModeFor(true)).toBe('plan');
    expect(sessionModeFor(false)).toBe('default');
  });
});

describe('Enso Host MCP tools', () => {
  // agy 1.5.18 线上形状：name / title 指向 mcp_enso_<tool>，只给 allow / deny
  const own = {
    toolCall: {
      toolCallId: 'm1',
      name: 'mcp_enso_todo',
      title: 'Run mcp_enso_todo',
      kind: 'other',
      rawInput: { todos: [] },
    },
    options: [
      { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
    ],
  };
  const modes = ['supervised', 'assistant', 'auto-edits', 'full'] as const;

  it('allows our own exposed tools once in every approval mode', () => {
    for (const approvalMode of modes) {
      expect(
        decidePermission({
          approvalMode,
          request: own,
          workspaceRoot: '/work',
          ensoTools: ['todo'],
        })
      ).toEqual({ kind: 'selected', optionId: 'allow' });
    }
  });

  it('recognizes the title alone, with or without a trailing question mark', () => {
    const { name: _name, ...toolCall } = own.toolCall;
    for (const title of ['Run mcp_enso_todo', 'Run mcp_enso_todo?']) {
      expect(
        decidePermission({
          approvalMode: 'supervised',
          request: { ...own, toolCall: { ...toolCall, title } },
          workspaceRoot: '/work',
          ensoTools: ['todo'],
        })
      ).toEqual({ kind: 'selected', optionId: 'allow' });
    }
  });

  it('asks for tools we did not expose, other servers, and commands', () => {
    const asks = [
      { ensoTools: [] as string[], request: own },
      { ensoTools: undefined, request: own },
      {
        ensoTools: ['todo'],
        request: {
          ...own,
          toolCall: { ...own.toolCall, name: 'mcp_other_todo', title: 'Run mcp_other_todo' },
        },
      },
      {
        ensoTools: ['todo'],
        request: {
          ...own,
          toolCall: {
            ...own.toolCall,
            name: 'run_command',
            title: 'Run mcp_enso_todo',
            kind: 'execute',
            rawInput: { CommandLine: 'mcp_enso_todo' },
          },
        },
      },
    ];
    for (const { ensoTools, request } of asks) {
      expect(
        decidePermission({ approvalMode: 'supervised', request, workspaceRoot: '/work', ensoTools })
      ).toEqual({ kind: 'ask' });
    }
  });

  // agy 把预算外的 MCP 工具经 call_mcp_tool 转调：title `MCP Tool <tool>`，rawInput 写明服务器和工具（同 t3）
  const proxied = (title: string, rawInput?: Record<string, unknown>, name?: string) => ({
    toolCall: {
      toolCallId: 'p1',
      ...(name ? { name } : {}),
      title,
      kind: 'other',
      ...(rawInput ? { rawInput } : {}),
    },
    options: own.options,
  });

  it('allows an exposed Enso tool proxied through call_mcp_tool in every approval mode', () => {
    for (const approvalMode of modes) {
      for (const request of [
        proxied('MCP Tool subagent', { ServerName: 'enso', ToolName: 'subagent', Arguments: {} }),
        proxied('MCP Tool subagent?', { ServerName: 'enso', ToolName: 'subagent' }),
        proxied('MCP Tool subagent', { ServerName: 'enso', ToolName: 'subagent' }, 'call_mcp_tool'),
      ]) {
        expect(
          decidePermission({
            approvalMode,
            request,
            workspaceRoot: '/work',
            ensoTools: ['subagent'],
          })
        ).toEqual({ kind: 'selected', optionId: 'allow' });
      }
    }
  });

  it('asks for proxied calls to other servers, unexposed tools and look-alikes', () => {
    for (const request of [
      proxied('MCP Tool subagent', { ServerName: 'other', ToolName: 'subagent' }),
      proxied('MCP Tool subagent'),
      // 没挂出去的工具
      proxied('MCP Tool workflow', { ServerName: 'enso', ToolName: 'workflow' }),
      // call_mcp_tool 的 title 就是它调的工具
      proxied('MCP Tool create_issue', { ServerName: 'enso', ToolName: 'subagent' }),
      // 直接调用的工具，rawInput 是它自己的参数，叫什么都不算
      proxied('Run mcp_github_create_issue', { ServerName: 'enso', ToolName: 'subagent' }),
      proxied(
        'Run mcp_github_create_issue',
        { ServerName: 'enso', ToolName: 'subagent' },
        'mcp_github_create_issue'
      ),
      proxied('Running create_issue', { ServerName: 'enso', ToolName: 'subagent' }),
      proxied('MCP Tool subagent', { ServerName: 'enso', ToolName: 'subagent' }, 'run_command'),
      proxied('MCP Tool subagent', {
        ServerName: 'enso',
        ToolName: 'subagent',
        CommandLine: 'MCP Tool subagent',
      }),
    ]) {
      expect(
        decidePermission({
          approvalMode: 'supervised',
          request,
          workspaceRoot: '/work',
          ensoTools: ['subagent'],
        })
      ).toEqual({ kind: 'ask' });
    }
  });
});

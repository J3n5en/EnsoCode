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

import { workspaceBranchChangedNote } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  consumeBranchContext,
  WorkspaceSwitchGate,
  workspaceBranchContextExtension,
} from './workspaceSwitch';

const session = (id: string, parentId?: string) => ({
  identity: { sessionId: id, generation: `${id}-generation` },
  parentId,
  pendingBranch: undefined as string | undefined,
});

function fixture() {
  const parent = session('root');
  const child = session('child', 'root');
  const grandchild = session('grandchild', 'child');
  const other = session('other');
  const sessions = new Map(
    [parent, child, grandchild, other].map((s) => [s.identity.sessionId, s])
  );
  return { parent, child, grandchild, other, sessions, gate: new WorkspaceSwitchGate(sessions) };
}

async function flush() {
  await Promise.resolve();
}

describe('WorkspaceSwitchGate', () => {
  it('branch context extension injects a hidden message instead of forcing the system prompt', async () => {
    const current: { pendingBranch?: string; pendingBranchRequestId?: string } = {
      pendingBranch: 'feature/new',
      pendingBranchRequestId: 'req-1',
    };
    const consumed = vi.fn();
    let handler:
      | ((event: { messageType: 'user'; prompt: string; systemPrompt: string }) => unknown)
      | undefined;
    const extension = workspaceBranchContextExtension(() => current, consumed) as {
      factory: (pi: unknown) => void;
    };
    extension.factory({
      on: (_event: string, fn: typeof handler) => {
        handler = fn;
      },
    });
    const first = await handler?.({
      messageType: 'user',
      prompt: 'real input',
      systemPrompt: 'base',
    });
    expect(first).toEqual({
      message: {
        customType: 'enso-branch-context',
        content: workspaceBranchChangedNote('feature/new'),
        display: false,
      },
    });
    expect(consumed).toHaveBeenCalledWith('req-1');
    expect(
      await handler?.({ messageType: 'user', prompt: 'next', systemPrompt: 'base' })
    ).toBeUndefined();

    current.pendingBranch = 'feature/new';
    const note = workspaceBranchChangedNote('feature/new');
    expect(
      await handler?.({ messageType: 'user', prompt: `${note}\n\ninput`, systemPrompt: 'base' })
    ).toBeUndefined();
    expect(current.pendingBranch).toBeUndefined();
  });

  it('custom 启动没有 prompt 时仍注入一次分支提示并确认消费', async () => {
    const current: { pendingBranch?: string; pendingBranchRequestId?: string } = {
      pendingBranch: 'feature/new',
      pendingBranchRequestId: 'req-custom',
    };
    const consumed = vi.fn();
    let handler: ((event: Record<string, unknown>) => unknown) | undefined;
    const extension = workspaceBranchContextExtension(() => current, consumed) as {
      factory: (pi: unknown) => void;
    };
    extension.factory({
      on: (_event: string, fn: typeof handler) => {
        handler = fn;
      },
    });
    const event = {
      messageType: 'custom',
      message: { customType: 'extension-task', content: 'continue task', display: false },
      systemPrompt: 'base',
    };
    await expect(Promise.resolve().then(() => handler?.(event))).resolves.toEqual({
      message: {
        customType: 'enso-branch-context',
        content: workspaceBranchChangedNote('feature/new'),
        display: false,
      },
    });
    expect(current.pendingBranch).toBeUndefined();
    expect(current.pendingBranchRequestId).toBeUndefined();
    expect(consumed).toHaveBeenCalledExactlyOnceWith('req-custom');
    expect(await handler?.(event)).toBeUndefined();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('consumes but does not duplicate the same branch background already attached to real input', () => {
    const current = { pendingBranch: 'feature/new' };
    const input = `${workspaceBranchChangedNote('feature/new')}\n\nreal user input`;
    expect(consumeBranchContext(current, 'base system', input)).toBe('base system');
    expect(current.pendingBranch).toBeUndefined();
    expect(
      consumeBranchContext({ pendingBranch: 'feature/other' }, 'base system', input)
    ).toContain('feature/other');
  });

  it('checks the full live tree atomically and never freezes unrelated sessions', () => {
    const { gate, grandchild } = fixture();
    expect(gate.lock('busy', ['root'], (s) => s === grandchild)).toBe(false);
    expect(gate.isLocked('root')).toBe(false);
    expect(gate.lock('ok', ['root'], () => false)).toBe(true);
    expect(gate.isLocked('grandchild')).toBe(true);
    expect(gate.isLocked('other')).toBe(false);
    expect(gate.lock('overlap', ['child'], () => false)).toBe(false);
  });

  it('installs branch context without creating a turn and each session consumes once', async () => {
    const { gate, parent, child, other } = fixture();
    const delivered = vi.fn();
    gate.lock('switch', ['root'], () => false);
    gate.defer('child', () => delivered(consumeBranchContext(child, 'real input')));
    expect(delivered).not.toHaveBeenCalled();
    expect(parent.pendingBranch).toBeUndefined();
    expect(gate.unlock('switch', ['root'], 'feature/new')).toBe(true);
    expect(delivered).not.toHaveBeenCalled();
    await flush();
    expect(delivered).toHaveBeenCalledWith(expect.stringContaining('feature/new'));
    expect(consumeBranchContext(child, 'second input')).toBe('second input');
    expect(consumeBranchContext(parent, 'first input')).toContain('Re-read');
    expect(consumeBranchContext(other, 'input')).toBe('input');
  });

  it('old nonce and wrong scope cannot release a newer lock', async () => {
    const { gate, child } = fixture();
    gate.lock('old', ['root'], () => false);
    gate.unlock('old', ['root']);
    gate.lock('new', ['root'], () => false);
    const notify = vi.fn();
    gate.defer('child', notify);
    gate.unlock('old', ['root'], 'wrong');
    expect(gate.unlock('new', ['other'])).toBe(false);
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(child.pendingBranch).toBeUndefined();
    expect(gate.unlock('new', ['root'])).toBe(true);
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('repeated successful unlock acknowledges without reinstalling consumed context', () => {
    const { gate, parent } = fixture();
    gate.lock('switch', ['root'], () => false);
    expect(gate.unlock('switch', ['root'], 'new')).toBe(true);
    consumeBranchContext(parent, 'first');
    expect(gate.unlock('switch', ['root'], 'new')).toBe(true);
    expect(parent.pendingBranch).toBeUndefined();
    expect(gate.unlock('switch', ['other'], 'new')).toBe(false);
    expect(gate.unlock('switch', ['root'], 'wrong')).toBe(false);
  });

  it('replacement generations receive neither old context nor deferred wakeups', async () => {
    const { gate, sessions, child } = fixture();
    gate.lock('switch', ['root'], () => false);
    const notify = vi.fn();
    gate.defer('child', notify);
    const replacement = session('child', 'root');
    replacement.identity.generation = 'new-generation';
    sessions.set('child', replacement);
    gate.unlock('switch', ['root'], 'new-branch');
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(replacement.pendingBranch).toBeUndefined();
    expect(child.pendingBranch).toBeUndefined();
  });

  it('timeout cleanup prevents late lock acquisition and does not leave a deadlock', () => {
    const { gate } = fixture();
    expect(gate.unlock('timed-out', ['root'])).toBe(true);
    expect(gate.lock('timed-out', ['root'], () => false)).toBe(false);
    expect(gate.lock('fresh', ['root'], () => false)).toBe(true);
    gate.clear();
    expect(gate.isLocked('child')).toBe(false);
  });

  it('shutdown and generation replacement cancel deferred promise owners', async () => {
    const { gate, sessions } = fixture();
    const cancelled = vi.fn();
    gate.lock('one', ['root'], () => false);
    gate.defer('child', vi.fn(), cancelled);
    sessions.delete('child');
    gate.unlock('one', ['root']);
    await flush();
    expect(cancelled).toHaveBeenCalledTimes(1);
    gate.lock('two', ['root'], () => false);
    gate.defer('root', vi.fn(), cancelled);
    gate.clear();
    expect(cancelled).toHaveBeenCalledTimes(2);
  });
});

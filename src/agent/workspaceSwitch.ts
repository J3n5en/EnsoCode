import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { type SessionIdentity, workspaceBranchChangedNote } from '@shared/types/agent';

interface Session {
  identity: SessionIdentity;
  parentId?: string;
  pendingBranch?: string;
  pendingBranchRequestId?: string;
}

interface Lock<T> {
  roots: Set<string>;
  sessions: Set<T>;
  deferred: Array<{ run: () => void; cancel: () => void }>;
}

/** Main owns the physical-path lock; this gate only freezes worker-local wakeups. */
export class WorkspaceSwitchGate<T extends Session> {
  private readonly locks = new Map<string, Lock<T>>();
  private readonly retired = new Map<string, { roots: Set<string>; branch?: string }>();
  private closed = false;

  constructor(private readonly sessions: Map<string, T>) {}

  private lockFor(id: string): Lock<T> | undefined {
    for (const lock of this.locks.values()) {
      if (lock.roots.has(id) || [...lock.sessions].some((s) => s.identity.sessionId === id))
        return lock;
    }
    return undefined;
  }

  isLocked(id: string): boolean {
    return this.lockFor(id) !== undefined;
  }

  lock(requestId: string, ids: string[], busy: (session: T) => boolean): boolean {
    if (
      this.closed ||
      this.retired.has(requestId) ||
      this.locks.has(requestId) ||
      ids.some((id) => this.isLocked(id))
    )
      return false;
    const roots = new Set(ids);
    const affected = new Set<T>();
    const selected = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const session of this.sessions.values()) {
        if (affected.has(session)) continue;
        if (
          selected.has(session.identity.sessionId) ||
          (session.parentId && selected.has(session.parentId))
        ) {
          affected.add(session);
          selected.add(session.identity.sessionId);
          changed = true;
        }
      }
    }
    if ([...affected].some((s) => this.isLocked(s.identity.sessionId) || busy(s))) return false;
    this.locks.set(requestId, { roots, sessions: affected, deferred: [] });
    return true;
  }

  defer(id: string, action: () => void, cancel: () => void = () => {}): boolean {
    const lock = this.lockFor(id);
    if (!lock) return false;
    const session = this.sessions.get(id);
    lock.deferred.push({
      run: () => {
        if (!this.closed && this.sessions.get(id) === session) action();
        else cancel();
      },
      cancel,
    });
    return true;
  }

  unlock(requestId: string, ids: string[], branch?: string): boolean {
    const lock = this.locks.get(requestId);
    // Failed/timeout acquisition cleanup is idempotent, but never releases another nonce.
    if (!lock) {
      const retired = this.retired.get(requestId);
      if (!retired) this.retired.set(requestId, { roots: new Set(ids) });
      return (
        branch === undefined ||
        (!!retired &&
          retired.branch === branch &&
          ids.length === retired.roots.size &&
          ids.every((id) => retired.roots.has(id)))
      );
    }
    if (ids.length !== lock.roots.size || ids.some((id) => !lock.roots.has(id))) return false;
    for (const session of lock.sessions) {
      if (branch !== undefined && this.sessions.get(session.identity.sessionId) === session) {
        session.pendingBranch = branch;
        session.pendingBranchRequestId = requestId;
      }
    }
    this.locks.delete(requestId);
    this.retired.set(requestId, { roots: lock.roots, branch });
    for (const action of lock.deferred) queueMicrotask(action.run);
    return true;
  }

  clear(): void {
    this.closed = true;
    for (const lock of this.locks.values()) {
      for (const action of lock.deferred) action.cancel();
    }
    this.locks.clear();
    this.retired.clear();
  }
}

export function workspaceBranchContextExtension(
  getSession: () => { pendingBranch?: string; pendingBranchRequestId?: string } | undefined,
  onConsumed?: (requestId: string) => void
): InlineExtension {
  return {
    name: 'workspace-branch-context',
    hidden: true,
    factory: (pi) => {
      pi.on('before_agent_start', (event) => {
        const session = getSession();
        if (session?.pendingBranch === undefined) return;
        const requestId = session.pendingBranchRequestId;
        const note = takeBranchContextNote(
          session,
          event.messageType === 'user' ? event.prompt : ''
        );
        if (requestId !== undefined) onConsumed?.(requestId);
        if (!note) return;
        return { message: { customType: 'enso-branch-context', content: note, display: false } };
      });
    },
  };
}

function takeBranchContextNote(
  session: { pendingBranch?: string; pendingBranchRequestId?: string },
  input: string
): string | undefined {
  if (session.pendingBranch === undefined) return undefined;
  const branch = session.pendingBranch;
  session.pendingBranch = undefined;
  session.pendingBranchRequestId = undefined;
  const note = workspaceBranchChangedNote(branch);
  return input.includes(note) ? undefined : note;
}

export function consumeBranchContext(
  session: { pendingBranch?: string; pendingBranchRequestId?: string },
  text: string,
  input = ''
): string {
  const note = takeBranchContextNote(session, input);
  return note ? `${note}\n\n${text}` : text;
}

import type { ProjectAuthority } from '../types/agent';
import type {
  DispatchDraft,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryProposal,
} from '../types/secretary';

export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export type DispatchDecision = 'direct' | 'direct-tell' | 'confirm';

export function dispatchDecision(profile: SecretaryProfile, projectId: string): DispatchDecision {
  if (profile.autonomy === 'ask-first') return 'confirm';
  if (!profile.autoApproveProjectIds.includes(projectId)) return 'confirm';
  return profile.autonomy === 'full' ? 'direct' : 'direct-tell';
}

export function canOperate(file: SecretaryDispatchFile, conversationId: string): boolean {
  return Object.hasOwn(file.dispatched, conversationId) || file.named.includes(conversationId);
}

export type ProposalAction =
  | { type: 'confirm' }
  | { type: 'reject' }
  | { type: 'expire' }
  | { type: 'finish'; ok: boolean; error?: string; conversationId?: string };

export function transitionProposal(
  proposal: SecretaryProposal,
  action: ProposalAction,
  now: number
): { proposal: SecretaryProposal; changed: boolean } {
  const unchanged = { proposal, changed: false };
  switch (action.type) {
    case 'confirm':
      if (proposal.status !== 'pending') return unchanged;
      return { proposal: { ...proposal, status: 'executing', updatedAt: now }, changed: true };
    case 'reject':
      if (proposal.status !== 'pending') return unchanged;
      return { proposal: { ...proposal, status: 'rejected', updatedAt: now }, changed: true };
    case 'expire':
      if (proposal.status !== 'pending' || now - proposal.createdAt < PROPOSAL_TTL_MS) {
        return unchanged;
      }
      return { proposal: { ...proposal, status: 'expired', updatedAt: now }, changed: true };
    case 'finish': {
      if (proposal.status !== 'executing') return unchanged;
      if (!action.ok) {
        return {
          proposal: { ...proposal, status: 'failed', error: action.error, updatedAt: now },
          changed: true,
        };
      }
      const { error: _stale, ...rest } = proposal;
      const succeeded = { ...rest, status: 'succeeded' as const, updatedAt: now };
      if (succeeded.kind !== 'dispatch' || !action.conversationId) {
        return { proposal: succeeded, changed: true };
      }
      return { proposal: { ...succeeded, conversationId: action.conversationId }, changed: true };
    }
  }
}

export interface DispatchContext {
  project?: ProjectAuthority;
  visible: boolean;
  running: number;
  max: number;
  worktreeMode: SecretaryProfile['dispatchWorktree'];
}

export function validateDispatch(
  draft: DispatchDraft,
  ctx: DispatchContext
): { ok: true; draft: DispatchDraft } | { ok: false; error: string } {
  const { project } = ctx;
  if (!project) return { ok: false, error: 'project-missing' };
  if (project.state !== 'active') return { ok: false, error: 'project-removed' };
  if ((project.kind ?? 'local') !== 'local') return { ok: false, error: 'project-not-local' };
  if (!ctx.visible) return { ok: false, error: 'project-not-visible' };
  if (ctx.running >= ctx.max) return { ok: false, error: 'dispatch-limit' };

  const worktree =
    ctx.worktreeMode === 'never' ? false : ctx.worktreeMode === 'always' ? true : draft.worktree;
  return { ok: true, draft: { ...draft, worktree } };
}

import type { ConversationAuthority, ProjectAuthority } from '../types/agent';
import type {
  DispatchDraft,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryProposal,
  SecretaryTakeoverScope,
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

/** 接管范围是否覆盖这个项目。explicit 与空勾选都等价于逐个授权 */
export function inTakeoverScope(
  scope: SecretaryTakeoverScope | undefined,
  projectId: string | undefined
): boolean {
  if (!scope || scope.mode === 'explicit') return false;
  if (scope.mode === 'all') return true;
  return projectId !== undefined && scope.projectIds.includes(projectId);
}

/** 秘书操作一个会话的权限来源：派出的、逐个授权的，或项目在接管范围内 */
export type OperateSource = 'dispatched' | 'granted' | 'scope';

/** 用户在会话界面点过 ×：范围权限不再覆盖它，只有重新逐个授权才恢复 */
export function isUntracked(
  file: Pick<SecretaryDispatchFile, 'untracked'>,
  conversationId: string
): boolean {
  return file.untracked?.includes(conversationId) === true;
}

/**
 * 发消息、停止会话的权限来源；null 表示没有权限。
 * 范围只给权限，不建记录：跟踪与推送从秘书真正用过这个会话开始。
 */
export function operateSource(
  file: SecretaryDispatchFile,
  conversationId: string,
  scope: SecretaryTakeoverScope | undefined,
  projectId: string | undefined
): OperateSource | null {
  const record = file.dispatched[conversationId];
  if (record) return record.takeover ? 'granted' : 'dispatched';
  if (file.named.includes(conversationId)) return 'granted';
  if (isUntracked(file, conversationId)) return null;
  return inTakeoverScope(scope, projectId) ? 'scope' : null;
}

export type TakeoverRefusal =
  | 'not-found'
  | 'bot-session'
  | 'secretary-session'
  | 'child-session'
  | 'archived'
  | 'not-visible'
  | 'already-managed';

export interface TakeoverTarget {
  conversationId: string;
  conversation?: ConversationAuthority;
  project?: ProjectAuthority;
  row?: Record<string, unknown>;
  /** 会话所属项目在秘书可见范围内 */
  visible: boolean;
}

/** 能否交给秘书接管；null 表示可以。秘书自己的会话、子会话、已归档与已有秘书管着的都不行 */
export function takeoverRefusal(
  file: SecretaryDispatchFile,
  target: TakeoverTarget
): TakeoverRefusal | null {
  const { conversation, project, row } = target;
  if (conversation?.kind !== 'root' || !project || !row) return 'not-found';
  if (conversation.bot || project.kind === 'bot-home') return 'bot-session';
  if (project.kind === 'secretary') return 'secretary-session';
  if (row.parentId !== undefined || row.btwParentId !== undefined) return 'child-session';
  if (row.archived === true) return 'archived';
  if (!target.visible) return 'not-visible';
  if (Object.hasOwn(file.dispatched, target.conversationId) || row.secretaryOrigin !== undefined)
    return 'already-managed';
  return null;
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

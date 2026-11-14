import type { AgentSpawnRequest, ApprovalMode, ThinkingLevel } from '@shared/types/agent';
import { APPROVAL_MODES, THINKING_LEVELS } from '@shared/types/agent';

export interface PersistedPairConversation {
  sessionId: string;
  projectId: string;
  sessionFile?: string;
  lastProviderId?: string;
  lastModelId?: string;
  reasoningEnabled?: boolean;
  thinkingLevel?: string;
  presetId?: string;
  approvalMode?: string;
  /** 无人值守：恢复后不能悄悄变回「等人确认」 */
  autoRejectApprovals?: boolean;
}

export type PairResumePlan =
  | { type: 'snapshot' }
  | { type: 'spawn'; request: AgentSpawnRequest }
  | { type: 'skip'; reason: string };

function asThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  return value && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

function asApprovalMode(value: string | undefined): ApprovalMode | undefined {
  return value && (APPROVAL_MODES as readonly string[]).includes(value)
    ? (value as ApprovalMode)
    : undefined;
}

/** 无窗时恢复会话：已在 worker 里的只补快照，否则按持久化元数据 spawn。 */
export function planPairResume(input: {
  alive: boolean;
  conversation: PersistedPairConversation | null;
  projectPath?: string;
  worktreePath?: string;
  worktreeMissing?: boolean;
  loadLocalSkills: boolean;
}): PairResumePlan {
  if (input.alive) return { type: 'snapshot' };
  const conversation = input.conversation;
  if (!conversation) return { type: 'skip', reason: 'unknown session' };
  if (!conversation.sessionFile) return { type: 'skip', reason: 'no session file' };
  if (input.worktreeMissing) return { type: 'skip', reason: 'worktree missing' };
  if (!conversation.lastProviderId || !conversation.lastModelId) {
    return { type: 'skip', reason: 'no remembered model' };
  }
  const cwd = input.worktreePath ?? input.projectPath;
  if (!cwd) return { type: 'skip', reason: 'no cwd' };
  const thinkingLevel = asThinkingLevel(conversation.thinkingLevel);
  const approvalMode = asApprovalMode(conversation.approvalMode);
  return {
    type: 'spawn',
    request: {
      sessionId: conversation.sessionId,
      providerId: conversation.lastProviderId,
      modelId: conversation.lastModelId,
      cwd,
      resumeFile: conversation.sessionFile,
      loadLocalSkills: input.loadLocalSkills,
      ...(conversation.reasoningEnabled ? { reasoningEnabled: true } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(conversation.presetId ? { presetId: conversation.presetId } : {}),
      ...(approvalMode ? { approvalMode } : {}),
      ...(conversation.autoRejectApprovals ? { autoRejectApprovals: true } : {}),
    },
  };
}

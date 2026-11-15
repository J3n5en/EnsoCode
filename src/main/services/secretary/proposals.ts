import {
  pendingProposalMatch,
  pendingProposalNote,
  proposalSignature,
} from '@shared/secretary/policy';
import type { SecretaryDispatchFile, SecretaryProposal } from '@shared/types/secretary';

/** 落一张卡的结果：复用还是新建，以及要不要提示同类卡还没处理 */
export interface SavedProposal {
  proposalId: string;
  /** 参数完全一致的那张卡已经在等：这次没有再新建 */
  reused: boolean;
  /** 同类但参数不同的卡还没处理完 */
  otherPendingId?: string;
  /** 给秘书看的一句话：卡已经在等，别再提一张 */
  note?: string;
}

/**
 * 把提案写进文件：同类同参的卡已经在等就复用，不再叠一张。
 * 只改传进来的 file；落盘与推送由调用方按 changed 决定。
 */
export function saveProposalRecord(
  file: SecretaryDispatchFile,
  proposal: SecretaryProposal
): { saved: SavedProposal; changed: boolean } {
  const match = pendingProposalMatch(file.proposals, proposal.secretaryConversationId, {
    kind: proposal.kind,
    signature: proposalSignature(proposal),
  });
  const note = pendingProposalNote(match);
  if (match.same)
    return {
      saved: { proposalId: match.same.id, reused: true, ...(note ? { note } : {}) },
      changed: false,
    };
  file.proposals[proposal.id] = proposal;
  return {
    saved: {
      proposalId: proposal.id,
      reused: false,
      ...(match.other ? { otherPendingId: match.other.id } : {}),
      ...(note ? { note } : {}),
    },
    changed: true,
  };
}

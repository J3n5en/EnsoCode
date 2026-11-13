import { projectDisplayName } from '@shared/projectName';
import type { ProposalStatus, SecretaryProposal } from '@shared/types/secretary';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { useSettingsStore } from '@/stores/settings';

/** 会产出待确认提案的派活工具；profile 提案归设置页，不在聊天里出卡片 */
const PROPOSAL_TOOLS = new Set(['session_create', 'todo_item_dispatch']);

/**
 * 工具结果里的待确认提案 id。只有派活工具真的走了确认才返回，
 * 已建成的结果与报错仍按普通工具行渲染。
 */
export function secretaryProposalId(item: {
  name: string;
  output: string | null;
  state: string;
}): string | null {
  if (!PROPOSAL_TOOLS.has(item.name)) return null;
  if (item.state === 'running' || item.state === 'error') return null;
  if (!item.output) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.output);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  return record.status === 'awaiting_confirmation' && typeof record.proposalId === 'string'
    ? record.proposalId
    : null;
}

const STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: 'Waiting for your confirmation',
  executing: 'Creating the session…',
  succeeded: 'Session created',
  failed: 'Failed',
  rejected: 'Rejected',
  expired: 'Expired',
};

/** 卡片标题：用户/秘书给的标题优先，否则取首句 */
function dispatchTitle(proposal: Extract<SecretaryProposal, { kind: 'dispatch' }>): string {
  return proposal.draft.title?.trim() || proposal.draft.prompt.split('\n')[0]?.trim() || '';
}

export function SecretaryProposalRow({ proposalId }: { proposalId: string }) {
  const { t } = useI18n();
  const proposal = useSecretaryStore((state) => state.secretary.proposals[proposalId]);
  const resolving = useSecretaryStore((state) => state.resolving[proposalId] === true);
  const resolveProposal = useSecretaryStore((state) => state.resolveProposal);
  const projects = useSettingsStore((state) => state.projects);

  // 状态推送还没到时只占位：卡片不能把这一行吞掉
  if (!proposal) {
    return (
      <div
        data-enso="secretary-proposal"
        className="mb-1 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground"
      >
        {t('Waiting for your confirmation')}
      </div>
    );
  }
  if (proposal.kind !== 'dispatch') return null;

  const project = projects.find((entry) => entry.id === proposal.draft.projectId);
  const failed = proposal.status === 'failed';

  return (
    <div
      data-enso="secretary-proposal"
      className="mb-1 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('Dispatch')}
        </span>
        {project && (
          <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
            {projectDisplayName(project)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{dispatchTitle(proposal)}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
          {proposal.draft.worktree ? t('Isolated worktree') : t('Project checkout')}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={cn('text-[11px]', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {t(STATUS_LABELS[proposal.status])}
          {failed && proposal.error ? ` · ${proposal.error}` : ''}
        </span>
        {proposal.status === 'pending' && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              disabled={resolving}
              onClick={() => void resolveProposal(proposal.id, 'confirm')}
              className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {t('Confirm dispatch')}
            </button>
            <button
              type="button"
              disabled={resolving}
              onClick={() => void resolveProposal(proposal.id, 'reject')}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {t('Reject')}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

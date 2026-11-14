import { projectDisplayName } from '@shared/projectName';
import type { ProposalStatus, SecretaryProposal } from '@shared/types/secretary';
import * as React from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { useSettingsStore } from '@/stores/settings';
import { draftFromProfile } from './profileFormState';
import { AUTONOMY_LABELS, WORKTREE_LABELS } from './profileLabels';
import { SecretaryProfileForm } from './SecretaryProfileForm';

/** 会产出待确认提案的工具：派活两个，加上秘书提交的配置草案 */
const PROPOSAL_TOOLS = new Set([
  'session_create',
  'todo_item_dispatch',
  'secretary_profile_propose',
]);

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

const PROFILE_STATUS_LABELS: Record<ProposalStatus, string> = {
  ...STATUS_LABELS,
  executing: 'Saving the profile…',
  succeeded: 'Profile saved',
};

/** 工作台里待处理的提案要醒目：警告色细边 + 淡底 */
function cardClass(prominent?: boolean): string {
  return cn(
    'mb-1 rounded-lg border px-2.5 py-2',
    prominent ? 'border-warning/40 bg-warning/5' : 'border-border/60 bg-muted/20'
  );
}

/** 卡片标题：用户/秘书给的标题优先，否则取首句 */
function dispatchTitle(proposal: Extract<SecretaryProposal, { kind: 'dispatch' }>): string {
  return proposal.draft.title?.trim() || proposal.draft.prompt.split('\n')[0]?.trim() || '';
}

export function SecretaryProposalRow({
  proposalId,
  prominent,
}: {
  proposalId: string;
  prominent?: boolean;
}) {
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
        className={cn(cardClass(prominent), 'text-[11px] text-muted-foreground')}
      >
        {t('Waiting for your confirmation')}
      </div>
    );
  }
  if (proposal.kind === 'profile')
    return <ProfileProposalCard proposal={proposal} prominent={prominent} />;

  const project = projects.find((entry) => entry.id === proposal.draft.projectId);
  const failed = proposal.status === 'failed';

  return (
    <div data-enso="secretary-proposal" className={cardClass(prominent)}>
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

/**
 * 配置草案卡片：秘书只能提案，用户点确认后 Main 才写入。
 * 「就地修改」复用三步表单，确认时把改过的整份草案交给 Main。
 */
function ProfileProposalCard({
  proposal,
  prominent,
}: {
  proposal: Extract<SecretaryProposal, { kind: 'profile' }>;
  prominent?: boolean;
}) {
  const { t } = useI18n();
  const resolving = useSecretaryStore((state) => state.resolving[proposal.id] === true);
  const resolveProposal = useSecretaryStore((state) => state.resolveProposal);
  const [editing, setEditing] = React.useState(false);
  const draft = proposal.draft;
  const failed = proposal.status === 'failed';
  const initialDraft = React.useMemo(
    () => ({ ...draftFromProfile(null, t('Secretary')), ...draft }),
    [draft, t]
  );

  return (
    <div data-enso="secretary-proposal" data-kind="profile" className={cardClass(prominent)}>
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('Profile')}
        </span>
        <span className="min-w-0 flex-1 truncate">{draft.name ?? t('Secretary')}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
          {draft.model ? draft.model.modelId : t('Follows the default model')}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        <span>{t(AUTONOMY_LABELS[draft.autonomy ?? 'ask-first'])}</span>
        <span aria-hidden>·</span>
        <span>{t(WORKTREE_LABELS[draft.dispatchWorktree ?? 'auto'])}</span>
        <span aria-hidden>·</span>
        <span>{t('Up to {{n}} at a time', { n: draft.maxRunningDispatches ?? 3 })}</span>
      </div>
      {editing ? (
        <div className="mt-2 border-t border-border/60 pt-2">
          <SecretaryProfileForm
            initialDraft={initialDraft}
            submitLabel={t('Confirm')}
            busy={resolving}
            onSubmit={(next) => {
              setEditing(false);
              void resolveProposal(proposal.id, 'confirm', undefined, next);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span
            className={cn('text-[11px]', failed ? 'text-destructive' : 'text-muted-foreground')}
          >
            {t(PROFILE_STATUS_LABELS[proposal.status])}
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
                {t('Confirm')}
              </button>
              <button
                type="button"
                disabled={resolving}
                onClick={() => void resolveProposal(proposal.id, 'reject')}
                className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {t('Reject')}
              </button>
              <button
                type="button"
                data-enso="secretary-proposal-edit"
                disabled={resolving}
                onClick={() => setEditing(true)}
                className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {t('Edit here')}
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

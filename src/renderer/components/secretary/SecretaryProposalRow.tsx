import { projectDisplayName } from '@shared/projectName';
import type { CleanupItem, ProposalStatus, SecretaryProposal } from '@shared/types/secretary';
import * as React from 'react';
import { useI18n } from '@/i18n';
import { modelLabel } from '@/lib/modelLabel';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { useSettingsStore } from '@/stores/settings';
import { draftFromProfile } from './profileFormState';
import { SecretaryProfileForm } from './SecretaryProfileForm';

/** 会产出待确认提案的工具：派活两个，加上秘书提交的配置草案 */
const PROPOSAL_TOOLS = new Set([
  'session_create',
  'todo_item_dispatch',
  'secretary_profile_propose',
  'skill_propose',
  'tool_propose',
  'session_takeover_propose',
  'cleanup_apply',
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
    'mb-1 w-full rounded-lg border px-2.5 py-2',
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
  const providers = useSettingsStore((state) => state.providers) ?? [];
  const virtualModels = useSettingsStore((state) => state.virtualModels);

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
  if (proposal.kind === 'skill')
    return <SkillProposalCard proposal={proposal} prominent={prominent} />;
  if (proposal.kind === 'tool')
    return <ToolProposalCard proposal={proposal} prominent={prominent} />;
  if (proposal.kind === 'takeover')
    return <TakeoverProposalCard proposal={proposal} prominent={prominent} />;
  if (proposal.kind === 'cleanup')
    return <CleanupProposalCard proposal={proposal} prominent={prominent} />;

  const project = projects.find((entry) => entry.id === proposal.draft.projectId);
  const failed = proposal.status === 'failed';
  const model = modelLabel(providers, proposal.draft.model, virtualModels);

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
      {(proposal.draft.branch ||
        proposal.draft.baseRef ||
        model ||
        (proposal.draft.after?.length ?? 0) > 0) && (
        <div
          data-enso="secretary-proposal-base"
          className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground"
        >
          {proposal.draft.branch && <span>{proposal.draft.branch}</span>}
          {proposal.draft.baseRef && (
            <span>{t('from {{ref}}', { ref: proposal.draft.baseRef })}</span>
          )}
          {model && (
            <span data-enso="secretary-proposal-model">{t('Model: {{model}}', { model })}</span>
          )}
          {proposal.draft.after && proposal.draft.after.length > 0 && (
            <span>{t('After {{ids}}', { ids: proposal.draft.after.join(', ') })}</span>
          )}
        </div>
      )}
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
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        <span>{t('Up to {{n}} at a time', { n: draft.maxRunningDispatches ?? 3 })}</span>
        <span aria-hidden>·</span>
        <span>{t(draft.patrolEnabled === false ? 'Patrol off' : 'Patrol on')}</span>
        <span>
          {t(draft.cleanupSkipConfirm ? 'Cleanup without confirmation' : 'Cleanup asks first')}
        </span>
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

const SKILL_STATUS_LABELS: Record<ProposalStatus, string> = {
  ...STATUS_LABELS,
  executing: 'Saving the skill…',
  succeeded: 'Skill saved',
};

const TOOL_STATUS_LABELS: Record<ProposalStatus, string> = {
  ...STATUS_LABELS,
  executing: 'Saving the tool…',
  succeeded: 'Tool saved',
};

const TAKEOVER_STATUS_LABELS: Record<ProposalStatus, string> = {
  ...STATUS_LABELS,
  executing: 'Handing it over…',
  succeeded: 'Handed over to the secretary',
};

/** 接管申请卡片：用户点同意后秘书才能给这个会话发消息、停止它；之后可在会话里或设置页收回 */
function TakeoverProposalCard({
  proposal,
  prominent,
}: {
  proposal: Extract<SecretaryProposal, { kind: 'takeover' }>;
  prominent?: boolean;
}) {
  const { t } = useI18n();
  const resolving = useSecretaryStore((state) => state.resolving[proposal.id] === true);
  const resolveProposal = useSecretaryStore((state) => state.resolveProposal);
  const projects = useSettingsStore((state) => state.projects);
  const project = projects.find((entry) => entry.id === proposal.draft.projectId);
  const failed = proposal.status === 'failed';

  return (
    <div data-enso="secretary-proposal" data-kind="takeover" className={cardClass(prominent)}>
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('Take over')}
        </span>
        {project && (
          <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
            {projectDisplayName(project)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{proposal.draft.title ?? t('Unnamed')}</span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {t('The secretary asks to manage this session: it may message and stop it like its own.')}
        {proposal.draft.reason ? ` ${proposal.draft.reason}` : ''}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={cn('text-[11px]', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {t(TAKEOVER_STATUS_LABELS[proposal.status])}
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
              {t('Allow takeover')}
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

/** 工具草案卡片：参数结构与代码都可折叠，同名时把旧代码一起摊开 */
function ToolProposalCard({
  proposal,
  prominent,
}: {
  proposal: Extract<SecretaryProposal, { kind: 'tool' }>;
  prominent?: boolean;
}) {
  const { t } = useI18n();
  const resolving = useSecretaryStore((state) => state.resolving[proposal.id] === true);
  const resolveProposal = useSecretaryStore((state) => state.resolveProposal);
  const draft = proposal.draft;
  const failed = proposal.status === 'failed';

  return (
    <div data-enso="secretary-proposal" data-kind="tool" className={cardClass(prominent)}>
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('Tool')}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{draft.name}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
          {draft.runtime === 'python' ? 'Python' : 'Node'}
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
          {draft.readOnly ? t('Read-only') : t('Asks every call')}
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
          {proposal.previous ? t('Update') : t('New')}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{draft.description}</p>
      <details className="mt-1.5 rounded border border-border/60 bg-background/40 px-2 py-1">
        <summary className="cursor-pointer text-[11px] text-muted-foreground">
          {t('Show the arguments')}
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-[11px]">
          {JSON.stringify(draft.parameters, null, 2)}
        </pre>
      </details>
      <details className="mt-1 rounded border border-border/60 bg-background/40 px-2 py-1">
        <summary className="cursor-pointer text-[11px] text-muted-foreground">
          {t('Show the code')}
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre font-mono text-[11px]">
          {draft.code}
        </pre>
      </details>
      {proposal.previous ? (
        <details className="mt-1 rounded border border-border/60 bg-background/40 px-2 py-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {t('Show the current version')}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre font-mono text-[11px]">
            {proposal.previous.code}
          </pre>
        </details>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={cn('text-[11px]', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {t(TOOL_STATUS_LABELS[proposal.status])}
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
          </span>
        )}
      </div>
    </div>
  );
}

/** skill 草案卡片：正文可折叠，同名时把旧内容一起摊开，用户才知道自己在改什么 */
function SkillProposalCard({
  proposal,
  prominent,
}: {
  proposal: Extract<SecretaryProposal, { kind: 'skill' }>;
  prominent?: boolean;
}) {
  const { t } = useI18n();
  const resolving = useSecretaryStore((state) => state.resolving[proposal.id] === true);
  const resolveProposal = useSecretaryStore((state) => state.resolveProposal);
  const draft = proposal.draft;
  const failed = proposal.status === 'failed';

  return (
    <div data-enso="secretary-proposal" data-kind="skill" className={cardClass(prominent)}>
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('Skill')}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{draft.name}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
          {proposal.previous ? t('Update') : t('New')}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{draft.description}</p>
      <details className="mt-1.5 rounded border border-border/60 bg-background/40 px-2 py-1">
        <summary className="cursor-pointer text-[11px] text-muted-foreground">
          {t('Show the content')}
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-[11px]">
          {draft.body}
        </pre>
      </details>
      {proposal.previous ? (
        <details className="mt-1 rounded border border-border/60 bg-background/40 px-2 py-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {t('Show the current version')}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-[11px]">
            {proposal.previous.body}
          </pre>
        </details>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={cn('text-[11px]', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {t(SKILL_STATUS_LABELS[proposal.status])}
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
          </span>
        )}
      </div>
    </div>
  );
}

const CLEANUP_STATUS_LABELS: Record<ProposalStatus, string> = {
  ...STATUS_LABELS,
  executing: 'Cleaning up…',
  succeeded: 'Cleanup done',
};

const CLEANUP_KIND_LABELS: Record<CleanupItem['kind'], string> = {
  branch: 'Branch',
  worktree: 'Worktree',
  session: 'Session',
};

const CLEANUP_BLOCKED_LABELS: Record<string, string> = {
  'not-merged': 'Not merged yet',
  'current-branch': 'Currently checked out',
  'used-by-worktree': 'Used by a worktree',
  'detached-head': 'Detached HEAD',
  'uncommitted-changes': 'Has uncommitted changes',
};

function cleanupSize(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 确认卡最多列这么多条：几十行会把卡片撑得没法看，数量摘要才是重点 */
const CLEANUP_CARD_ITEMS = 5;

/**
 * 清理确认卡：数量摘要 + 前几条，用户点确认才执行。
 * 每行带已合入与占用空间，别让人凭记忆点按钮；剩下的条数用一行说明。
 */
function CleanupProposalCard({
  proposal,
  prominent,
}: {
  proposal: Extract<SecretaryProposal, { kind: 'cleanup' }>;
  prominent?: boolean;
}) {
  const { t } = useI18n();
  const resolving = useSecretaryStore((state) => state.resolving[proposal.id] === true);
  const resolveProposal = useSecretaryStore((state) => state.resolveProposal);
  const items = proposal.draft.items;
  const shown = items.slice(0, CLEANUP_CARD_ITEMS);
  const rest = items.length - shown.length;
  const failed = proposal.status === 'failed';
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div data-enso="secretary-proposal" data-kind="cleanup" className={cardClass(prominent)}>
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('Clean up')}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {t('{{count}} items', { count: items.length })}
        </span>
        {(['branch', 'worktree', 'session'] as const).map((kind) =>
          counts[kind] ? (
            <span
              key={kind}
              className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground"
            >
              {counts[kind]} {t(CLEANUP_KIND_LABELS[kind])}
            </span>
          ) : null
        )}
      </div>
      <ul data-enso="secretary-cleanup-items" className="mt-1.5 space-y-0.5">
        {shown.map((item) => {
          const size = cleanupSize(item.sizeBytes);
          const detail = [
            item.mergedInto?.length
              ? t('merged into {{refs}}', { refs: item.mergedInto.join(', ') })
              : null,
            size,
            item.blocked ? t(CLEANUP_BLOCKED_LABELS[item.blocked] ?? item.blocked) : null,
          ].filter(Boolean);
          return (
            <li key={item.id} className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
              <span
                data-enso="secretary-cleanup-kind"
                className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
              >
                {t(CLEANUP_KIND_LABELS[item.kind])}
              </span>
              <span className="min-w-0 truncate font-mono">{item.name}</span>
              {detail.length > 0 && (
                <span className="min-w-0 truncate text-muted-foreground">{detail.join(' · ')}</span>
              )}
            </li>
          );
        })}
        {rest > 0 && (
          <li data-enso="secretary-cleanup-rest" className="text-[11px] text-muted-foreground">
            {t('and {{count}} more', { count: rest })}
          </li>
        )}
      </ul>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={cn('text-[11px]', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {t(CLEANUP_STATUS_LABELS[proposal.status])}
          {failed && proposal.error ? ` · ${proposal.error}` : ''}
          {proposal.report ? ` · ${proposal.report}` : ''}
        </span>
        {proposal.status === 'pending' && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              data-enso="secretary-cleanup-confirm"
              disabled={resolving}
              onClick={() => void resolveProposal(proposal.id, 'confirm')}
              className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {t('Confirm cleanup')}
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

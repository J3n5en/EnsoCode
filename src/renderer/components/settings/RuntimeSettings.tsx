import { AUTO_RETRY_LIMIT_OPTIONS, UNLIMITED_AUTO_RETRY } from '@shared/autoRetry';
import { GENERATION_STALL_TIMEOUT_MINUTES } from '@shared/stallTimeout';
import { isAbsolutePathLike } from '@shared/worktreeRoot';
import * as React from 'react';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { ACTIVE_RETENTION_MINUTES } from '@/stores/settings/activeRetention';
import {
  AUTO_ARCHIVE_IDLE_DAYS,
  AUTO_DELETE_ARCHIVED_DAYS,
} from '@/stores/settings/autoArchiveIdleDays';
import { CompactReserveTokensSection } from './CompactReserveTokensSection';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  useSettingsRowControl,
} from './kit';
import { SmartCompactPicker } from './SmartCompactPicker';

function RowTextInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  const a11y = useSettingsRowControl();
  return <Input size="sm" {...a11y} {...props} className={cn('w-[220px] max-w-full', className)} />;
}

function SelectRow({
  rowId,
  label,
  description,
  value,
  onValueChange,
  options,
}: {
  rowId: string;
  label: React.ReactNode;
  description: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <SettingsRow rowId={rowId} label={label} description={description}>
      <SettingsSelect value={value} onValueChange={onValueChange} options={options} />
    </SettingsRow>
  );
}

function dayLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  value: number
): string {
  if (value === 0) return t('Never');
  if (value === 1) return t('{{count}} day', { count: value });
  return t('{{count}} days', { count: value });
}

export function RuntimeSettings() {
  const { t } = useI18n();
  return (
    <SettingsPage rowId="runtime.root" title={t('Runtime & sessions')}>
      <SettingsSection rowId="runtime.agent-runtime" title={t('Agent runtime')}>
        <GenerationStallTimeoutRow />
        <AutoRetryLimitRow />
        <LongCacheRetentionRow />
        <SmartCompactPicker />
        <CompactReserveTokensSection />
      </SettingsSection>
      <SettingsSection rowId="runtime.sessions-worktrees" title={t('Sessions & worktrees')}>
        <AutoArchiveSection />
        <ActiveRetentionMinutesRow />
        <WorktreeRootSection />
      </SettingsSection>
    </SettingsPage>
  );
}

function GenerationStallTimeoutRow() {
  const { t } = useI18n();
  const generationStallTimeoutMin = useSettingsStore((s) => s.generationStallTimeoutMin);
  const setGenerationStallTimeoutMin = useSettingsStore((s) => s.setGenerationStallTimeoutMin);
  return (
    <SelectRow
      rowId="general.generationStallTimeout"
      label={t('Stop if no output')}
      description={t(
        'Abort and retry the run when no tokens or tool results arrive for this long. Thinking counts as output.'
      )}
      value={String(generationStallTimeoutMin)}
      onValueChange={(value) => setGenerationStallTimeoutMin(Number(value))}
      options={GENERATION_STALL_TIMEOUT_MINUTES.map((value) => ({
        value: String(value),
        label: value === 0 ? t('Never') : t('{{count}} min', { count: value }),
      }))}
    />
  );
}

function AutoRetryLimitRow() {
  const { t } = useI18n();
  const autoRetryLimit = useSettingsStore((s) => s.autoRetryLimit);
  const setAutoRetryLimit = useSettingsStore((s) => s.setAutoRetryLimit);
  const autoRetryOptions = AUTO_RETRY_LIMIT_OPTIONS.some((value) => value === autoRetryLimit)
    ? [...AUTO_RETRY_LIMIT_OPTIONS]
    : [...AUTO_RETRY_LIMIT_OPTIONS, autoRetryLimit].sort((a, b) =>
        a === UNLIMITED_AUTO_RETRY ? 1 : b === UNLIMITED_AUTO_RETRY ? -1 : a - b
      );
  const autoRetryLabel = (value: number) =>
    value === 0
      ? t('Off')
      : value === UNLIMITED_AUTO_RETRY
        ? t('Unlimited')
        : t('{{count}} times', { count: value });
  return (
    <SelectRow
      rowId="general.autoRetryLimit"
      label={t('Auto-retry on transient errors')}
      description={t(
        'Retry with backoff (up to 60s apart) after 429, 5xx or network errors. Quota and billing errors are never retried. Unlimited keeps retrying until you cancel.'
      )}
      value={String(autoRetryLimit)}
      onValueChange={(value) => setAutoRetryLimit(Number(value))}
      options={autoRetryOptions.map((value) => ({
        value: String(value),
        label: autoRetryLabel(value),
      }))}
    />
  );
}

function LongCacheRetentionRow() {
  const { t } = useI18n();
  const longCacheRetention = useSettingsStore((s) => s.longCacheRetention);
  const setLongCacheRetention = useSettingsStore((s) => s.setLongCacheRetention);
  return (
    <SettingsRow
      rowId="general.longCacheRetention"
      label={t('Long prompt cache (1 hour)')}
      description={t(
        'Keep the prompt cache for 1 hour instead of 5 minutes. Saves a lot when turns are more than 5 minutes apart, since the cache no longer expires and gets rewritten every turn, but cache writes cost 2× instead of 1.25×, so rapid follow-ups tens of seconds apart cost more. Anthropic models only. Applies from the next request.'
      )}
    >
      <SettingsSwitch checked={longCacheRetention} onCheckedChange={setLongCacheRetention} />
    </SettingsRow>
  );
}

function ActiveRetentionMinutesRow() {
  const { t } = useI18n();
  const activeRetentionMinutes = useSettingsStore((s) => s.activeRetentionMinutes);
  const setActiveRetentionMinutes = useSettingsStore((s) => s.setActiveRetentionMinutes);
  const retentionLabel = (value: number) =>
    value === 0 ? t('Off') : t('{{count}} min', { count: value });
  return (
    <SelectRow
      rowId="general.activeRetentionMinutes"
      label={t('Keep in Active after last message')}
      description={t(
        'Viewed conversations stay in Active for this long after their last message or your last open while still in Active, then leave. Unviewed ones stay until you open them.'
      )}
      value={String(activeRetentionMinutes)}
      onValueChange={(value) => setActiveRetentionMinutes(Number(value))}
      options={ACTIVE_RETENTION_MINUTES.map((value) => ({
        value: String(value),
        label: retentionLabel(value),
      }))}
    />
  );
}

function AutoArchiveSection() {
  const { t } = useI18n();
  const autoArchiveIdleDays = useSettingsStore((s) => s.autoArchiveIdleDays);
  const setAutoArchiveIdleDays = useSettingsStore((s) => s.setAutoArchiveIdleDays);
  const autoArchiveMergedWorktrees = useSettingsStore((s) => s.autoArchiveMergedWorktrees);
  const setAutoArchiveMergedWorktrees = useSettingsStore((s) => s.setAutoArchiveMergedWorktrees);
  const autoDeleteArchivedDays = useSettingsStore((s) => s.autoDeleteArchivedDays);
  const setAutoDeleteArchivedDays = useSettingsStore((s) => s.setAutoDeleteArchivedDays);
  return (
    <>
      <SelectRow
        rowId="general.autoArchiveIdleDays"
        label={t('Archive idle conversations')}
        description={t(
          'Move conversations that have been idle this long into Archived. Does not delete them.'
        )}
        value={String(autoArchiveIdleDays)}
        onValueChange={(value) => setAutoArchiveIdleDays(Number(value))}
        options={AUTO_ARCHIVE_IDLE_DAYS.map((value) => ({
          value: String(value),
          label: dayLabel(t, value),
        }))}
      />
      <SettingsRow
        rowId="general.autoArchiveMergedWorktrees"
        label={t('Clean up merged worktrees')}
        description={t(
          'When archiving idle conversations, also remove isolated worktrees that are merged and clean.'
        )}
      >
        <SettingsSwitch
          checked={autoArchiveMergedWorktrees}
          onCheckedChange={setAutoArchiveMergedWorktrees}
        />
      </SettingsRow>
      <SelectRow
        rowId="general.autoDeleteArchivedDays"
        label={t('Delete archived conversations after')}
        description={t(
          'Permanently delete conversations that have been archived longer than this. This cannot be undone. Choosing a positive value deletes already-overdue archived conversations immediately.'
        )}
        value={String(autoDeleteArchivedDays)}
        onValueChange={(value) => setAutoDeleteArchivedDays(Number(value))}
        options={AUTO_DELETE_ARCHIVED_DAYS.map((value) => ({
          value: String(value),
          label: dayLabel(t, value),
        }))}
      />
    </>
  );
}

function WorktreeRootSection() {
  const { t } = useI18n();
  const worktreeRoot = useSettingsStore((s) => s.worktreeRoot);
  const setWorktreeRoot = useSettingsStore((s) => s.setWorktreeRoot);
  const [draft, setDraft] = React.useState(worktreeRoot);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDraft(worktreeRoot);
  }, [worktreeRoot]);

  const commit = (value: string) => {
    const next = value.trim();
    if (next && !isAbsolutePathLike(next)) {
      setError(t('Enter an absolute path'));
      return;
    }
    setError(null);
    setWorktreeRoot(next);
  };

  const browse = async () => {
    const dir = await window.electronAPI.dialog.selectDirectory();
    if (dir) {
      setDraft(dir);
      commit(dir);
    }
  };

  return (
    <SettingsRow
      rowId="general.worktreeRoot"
      label={t('Worktree root directory')}
      description={t(
        'Where isolated session worktrees are created. Leave empty to use the app data directory. Existing worktrees stay where they are.'
      )}
    >
      <div className="flex w-full max-w-[280px] flex-wrap items-center justify-end gap-2">
        <RowTextInput
          className="w-[220px]"
          value={draft}
          placeholder={t('Default location')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(draft);
          }}
        />
        <SettingsButton onClick={() => void browse()}>{t('Browse')}</SettingsButton>
      </div>
      {error && <p className="w-full text-right text-[12px] text-destructive">{error}</p>}
    </SettingsRow>
  );
}

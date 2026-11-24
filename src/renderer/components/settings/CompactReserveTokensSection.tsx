import {
  COMPACT_RESERVE_TOKENS_DEFAULT,
  COMPACT_RESERVE_TOKENS_MAX,
  COMPACT_RESERVE_TOKENS_MIN,
  parseCompactReserveTokensDraft,
} from '@shared/compactionSettings';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { SettingsRow, useSettingsRowControl } from './kit';
import { NewSessionBadge } from './NewSessionBadge';

function ReserveInput({
  draft,
  label,
  onCommit,
  onDraft,
}: {
  draft: string;
  label: string;
  onCommit: () => void;
  onDraft: (value: string) => void;
}) {
  const a11y = useSettingsRowControl();
  return (
    <Input
      {...a11y}
      size="sm"
      inputMode="numeric"
      value={draft}
      placeholder={String(COMPACT_RESERVE_TOKENS_DEFAULT)}
      aria-label={label}
      className={cn('w-[140px] max-w-full')}
      onChange={(event) => onDraft(event.target.value)}
      onBlur={() => void onCommit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void onCommit();
      }}
    />
  );
}

/** pi 全局 settings.json 的 compaction.reserveTokens；留空即删除该字段，跟随 pi 默认 */
export function CompactReserveTokensSection() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.compaction.getReserveTokens().then((value) => {
      if (cancelled) return;
      setSaved(value);
      setDraft(value === null ? '' : String(value));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = async () => {
    const value = parseCompactReserveTokensDraft(draft);
    if (value === undefined) {
      setError(
        t('Enter a whole number between {{min}} and {{max}}, or leave it empty.', {
          min: COMPACT_RESERVE_TOKENS_MIN,
          max: COMPACT_RESERVE_TOKENS_MAX,
        })
      );
      return;
    }
    setError(null);
    if (value === saved) return;
    const result = await window.electronAPI.compaction.setReserveTokens(value);
    if (!result.ok) {
      setError(t('Could not save. Check that pi-agent/settings.json is valid JSON.'));
      return;
    }
    setSaved(value);
    setDraft(value === null ? '' : String(value));
  };

  return (
    <SettingsRow
      rowId="general.compactReserveTokens"
      label={
        <>
          {t('Compaction reserve tokens')}
          <NewSessionBadge />
        </>
      }
      description={t(
        'Compaction runs when context exceeds the model window minus this value. Larger values compact earlier. Do not set it close to the window of small-context models, or every request compacts first. Leave empty for the default.'
      )}
    >
      <div className="flex w-[140px] max-w-full flex-col items-end gap-1">
        <ReserveInput
          draft={draft}
          label={t('Compaction reserve tokens')}
          onDraft={setDraft}
          onCommit={() => void commit()}
        />
        {error && <p className="text-right text-[12px] text-destructive">{error}</p>}
      </div>
    </SettingsRow>
  );
}

import {
  COMPACT_RESERVE_TOKENS_DEFAULT,
  COMPACT_RESERVE_TOKENS_MAX,
  COMPACT_RESERVE_TOKENS_MIN,
  parseCompactReserveTokensDraft,
} from '@shared/compactionSettings';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { NewSessionBadge } from './NewSessionBadge';

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
    <div
      className="flex items-start justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row="general.compactReserveTokens"
    >
      <div className="min-w-0">
        <p className="text-sm">
          {t('Compaction reserve tokens')}
          <NewSessionBadge />
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            'Compaction runs when context exceeds the model window minus this value. Larger values compact earlier. Do not set it close to the window of small-context models, or every request compacts first. Leave empty for the default.'
          )}
        </p>
      </div>
      <div className="w-32 shrink-0 space-y-1">
        <Input
          inputMode="numeric"
          value={draft}
          placeholder={String(COMPACT_RESERVE_TOKENS_DEFAULT)}
          aria-label={t('Compaction reserve tokens')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commit();
          }}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

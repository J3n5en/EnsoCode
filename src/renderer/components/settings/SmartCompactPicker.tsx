import {
  COMPACT_STRATEGIES,
  type CompactStrategy,
  resolveCompactStrategy,
} from '@shared/compactStrategy';
import { SMART_COMPACT_MODES, type SmartCompactMode } from '@shared/smartCompactMode';
import { useMemo } from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/i18n';
import {
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';

const MODE_LABEL: Record<SmartCompactMode, string> = {
  auto: 'Auto (by usage)',
  fast: 'Fast',
  balanced: 'Balanced',
  thorough: 'Thorough',
};

/** 验证式智能压缩：开关 + 档位 + 独立摘要模型（null = 跟随当前会话模型）。 */
export function SmartCompactPicker() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const storedStrategy = useSettingsStore((state) => state.compactStrategy);
  const legacyEnabled = useSettingsStore((state) => state.smartCompactEnabled);
  const strategy = resolveCompactStrategy(storedStrategy, legacyEnabled);
  const setStrategy = useSettingsStore((state) => state.setCompactStrategy);
  const enabled = strategy !== 'standard';
  const model = useSettingsStore((state) => state.smartCompactModel);
  const setModel = useSettingsStore((state) => state.setSmartCompactModel);
  const mode = useSettingsStore((state) => state.smartCompactMode);
  const setMode = useSettingsStore((state) => state.setSmartCompactMode);
  const snapshot = useOauthCredentialStore((state) => state.snapshot);
  const candidates = useMemo(
    () => usableProvidersForOauthSnapshot(providers, snapshot),
    [providers, snapshot]
  );
  const selectedProvider = model
    ? candidates.find((entry) => entry.id === model.providerId)
    : undefined;
  const selectedModel = selectedProvider?.models.find((entry) => entry.id === model?.modelId);

  return (
    <section
      className="space-y-2 rounded-lg border bg-card p-3"
      data-settings-row="general.smartCompactEnabled"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="font-medium text-sm">{t('Context compaction strategy')}</h4>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {t(
              'Standard uses default compact. Smart compaction uses Enso verified summary at compact time. Continuous memory records observations in the background so compact keeps more context; both fall back to default compact on failure and take effect on the next session.'
            )}
          </p>
        </div>
        <Select
          items={{
            standard: t('Standard'),
            smart: t('Smart compaction'),
            'continuous-memory': t('Continuous memory (experimental)'),
          }}
          value={strategy}
          onValueChange={(value) => setStrategy(value as CompactStrategy)}
        >
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {COMPACT_STRATEGIES.map((value) => (
              <SelectItem key={value} value={value}>
                {value === 'standard'
                  ? t('Standard')
                  : value === 'smart'
                    ? t('Smart compaction')
                    : t('Continuous memory (experimental)')}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {strategy === 'smart' && (
        <div className="flex items-center justify-between gap-4" data-smart-compact-mode={mode}>
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">{t('Compaction mode')}</p>
            <p className="mt-0.5 text-muted-foreground/80 text-[11px]">
              {t(
                'Mode changes summary budget and how much recent tail to keep. It does not decide whether compact runs.'
              )}
            </p>
          </div>
          <Select
            items={Object.fromEntries(
              SMART_COMPACT_MODES.map((value) => [value, t(MODE_LABEL[value])])
            )}
            value={mode}
            onValueChange={(value) => setMode(value as SmartCompactMode)}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {SMART_COMPACT_MODES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(MODE_LABEL[value])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}

      {enabled && (
        <div className="space-y-2">
          <p className="font-medium text-sm">
            {t(strategy === 'continuous-memory' ? 'Background memory model' : 'Summary model')}
          </p>
          {candidates.length > 0 && (
            <div className="w-full min-w-0">
              <ModelPicker
                providers={candidates}
                providerId={selectedProvider?.id ?? ''}
                modelId={selectedModel?.id ?? ''}
                reasoningEnabled={false}
                thinkingLevel="medium"
                showReasoningControls={false}
                emptyLabel={t('Follows the session model')}
                side="bottom"
                triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
                onSelect={(providerId, modelId) => setModel({ providerId, modelId })}
                onReasoningChange={() => {}}
                onThinkingChange={() => {}}
              />
            </div>
          )}
          {model && (!selectedProvider || !selectedModel) && (
            <p className="text-muted-foreground text-xs">
              {t('Selected model is unavailable — falls back to the session model.')}
            </p>
          )}
          {model && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setModel(null)}>
              {t('Follow session model')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

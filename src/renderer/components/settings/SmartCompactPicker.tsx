import type { DefaultModelRef } from '@shared/defaultModel';
import type { ModelProvider } from '@shared/types';
import { useMemo } from 'react';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import {
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';

function selectionLabel(selection: DefaultModelRef, providers: readonly ModelProvider[]): string {
  const provider = providers.find((entry) => entry.id === selection.providerId);
  const model = provider?.models.find((entry) => entry.id === selection.modelId);
  return `${provider?.name ?? selection.providerId} / ${model?.label ?? selection.modelId}`;
}

/** 验证式智能压缩：开关 + 独立摘要模型（null = 跟随当前会话模型）。 */
export function SmartCompactPicker() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const enabled = useSettingsStore((state) => state.smartCompactEnabled);
  const setEnabled = useSettingsStore((state) => state.setSmartCompactEnabled);
  const model = useSettingsStore((state) => state.smartCompactModel);
  const setModel = useSettingsStore((state) => state.setSmartCompactModel);
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
          <h4 className="font-medium text-sm">{t('Verified smart compaction')}</h4>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {t(
              'Use a verified summary for long-session compact. Falls back to default compact on failure. May be slower and use more tokens. Takes effect on the next session.'
            )}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {enabled && (
        <div className="flex items-center justify-between gap-4">
          <p
            className="min-w-0 truncate text-muted-foreground text-xs"
            title={model ? selectionLabel(model, providers) : undefined}
          >
            {model && selectedProvider && selectedModel
              ? selectionLabel(model, providers)
              : model
                ? t('Selected model is unavailable — falls back to the session model.')
                : t('Follows the session model')}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {model && (
              <Button variant="ghost" size="sm" onClick={() => setModel(null)}>
                {t('Follow session model')}
              </Button>
            )}
            {candidates.length > 0 && (
              <ModelPicker
                providers={candidates}
                providerId={selectedProvider?.id ?? ''}
                modelId={selectedModel?.id ?? ''}
                reasoningEnabled={false}
                thinkingLevel="medium"
                showReasoningControls={false}
                onSelect={(providerId, modelId) => setModel({ providerId, modelId })}
                onReasoningChange={() => {}}
                onThinkingChange={() => {}}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

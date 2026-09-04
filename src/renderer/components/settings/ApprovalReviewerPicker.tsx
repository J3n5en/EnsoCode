import type { DefaultModelRef } from '@shared/defaultModel';
import type { ModelProvider } from '@shared/types';
import { useMemo } from 'react';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { Button } from '@/components/ui/button';
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

/** 助手代审模型：未选则该档不可用，不回退会话模型。 */
export function ApprovalReviewerPicker() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const model = useSettingsStore((state) => state.approvalReviewer);
  const setModel = useSettingsStore((state) => state.setApprovalReviewer);
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
    <section className="space-y-2 rounded-lg border bg-card p-3">
      <div className="min-w-0">
        <h4 className="font-medium text-sm">{t('Assistant approval model')}</h4>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {t(
            'Required before Assistant approval can be selected. Does not fall back to the chat model.'
          )}
        </p>
      </div>
      <div className="flex items-center justify-between gap-4">
        <p
          className="min-w-0 truncate text-muted-foreground text-xs"
          title={model ? selectionLabel(model, providers) : undefined}
        >
          {model && selectedProvider && selectedModel
            ? selectionLabel(model, providers)
            : model
              ? t('Selected model is unavailable')
              : t('No assistant approval model selected')}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {model && (
            <Button variant="ghost" size="sm" onClick={() => setModel(null)}>
              {t('Clear')}
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
    </section>
  );
}

import { isClassifierOnlyProvider } from '@shared/providerCatalog';
import { useMemo } from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import {
  useUsableClassifierProviders,
  useUsableProviders,
} from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';

/** 助手代审模型：未选则该档不可用，不回退会话模型。分类器专用供应商（如 Jev）也可选，走分类器代审。 */
export function ApprovalReviewerPicker() {
  const { t } = useI18n();
  const model = useSettingsStore((state) => state.approvalReviewer);
  const setModel = useSettingsStore((state) => state.setApprovalReviewer);
  const chatProviders = useUsableProviders();
  const classifierProviders = useUsableClassifierProviders();
  const candidates = useMemo(
    () => [...chatProviders, ...classifierProviders.filter(isClassifierOnlyProvider)],
    [chatProviders, classifierProviders]
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
      {candidates.length > 0 && (
        <div className="w-full min-w-0">
          <ModelPicker
            providers={candidates}
            providerId={selectedProvider?.id ?? ''}
            modelId={selectedModel?.id ?? ''}
            reasoningEnabled={false}
            thinkingLevel="medium"
            showReasoningControls={false}
            emptyLabel={t('No assistant approval model selected')}
            side="bottom"
            triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
            onSelect={(providerId, modelId) => setModel({ providerId, modelId })}
            onReasoningChange={() => {}}
            onThinkingChange={() => {}}
          />
        </div>
      )}
      {selectedProvider && isClassifierOnlyProvider(selectedProvider) && (
        <p className="text-muted-foreground text-xs">
          {t(
            'Decision models only allow or block when highly confident. Everything else asks you.'
          )}
        </p>
      )}
      {model && (!selectedProvider || !selectedModel) && (
        <p className="text-muted-foreground text-xs">{t('Selected model is unavailable')}</p>
      )}
      {model && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setModel(null)}>
          {t('Clear')}
        </Button>
      )}
    </section>
  );
}

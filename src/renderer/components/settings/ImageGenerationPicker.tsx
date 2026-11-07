import { imageGenerationCandidateProviders } from '@shared/imageGeneration';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { useMaterializedProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';

export function ImageGenerationPicker() {
  const { t } = useI18n();
  const providers = imageGenerationCandidateProviders(useMaterializedProviders());
  const selection = useSettingsStore((state) => state.imageGenerationModel);
  const selectedAvailable =
    selection === null ||
    providers.some(
      (provider) =>
        provider.id === selection.providerId &&
        provider.models.some((model) => model.id === selection.modelId)
    );
  const setSelection = useSettingsStore((state) => state.setImageGenerationModel);
  return (
    <section className="space-y-2 rounded-lg border bg-card p-3">
      <h4 className="font-medium text-sm">{t('Default image generation model')}</h4>
      {providers.length > 0 ? (
        <ModelPicker
          providers={providers}
          providerId={selection?.providerId ?? ''}
          modelId={selection?.modelId ?? ''}
          reasoningEnabled={false}
          thinkingLevel="medium"
          emptyLabel={t('Select model')}
          side="bottom"
          triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
          onSelect={(providerId, modelId) => setSelection({ providerId, modelId })}
          onReasoningChange={() => {}}
          onThinkingChange={() => {}}
          showReasoningControls={false}
        />
      ) : (
        <p className="text-muted-foreground text-xs">{t('No image generation models available')}</p>
      )}
      {!selectedAvailable && (
        <p className="text-destructive text-xs">
          {t('Selected image generation model is unavailable')}
        </p>
      )}
      {selection && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setSelection(null)}>
          {t('Clear selection')}
        </Button>
      )}
    </section>
  );
}

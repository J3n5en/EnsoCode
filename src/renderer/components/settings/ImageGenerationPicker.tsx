import { imageGenerationCandidateProviders } from '@shared/imageGeneration';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { useI18n } from '@/i18n';
import { useMaterializedProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { SettingsButton, SettingsRow } from './kit';

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
    <SettingsRow
      rowId="providers.default-image-generation-model"
      label={t('Default image generation model')}
      description={
        providers.length === 0 ? (
          t('No image generation models available')
        ) : !selectedAvailable ? (
          <span className="text-destructive-text">
            {t('Selected image generation model is unavailable')}
          </span>
        ) : undefined
      }
    >
      {selection && (
        <SettingsButton variant="ghost" onClick={() => setSelection(null)}>
          {t('Clear selection')}
        </SettingsButton>
      )}
      {providers.length > 0 && (
        <div className="w-[280px] max-w-full">
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
        </div>
      )}
    </SettingsRow>
  );
}

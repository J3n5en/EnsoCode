import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { useI18n } from '@/i18n';
import { useOneShotProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { SettingsButton, SettingsRow, SettingsSubRow, SettingsSwitch } from './kit';

/**
 * 会话标题总结设置：开关 + 独立模型（null = 跟随全局默认）。
 * 模型菜单复用聊天区 ModelPicker；标题总结不开推理，不展示 reasoning 控件。
 */
export function TitleSummaryPicker() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.titleSummaryEnabled);
  const setEnabled = useSettingsStore((state) => state.setTitleSummaryEnabled);
  const model = useSettingsStore((state) => state.titleSummaryModel);
  const setModel = useSettingsStore((state) => state.setTitleSummaryModel);
  const candidates = useOneShotProviders();
  const selectedProvider = model
    ? candidates.find((entry) => entry.id === model.providerId)
    : undefined;
  const selectedModel = selectedProvider?.models.find((entry) => entry.id === model?.modelId);

  return (
    <>
      <SettingsRow
        rowId="providers.conversation-title-summary"
        label={t('Conversation title summary')}
        description={t('Generate a short AI title from the first message of a new conversation.')}
      >
        <SettingsSwitch checked={enabled} onCheckedChange={setEnabled} />
      </SettingsRow>
      {enabled && (
        <SettingsSubRow
          rowId="providers.titleSummaryModel"
          label={t('Model')}
          description={
            model && (!selectedProvider || !selectedModel)
              ? t('Selected model is unavailable — falls back to the default model.')
              : undefined
          }
        >
          {model && (
            <SettingsButton variant="ghost" onClick={() => setModel(null)}>
              {t('Follow default model')}
            </SettingsButton>
          )}
          {candidates.length > 0 && (
            <div className="w-[280px] max-w-full">
              <ModelPicker
                providers={candidates}
                providerId={selectedProvider?.id ?? ''}
                modelId={selectedModel?.id ?? ''}
                reasoningEnabled={false}
                thinkingLevel="medium"
                showReasoningControls={false}
                emptyLabel={t('Follows the default model')}
                side="bottom"
                triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
                onSelect={(providerId, modelId) => setModel({ providerId, modelId })}
                onReasoningChange={() => {}}
                onThinkingChange={() => {}}
              />
            </div>
          )}
        </SettingsSubRow>
      )}
    </>
  );
}

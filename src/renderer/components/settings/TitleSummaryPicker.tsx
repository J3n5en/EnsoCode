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

/**
 * 会话标题总结设置：开关 + 独立模型（null = 跟随全局默认）。
 * 模型菜单复用聊天区 ModelPicker；标题总结不开推理，不展示 reasoning 控件。
 */
export function TitleSummaryPicker() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const enabled = useSettingsStore((state) => state.titleSummaryEnabled);
  const setEnabled = useSettingsStore((state) => state.setTitleSummaryEnabled);
  const model = useSettingsStore((state) => state.titleSummaryModel);
  const setModel = useSettingsStore((state) => state.setTitleSummaryModel);
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
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="font-medium text-sm">{t('Conversation title summary')}</h4>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {t('Generate a short AI title from the first message of a new conversation.')}
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
                ? t('Selected model is unavailable — falls back to the default model.')
                : t('Follows the default model')}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {model && (
              <Button variant="ghost" size="sm" onClick={() => setModel(null)}>
                {t('Follow default model')}
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

import type { DefaultModelRef } from '@shared/defaultModel';
import type { ModelProvider } from '@shared/types';
import { CircleAlert } from 'lucide-react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { useI18n } from '@/i18n';
import { useMaterializedProviders, useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useDefaultModelRevalidationStore, useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSwitch } from './kit';

function selectionLabel(selection: DefaultModelRef, providers: readonly ModelProvider[]): string {
  const provider = providers.find((entry) => entry.id === selection.providerId);
  const model = provider?.models.find((entry) => entry.id === selection.modelId);
  return `${provider?.name ?? selection.providerId} / ${model?.label ?? selection.modelId}`;
}

/** 设置页的全局默认模型入口；账号分组与模型菜单完全复用聊天区 ModelPicker。 */
export function DefaultModelPicker() {
  const { t } = useI18n();
  const providers = useMaterializedProviders();
  const virtualModels = useSettingsStore((state) => state.virtualModels);
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const setDefaultModel = useSettingsStore((state) => state.setDefaultModel);
  const defaultModelFollowLast = useSettingsStore((state) => state.defaultModelFollowLast);
  const setDefaultModelFollowLast = useSettingsStore((state) => state.setDefaultModelFollowLast);
  const defaultReasoningEnabled = useSettingsStore((state) => state.defaultReasoningEnabled);
  const defaultThinkingLevel = useSettingsStore((state) => state.defaultThinkingLevel);
  const setDefaultReasoningEnabled = useSettingsStore((state) => state.setDefaultReasoningEnabled);
  const setDefaultThinkingLevel = useSettingsStore((state) => state.setDefaultThinkingLevel);
  const snapshot = useOauthCredentialStore((state) => state.snapshot);
  const revalidation = useDefaultModelRevalidationStore((state) => state.latest);
  const candidates = useUsableProviders();
  const selectedProvider = defaultModel
    ? candidates.find((entry) => entry.id === defaultModel.providerId)
    : undefined;
  const selectedModel = selectedProvider?.models.find(
    (entry) => entry.id === defaultModel?.modelId
  );
  const hasOauthProviders = providers.some((provider) => Boolean(provider.oauthAccountKey));
  const credentialsPending =
    hasOauthProviders &&
    (snapshot.availability.status === 'unloaded' || snapshot.availability.status === 'loading');
  const credentialsError =
    hasOauthProviders && snapshot.availability.status === 'error'
      ? snapshot.availability.error
      : null;

  const notice = revalidation?.notice;
  const noticeText = notice
    ? t('Default model changed: {{previous}} → {{next}}', {
        previous: selectionLabel(notice.previous, providers),
        next: notice.next ? selectionLabel(notice.next, providers) : t('No default model'),
      })
    : null;

  const notes = [
    candidates.length === 0 &&
      `${t('No usable models')} · ${t('Enable a model and configure valid provider credentials first.')}`,
    credentialsError
      ? t('Subscription credentials could not be loaded: {{error}}', { error: credentialsError })
      : credentialsPending &&
        t('Subscription credentials are loading. API-key models remain available.'),
    noticeText,
  ].filter((note): note is string => Boolean(note));

  return (
    <>
      <SettingsRow
        rowId="providers.default-model"
        label={t('Default model')}
        description={
          <>
            {t('Used for new conversations.')}
            {notes.map((note) => (
              <span key={note} className="mt-1 flex items-start gap-1">
                <CircleAlert className="mt-0.5 size-3 shrink-0" />
                {note}
              </span>
            ))}
          </>
        }
      >
        {candidates.length > 0 && (
          <div className="w-[280px] max-w-full">
            <ModelPicker
              providers={candidates}
              virtualModels={virtualModels}
              providerId={selectedProvider?.id ?? defaultModel?.providerId ?? ''}
              modelId={selectedModel?.id ?? defaultModel?.modelId ?? ''}
              reasoningEnabled={defaultReasoningEnabled}
              thinkingLevel={defaultThinkingLevel}
              emptyLabel={t('Select model')}
              triggerLabel={defaultModelFollowLast ? t('Follow last selection') : undefined}
              side="bottom"
              triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
              onSelect={(providerId, modelId) => setDefaultModel({ providerId, modelId })}
              onReasoningChange={setDefaultReasoningEnabled}
              onThinkingChange={setDefaultThinkingLevel}
              showReasoningControls={!defaultModelFollowLast}
            />
          </div>
        )}
      </SettingsRow>
      {candidates.length > 0 && (
        <SettingsRow
          rowId="providers.follow-last-selection"
          label={t('Follow last selection')}
          description={t('New conversations use the last model you picked.')}
        >
          <SettingsSwitch
            checked={defaultModelFollowLast}
            onCheckedChange={setDefaultModelFollowLast}
          />
        </SettingsRow>
      )}
    </>
  );
}

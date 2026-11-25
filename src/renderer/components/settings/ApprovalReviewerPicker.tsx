import {
  APPROVAL_ALLOW_THRESHOLDS,
  parseApprovalAllowThreshold,
} from '@shared/approvalReviewRecord';
import { isClassifierOnlyProvider } from '@shared/providerCatalog';
import { useMemo } from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { useI18n } from '@/i18n';
import {
  useUsableClassifierProviders,
  useUsableProviders,
} from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { SettingsButton, SettingsRow, SettingsSelect, SettingsSubRow, SettingsSwitch } from './kit';

/** 助手代审模型：未选则该档不可用，不回退会话模型。分类器专用供应商（如 Jev）也可选，走分类器代审。 */
export function ApprovalReviewerPicker() {
  const { t } = useI18n();
  const model = useSettingsStore((state) => state.approvalReviewer);
  const setModel = useSettingsStore((state) => state.setApprovalReviewer);
  const autoManage = useSettingsStore((state) => state.approvalAutoManage);
  const setAutoManage = useSettingsStore((state) => state.setApprovalAutoManage);
  const allowThreshold = parseApprovalAllowThreshold(
    useSettingsStore((state) => state.approvalAllowThreshold)
  );
  const setAllowThreshold = useSettingsStore((state) => state.setApprovalAllowThreshold);
  const thresholdItems: Record<string, string> = {
    '0.85': t('0.85 (looser)'),
    '0.9': t('0.9 (default)'),
    '0.95': t('0.95 (stricter)'),
  };
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

  const classifierOnly = selectedProvider && isClassifierOnlyProvider(selectedProvider);

  return (
    <>
      <SettingsRow
        rowId="providers.assistant-approval-model"
        label={t('Assistant approval model')}
        description={
          <>
            {t(
              'Required before Assistant approval can be selected. Does not fall back to the chat model.'
            )}
            {model && (!selectedProvider || !selectedModel) && (
              <span className="mt-1 block">{t('Selected model is unavailable')}</span>
            )}
          </>
        }
      >
        {model && (
          <SettingsButton variant="ghost" onClick={() => setModel(null)}>
            {t('Clear')}
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
              emptyLabel={t('No assistant approval model selected')}
              side="bottom"
              triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
              onSelect={(providerId, modelId) => setModel({ providerId, modelId })}
              onReasoningChange={() => {}}
              onThinkingChange={() => {}}
            />
          </div>
        )}
      </SettingsRow>
      {classifierOnly && (
        <>
          <SettingsSubRow
            rowId="providers.auto-manage-approvals"
            label={t('Auto-manage approvals')}
            description={
              autoManage
                ? t(
                    'Auto-managed: runs only when the decision model is highly confident it is safe. Everything else is denied and the agent tries another way. Protected actions still ask you.'
                  )
                : t(
                    'Decision models only allow or block when highly confident. Everything else asks you.'
                  )
            }
          >
            <SettingsSwitch checked={autoManage} onCheckedChange={setAutoManage} />
          </SettingsSubRow>
          <SettingsSubRow
            rowId="providers.auto-allow-threshold"
            label={t('Auto-allow threshold')}
            description={t(
              'Only runs automatically when the allow probability reaches this value. Operations near the threshold may be allowed one time and not the next.'
            )}
          >
            <SettingsSelect
              value={String(allowThreshold)}
              onValueChange={(value) => setAllowThreshold(Number(value))}
              options={APPROVAL_ALLOW_THRESHOLDS.map((value) => ({
                value: String(value),
                label: thresholdItems[String(value)] ?? String(value),
              }))}
            />
          </SettingsSubRow>
        </>
      )}
    </>
  );
}

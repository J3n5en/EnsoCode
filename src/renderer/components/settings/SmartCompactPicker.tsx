import {
  COMPACT_STRATEGIES,
  type CompactStrategy,
  resolveCompactStrategy,
} from '@shared/compactStrategy';
import { SMART_COMPACT_MODES, type SmartCompactMode } from '@shared/smartCompactMode';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { useI18n } from '@/i18n';
import { useOneShotProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { SettingsButton, SettingsRow, SettingsSelect } from './kit';
import { NewSessionBadge } from './NewSessionBadge';

const MODE_LABEL: Record<SmartCompactMode, string> = {
  auto: 'Auto (by usage)',
  fast: 'Fast',
  balanced: 'Balanced',
  thorough: 'Thorough',
};

const STRATEGY_LABEL: Record<CompactStrategy, string> = {
  standard: 'Standard',
  smart: 'Smart compaction',
  'codex-native': 'Codex native compaction',
  'continuous-memory': 'Continuous memory (experimental)',
};

/** 验证式智能压缩：策略 + 档位 + 独立摘要模型（null = 跟随当前会话模型）。 */
export function SmartCompactPicker() {
  const { t } = useI18n();
  const storedStrategy = useSettingsStore((state) => state.compactStrategy);
  const legacyEnabled = useSettingsStore((state) => state.smartCompactEnabled);
  const strategy = resolveCompactStrategy(storedStrategy, legacyEnabled);
  const setStrategy = useSettingsStore((state) => state.setCompactStrategy);
  const enabled = strategy !== 'standard';
  const model = useSettingsStore((state) => state.smartCompactModel);
  const setModel = useSettingsStore((state) => state.setSmartCompactModel);
  const mode = useSettingsStore((state) => state.smartCompactMode);
  const setMode = useSettingsStore((state) => state.setSmartCompactMode);
  const candidates = useOneShotProviders();
  const selectedProvider = model
    ? candidates.find((entry) => entry.id === model.providerId)
    : undefined;
  const selectedModel = selectedProvider?.models.find((entry) => entry.id === model?.modelId);

  return (
    <div data-settings-row="general.smartCompactEnabled">
      <SettingsRow
        rowId="general.smartCompactEnabled"
        label={
          <>
            {t('Context compaction strategy')}
            <NewSessionBadge />
          </>
        }
        description={t(
          'Standard uses default compact. Smart compaction uses Enso verified summary at compact time. Codex native compaction additionally stores an official Codex checkpoint on Codex models and uses smart compaction otherwise. Continuous memory records observations in the background so compact keeps more context; all fall back to default compact on failure. Switching strategy takes effect on the next session. The summary model and compaction mode apply to open conversations on the next compaction.'
        )}
      >
        <SettingsSelect
          width="wide"
          value={strategy}
          onValueChange={setStrategy}
          options={COMPACT_STRATEGIES.map((value) => ({
            value,
            label: t(STRATEGY_LABEL[value]),
          }))}
        />
      </SettingsRow>

      {(strategy === 'smart' || strategy === 'codex-native') && (
        <div data-smart-compact-mode={mode}>
          <SettingsRow
            rowId="runtime.compaction-mode"
            label={t('Compaction mode')}
            description={t(
              'Mode changes summary budget and how much recent tail to keep. It does not decide whether compact runs.'
            )}
          >
            <SettingsSelect
              value={mode}
              onValueChange={setMode}
              options={SMART_COMPACT_MODES.map((value) => ({
                value,
                label: t(MODE_LABEL[value]),
              }))}
            />
          </SettingsRow>
        </div>
      )}

      {enabled && (
        <div className="px-4 py-3 max-sm:px-3">
          <p className="font-medium text-[13px]">
            {t(strategy === 'continuous-memory' ? 'Background memory model' : 'Summary model')}
          </p>
          {candidates.length > 0 && (
            <div className="mt-2 w-full min-w-0">
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
            <p className="mt-1 text-[12px] text-muted-foreground">
              {t('Selected model is unavailable — falls back to the session model.')}
            </p>
          )}
          {model && (
            <SettingsButton variant="ghost" className="mt-1" onClick={() => setModel(null)}>
              {t('Follow session model')}
            </SettingsButton>
          )}
        </div>
      )}
    </div>
  );
}

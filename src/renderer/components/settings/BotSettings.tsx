import { MAX_BOT_MAX_RUNNING_TURNS, MIN_BOT_MAX_RUNNING_TURNS } from '@shared/bots/concurrency';
import { smartRouteTimeoutMs } from '@shared/bots/smartRoute';
import { canBeVirtualMember } from '@shared/virtualModels';
import * as React from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/i18n';
import {
  useOneShotProviders,
  useUsableClassifierProviders,
  useUsableProviders,
} from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from './kit';
import { ClassifierSourceField } from './VirtualModelsSettings';

/** Bot 模式的全局设置；只在「实验」里开启 Bot 模式后出现在导航里 */
export function BotSettings() {
  const { t } = useI18n();
  return (
    <SettingsPage
      rowId="bots.root"
      title={t('Bot mode')}
      description={t('Settings shared by all members and group chats.')}
    >
      <SettingsSection>
        <BotAssistantModelRow />
        <BotRouteClassifierRow />
        <BotDiscussModeRow />
        <BotMaxRunningTurnsRow />
      </SettingsSection>
    </SettingsPage>
  );
}

/** 讨论模式总开关（实验性，默认关）；Bot 模式没开时不显示 */
function BotDiscussModeRow() {
  const { t } = useI18n();
  const botModeEnabled = useSettingsStore((s) => s.botModeEnabled);
  const enabled = useSettingsStore((s) => s.botDiscussModeEnabled);
  const setEnabled = useSettingsStore((s) => s.setBotDiscussModeEnabled);
  if (!botModeEnabled) return null;
  return (
    <SettingsRow
      rowId="bots.discussMode"
      label={
        <span className="inline-flex items-center gap-1.5">
          {t('Discussion mode')}
          <Badge variant="warning" size="sm" data-experimental-badge="">
            {t('Experimental feature')}
          </Badge>
        </span>
      }
      description={t(
        'Off: group chats work the same as the stable release. On: in smart-routing groups, discussion-style messages let the judge model pick who speaks next.'
      )}
    >
      <SettingsSwitch checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} />
    </SettingsRow>
  );
}

const BOT_MAX_RUNNING_TURNS_OPTIONS = Array.from(
  { length: MAX_BOT_MAX_RUNNING_TURNS - MIN_BOT_MAX_RUNNING_TURNS + 1 },
  (_, index) => MIN_BOT_MAX_RUNNING_TURNS + index
);

function BotMaxRunningTurnsRow() {
  const { t } = useI18n();
  const value = useSettingsStore((s) => s.botMaxRunningTurns);
  const setValue = useSettingsStore((s) => s.setBotMaxRunningTurns);
  return (
    <SettingsRow
      rowId="bots.maxRunningTurns"
      label={t('Bot concurrency limit')}
      description={t(
        'Shared by private chats, group chats, delegations and routines. Lowering it never interrupts running work; raising it may hit model rate limits.'
      )}
    >
      <SettingsSelect
        value={String(value)}
        onValueChange={(next) => setValue(Number(next))}
        options={BOT_MAX_RUNNING_TURNS_OPTIONS.map((option) => ({
          value: String(option),
          label: String(option),
        }))}
      />
    </SettingsRow>
  );
}

function BotAssistantModelRow() {
  const { t } = useI18n();
  const model = useSettingsStore((s) => s.botAssistantModel);
  const setModel = useSettingsStore((s) => s.setBotAssistantModel);
  const candidates = useOneShotProviders();
  const provider = model ? candidates.find((p) => p.id === model.providerId) : undefined;
  const selected = provider?.models.find((m) => m.id === model?.modelId);
  return (
    <SettingsRow
      rowId="bots.assistantModel"
      label={t('Bot assistant model')}
      description={t('Used for helper tasks such as auto-configuring member abilities.')}
    >
      <div className="flex w-full min-w-0 flex-col items-end gap-1 sm:w-[280px]">
        <ModelPicker
          providers={candidates}
          providerId={selected ? (provider?.id ?? '') : ''}
          modelId={selected?.id ?? ''}
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
        {model && !selected && (
          <p className="text-muted-foreground text-xs">
            {t('Selected model is unavailable — falls back to the default model.')}
          </p>
        )}
        {model && (
          <SettingsButton variant="ghost" onClick={() => setModel(null)}>
            {t('Follow default model')}
          </SettingsButton>
        )}
      </div>
    </SettingsRow>
  );
}

function BotRouteClassifierRow() {
  const { t } = useI18n();
  const value = useSettingsStore((s) => s.botRouteClassifier);
  const setValue = useSettingsStore((s) => s.setBotRouteClassifier);
  const discussModeEnabled = useSettingsStore((s) => s.botDiscussModeEnabled);
  const usable = useUsableProviders();
  const candidates = React.useMemo(() => usable.filter(canBeVirtualMember), [usable]);
  const classifierProviders = useUsableClassifierProviders();
  return (
    <SettingsRow
      rowId="bots.routeClassifier"
      label={t('Group reply picker model')}
      description={t(
        'When nobody is @-mentioned in a smart-routing group, this model picks which member replies.'
      )}
    >
      <div className="w-full min-w-0 sm:max-w-[280px]">
        <ClassifierSourceField
          value={value ?? undefined}
          onChange={(next) => setValue(next ?? null)}
          providers={candidates}
          classifierProviders={classifierProviders}
          offLabel={t('Default (title model)')}
          judgeLabel={t('Fast chat model')}
          description={
            discussModeEnabled
              ? t(
                  'First pick: the group owner replies on timeout, error or an unclear answer. During a discussion, picking the next speaker ends the discussion in these cases.'
                )
              : t('Falls back to the group owner on timeout, error or an unclear answer.')
          }
          effectiveTimeoutMs={value ? smartRouteTimeoutMs(value) : undefined}
          timeoutHint={
            discussModeEnabled
              ? t(
                  'First pick: handed to the group owner on timeout. Next speaker in a discussion: the discussion ends on timeout.'
                )
              : t('Handed to the group owner on timeout.')
          }
        />
      </div>
    </SettingsRow>
  );
}

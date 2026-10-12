import { MAX_BOT_MAX_RUNNING_TURNS, MIN_BOT_MAX_RUNNING_TURNS } from '@shared/bots/concurrency';
import { smartRouteTimeoutMs } from '@shared/bots/smartRoute';
import { canBeVirtualMember } from '@shared/virtualModels';
import * as React from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import {
  useUsableClassifierProviders,
  useUsableProviders,
} from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { ClassifierSourceField } from './VirtualModelsSettings';

/** Bot 模式的全局设置；只在「实验」里开启 Bot 模式后出现在导航里 */
export function BotSettings() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">{t('Bot mode')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('Settings shared by all members and group chats.')}
        </p>
      </div>
      <BotAssistantModelRow />
      <BotRouteClassifierRow />
      <BotDiscussModeRow />
      <BotMaxRunningTurnsRow />
    </div>
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
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row="bots.discussMode"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm">{t('Discussion mode')}</p>
          <Badge variant="warning" size="sm" data-experimental-badge="">
            {t('Experimental feature')}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'Off: group chats work the same as the stable release. On: in smart-routing groups, discussion-style messages let the judge model pick who speaks next.'
          )}
        </p>
      </div>
      <Switch checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} />
    </div>
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
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row="bots.maxRunningTurns"
    >
      <div className="min-w-0">
        <p className="text-sm">{t('Bot concurrency limit')}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            'Shared by private chats, group chats, delegations and routines. Lowering it never interrupts running work; raising it may hit model rate limits.'
          )}
        </p>
      </div>
      <Select
        items={Object.fromEntries(
          BOT_MAX_RUNNING_TURNS_OPTIONS.map((option) => [String(option), String(option)])
        )}
        value={String(value)}
        onValueChange={(next) => setValue(Number(next))}
      >
        <SelectTrigger className="w-20">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {BOT_MAX_RUNNING_TURNS_OPTIONS.map((option) => (
            <SelectItem key={option} value={String(option)}>
              {option}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function BotAssistantModelRow() {
  const { t } = useI18n();
  const model = useSettingsStore((s) => s.botAssistantModel);
  const setModel = useSettingsStore((s) => s.setBotAssistantModel);
  const candidates = useUsableProviders();
  const provider = model ? candidates.find((p) => p.id === model.providerId) : undefined;
  const selected = provider?.models.find((m) => m.id === model?.modelId);
  return (
    <div className="rounded-md border px-3 py-2.5" data-settings-row="bots.assistantModel">
      <p className="text-sm">{t('Bot assistant model')}</p>
      <p className="mb-2 text-xs text-muted-foreground">
        {t('Used for helper tasks such as auto-configuring member abilities.')}
      </p>
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
        <p className="mt-1 text-muted-foreground text-xs">
          {t('Selected model is unavailable — falls back to the default model.')}
        </p>
      )}
      {model && (
        <Button variant="ghost" size="sm" className="mt-1" onClick={() => setModel(null)}>
          {t('Follow default model')}
        </Button>
      )}
    </div>
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
    <div className="rounded-md border px-3 py-2.5" data-settings-row="bots.routeClassifier">
      <p className="text-sm">{t('Group reply picker model')}</p>
      <p className="mb-2 text-xs text-muted-foreground">
        {t(
          'When nobody is @-mentioned in a smart-routing group, this model picks which member replies.'
        )}
      </p>
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
  );
}

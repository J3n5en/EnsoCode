import { pickModelCapabilityOverrides } from '@shared/modelCatalog';
import type { ModelProvider, ModelThinkingLevelOverride } from '@shared/types';
import { MODEL_THINKING_LEVEL_OVERRIDES } from '@shared/types/llm';
import { isVirtualRef, selectableVirtualModels, VIRTUAL_PROVIDER_ID } from '@shared/virtualModels';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { SettingsButton, SettingsRow, SettingsSection, SettingsSwitch } from './kit';

const isModelEnabled = (provider: ModelProvider, modelId: string): boolean =>
  provider.models.some((model) => model.id === modelId && model.enabled !== false);

// 继承项只做能力适配显示，不落成独立覆盖；只有用户操作才写入。
const ignoreInheritedNormalization = () => undefined;

function isReasoningOverride(value: unknown): value is 'on' | 'off' {
  return value === 'on' || value === 'off';
}

function isThinkingLevelOverride(value: unknown): value is ModelThinkingLevelOverride {
  return (
    typeof value === 'string' &&
    (MODEL_THINKING_LEVEL_OVERRIDES as readonly string[]).includes(value)
  );
}

/**
 * 「允许子代理指定模型」：默认模型下方的集中配置区。
 * 打开开关后可添加「模型 + 选型描述」条目；描述随 spawn 下发,
 * 注入 subagent/coworker 工具的 model 参数说明,帮主 agent 按任务挑模型。
 */
export function SubagentModelsSettings() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.subagentModelsEnabled);
  const entries = useSettingsStore((state) => state.subagentModels);
  const setEnabled = useSettingsStore((state) => state.setSubagentModelsEnabled);
  const addEntry = useSettingsStore((state) => state.addSubagentModel);
  const updateEntry = useSettingsStore((state) => state.updateSubagentModel);
  const removeEntry = useSettingsStore((state) => state.removeSubagentModel);
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const virtualModels = useSettingsStore((state) => state.virtualModels);
  const candidates = useUsableProviders();

  // 新条目的初始选择：可选虚拟默认模型优先，否则全局默认或第一个可用真实模型
  const seedSelection = useMemo((): { providerId: string; modelId: string } | null => {
    if (defaultModel && isVirtualRef(defaultModel)) {
      const seed = selectableVirtualModels(virtualModels, candidates).find(
        (entry) => entry.id === defaultModel.modelId
      );
      if (seed) return { providerId: VIRTUAL_PROVIDER_ID, modelId: seed.id };
    }
    if (defaultModel) {
      const provider = candidates.find((entry) => entry.id === defaultModel.providerId);
      if (provider && isModelEnabled(provider, defaultModel.modelId)) return defaultModel;
    }
    for (const provider of candidates) {
      const model = provider.models.find((entry) => entry.enabled !== false);
      if (model) return { providerId: provider.id, modelId: model.id };
    }
    return null;
  }, [candidates, defaultModel, virtualModels]);

  return (
    <SettingsSection>
      <SettingsRow
        rowId="providers.let-the-agent-pick-subagent-models"
        label={t('Let the agent pick subagent models')}
        description={
          <>
            {t(
              'The main agent can pick one of these models when dispatching subagents or coworkers. The description tells it when to use each model.'
            )}
            <span className="mt-1 block">{t('Applies to newly started conversations.')}</span>
          </>
        }
      >
        <SettingsSwitch checked={enabled} onCheckedChange={setEnabled} />
      </SettingsRow>

      {enabled && (
        <>
          {entries.map((entry) => (
            <div
              key={entry.id}
              data-slot="subagent-model-row"
              className={cn(
                'flex flex-wrap items-center gap-2 px-4 py-2.5 pl-10 max-sm:pr-3 max-sm:pl-7',
                entry.enabled === false && 'text-muted-foreground'
              )}
            >
              <Switch
                data-slot="subagent-model-enabled"
                aria-label={t('Enable subagent model')}
                title={t('Make this model available to subagents')}
                checked={entry.enabled !== false}
                onCheckedChange={(enabled) => updateEntry(entry.id, { enabled })}
              />
              {entry.enabled === false && (
                <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
                  {t('Disabled')}
                </Badge>
              )}
              <div className="w-[220px] max-w-full shrink-0">
                <ModelPicker
                  providers={candidates}
                  virtualModels={virtualModels}
                  providerId={entry.providerId}
                  modelId={entry.modelId}
                  modelCapabilityOverrides={pickModelCapabilityOverrides(entry)}
                  side="bottom"
                  triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
                  reasoningMode={isReasoningOverride(entry.reasoning) ? entry.reasoning : 'follow'}
                  reasoningEnabled={entry.reasoning === 'on'}
                  thinkingLevel={
                    isThinkingLevelOverride(entry.thinkingLevel) ? entry.thinkingLevel : 'medium'
                  }
                  onReasoningModeChange={(mode, level) => {
                    if (mode === 'follow') {
                      updateEntry(entry.id, { reasoning: undefined, thinkingLevel: undefined });
                    } else if (mode === 'on' && !isThinkingLevelOverride(entry.thinkingLevel)) {
                      updateEntry(entry.id, { reasoning: 'on', thinkingLevel: level });
                    } else {
                      updateEntry(entry.id, { reasoning: mode });
                    }
                  }}
                  onSelect={(providerId, modelId) => updateEntry(entry.id, { providerId, modelId })}
                  onReasoningChange={(reasoningEnabled) =>
                    updateEntry(entry.id, { reasoning: reasoningEnabled ? 'on' : 'off' })
                  }
                  onThinkingChange={(thinkingLevel) => updateEntry(entry.id, { thinkingLevel })}
                  onReasoningNormalize={
                    isReasoningOverride(entry.reasoning)
                      ? (reasoningEnabled) =>
                          updateEntry(entry.id, {
                            reasoning: reasoningEnabled ? 'on' : 'off',
                          })
                      : ignoreInheritedNormalization
                  }
                  onThinkingNormalize={
                    isThinkingLevelOverride(entry.thinkingLevel)
                      ? (thinkingLevel) => updateEntry(entry.id, { thinkingLevel })
                      : ignoreInheritedNormalization
                  }
                />
              </div>
              <Input
                value={entry.description}
                placeholder={t('When to use it, e.g. cheap and fast for simple subtasks')}
                className="min-w-[min(100%,12rem)] flex-1"
                size="sm"
                onChange={(event) => updateEntry(entry.id, { description: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('Delete')}
                className={cn('shrink-0 text-muted-foreground hover:text-destructive')}
                onClick={() => removeEntry(entry.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 pl-10 max-sm:pr-3 max-sm:pl-7">
            <SettingsButton
              disabled={!seedSelection}
              onClick={() => {
                if (seedSelection) addEntry({ ...seedSelection, description: '' });
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('Add model')}
            </SettingsButton>
            {!seedSelection && (
              <span className="text-muted-foreground text-xs">
                {t('Enable a model and configure valid provider credentials first.')}
              </span>
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

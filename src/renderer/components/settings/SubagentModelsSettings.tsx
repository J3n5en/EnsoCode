import type { ModelProvider } from '@shared/types';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import {
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';

const isModelEnabled = (provider: ModelProvider, modelId: string): boolean =>
  provider.models.some((model) => model.id === modelId && model.enabled !== false);

/**
 * 「允许子代理指定模型」：默认模型下方的集中配置区。
 * 打开开关后可添加「模型 + 选型描述」条目；描述随 spawn 下发,
 * 注入 subagent/coworker 工具的 model 参数说明,帮主 agent 按任务挑模型。
 */
export function SubagentModelsSettings() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const enabled = useSettingsStore((state) => state.subagentModelsEnabled);
  const entries = useSettingsStore((state) => state.subagentModels);
  const setEnabled = useSettingsStore((state) => state.setSubagentModelsEnabled);
  const addEntry = useSettingsStore((state) => state.addSubagentModel);
  const updateEntry = useSettingsStore((state) => state.updateSubagentModel);
  const removeEntry = useSettingsStore((state) => state.removeSubagentModel);
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const snapshot = useOauthCredentialStore((state) => state.snapshot);
  const candidates = useMemo(
    () => usableProvidersForOauthSnapshot(providers, snapshot),
    [providers, snapshot]
  );

  // 新条目的初始选择：全局默认模型可用则用它,否则第一个可用模型
  const seedSelection = useMemo((): { providerId: string; modelId: string } | null => {
    if (defaultModel) {
      const provider = candidates.find((entry) => entry.id === defaultModel.providerId);
      if (provider && isModelEnabled(provider, defaultModel.modelId)) return defaultModel;
    }
    for (const provider of candidates) {
      const model = provider.models.find((entry) => entry.enabled !== false);
      if (model) return { providerId: provider.id, modelId: model.id };
    }
    return null;
  }, [candidates, defaultModel]);

  return (
    <section data-slot="subagent-models" className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="font-medium text-sm">{t('Let the agent pick subagent models')}</h4>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {t(
              'The main agent can pick one of these models when dispatching subagents or coworkers. The description tells it when to use each model.'
            )}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {enabled && (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <div
              key={entry.id}
              data-slot="subagent-model-row"
              className="flex items-center gap-2 rounded-md border px-2 py-1.5"
            >
              <div className="shrink-0 rounded-md border bg-background">
                <ModelPicker
                  providers={candidates}
                  providerId={entry.providerId}
                  modelId={entry.modelId}
                  reasoningEnabled={false}
                  thinkingLevel="medium"
                  showReasoningControls={false}
                  onSelect={(providerId, modelId) => updateEntry(entry.id, { providerId, modelId })}
                  onReasoningChange={() => undefined}
                  onThinkingChange={() => undefined}
                />
              </div>
              <Input
                value={entry.description}
                placeholder={t('When to use it, e.g. cheap and fast for simple subtasks')}
                className="h-7 flex-1 text-xs"
                onChange={(event) => updateEntry(entry.id, { description: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => removeEntry(entry.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!seedSelection}
            onClick={() => {
              if (seedSelection) addEntry({ ...seedSelection, description: '' });
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('Add model')}
          </Button>
          {!seedSelection && (
            <p className="text-muted-foreground text-xs">
              {t('Enable a model and configure valid provider credentials first.')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

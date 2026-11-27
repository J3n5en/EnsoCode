import type { SubagentModelEntry } from '@shared/types';
import { isVirtualRef, selectableVirtualModels, VIRTUAL_PROVIDER_ID } from '@shared/virtualModels';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { providerDisplayName } from './chatgptPool';
import {
  SettingsButton,
  SettingsEmptyState,
  SettingsExpandableRow,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from './kit';
import { LEVEL_LABEL_KEYS } from './ProviderModelRow';
import {
  COMPACT_TEXTAREA_CLASS,
  isReasoningOverride,
  isThinkingLevelOverride,
  SubagentEntryModelPicker,
  SubagentModelsWizard,
} from './SubagentModelsWizard';
import { SUBAGENT_ROLE_PRESETS } from './subagentModelPresets';

type Selection = { providerId: string; modelId: string };

const isModelEnabled = (
  provider: { models: { id: string; enabled?: boolean }[] },
  modelId: string
) => provider.models.some((model) => model.id === modelId && model.enabled !== false);

/**
 * 与 main pickSubagentModelRefs 的命名口径一致：启用且可用的条目按列表顺序、
 * 以运行时基名（物理 `{provider.name}/{modelId}`、虚拟为条目名）计数，
 * 第 n(≥2) 条运行时名带 `#n`。baseName 返回 null 表示不可用。返回 id → n（只含 n≥2）。
 */
export function subagentRuntimeSuffixes(
  entries: readonly SubagentModelEntry[],
  baseName: (entry: SubagentModelEntry) => string | null
): Map<string, number> {
  const counts = new Map<string, number>();
  const suffixes = new Map<string, number>();
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const key = baseName(entry);
    if (key === null) continue;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > 1) suffixes.set(entry.id, count);
  }
  return suffixes;
}

/** 展示行的推理摘要，口径同 ModelPicker 触发器；follow 时返回 null 由调用方弱化 */
function reasoningSummary(entry: SubagentModelEntry, t: TFunction): string | null {
  if (!isReasoningOverride(entry.reasoning)) return null;
  if (entry.reasoning === 'off') return t('Off');
  const level = isThinkingLevelOverride(entry.thinkingLevel) ? entry.thinkingLevel : 'medium';
  return `${t('On')} · ${t(LEVEL_LABEL_KEYS[level])}`;
}

/**
 * 「允许子代理指定模型」：默认模型下方的集中配置区。
 * 同一模型可配多条（不同角色描述/推理档位）；描述随 spawn 下发,
 * 注入 subagent/coworker 工具的 model 参数说明,帮主 agent 按任务挑模型。
 * 列表平时只读展示，点行或铅笔才展开该条的内联编辑。
 */
export function SubagentModelsSettings() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.subagentModelsEnabled);
  const entries = useSettingsStore((state) => state.subagentModels);
  const setEnabled = useSettingsStore((state) => state.setSubagentModelsEnabled);
  const addEntry = useSettingsStore((state) => state.addSubagentModel);
  const updateEntry = useSettingsStore((state) => state.updateSubagentModel);
  const removeEntry = useSettingsStore((state) => state.removeSubagentModel);
  const moveEntry = useSettingsStore((state) => state.moveSubagentModel);
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const virtualModels = useSettingsStore((state) => state.virtualModels);
  const candidates = useUsableProviders();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const selectableVirtual = useMemo(
    () => selectableVirtualModels(virtualModels, candidates),
    [candidates, virtualModels]
  );

  // 新条目的初始选择：可选虚拟默认模型优先，否则全局默认或第一个可用真实模型
  const seedSelection = useMemo((): Selection | null => {
    if (defaultModel && isVirtualRef(defaultModel)) {
      const seed = selectableVirtual.find((entry) => entry.id === defaultModel.modelId);
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
  }, [candidates, defaultModel, selectableVirtual]);

  const runtimeBaseName = (entry: SubagentModelEntry): string | null => {
    if (isVirtualRef(entry)) {
      return selectableVirtual.find((item) => item.id === entry.modelId)?.name ?? null;
    }
    const provider = candidates.find((item) => item.id === entry.providerId);
    return provider && isModelEnabled(provider, entry.modelId)
      ? `${provider.name}/${entry.modelId}`
      : null;
  };
  const isUsable = (entry: SubagentModelEntry) => runtimeBaseName(entry) !== null;

  const displayName = (entry: SubagentModelEntry): string => {
    if (isVirtualRef(entry)) {
      return virtualModels.find((item) => item.id === entry.modelId)?.name ?? entry.modelId;
    }
    const provider = candidates.find((item) => item.id === entry.providerId);
    if (!provider) return entry.modelId;
    const model = provider.models.find((item) => item.id === entry.modelId);
    return `${providerDisplayName(provider, t)} / ${model?.label || entry.modelId}`;
  };

  const active = entries.filter((entry) => entry.enabled !== false);
  const disabled = entries.filter((entry) => entry.enabled === false);
  const suffixes = subagentRuntimeSuffixes(entries, runtimeBaseName);
  const firstFallbackId = active.find(isUsable)?.id;

  const addManually = () => {
    if (!seedSelection) return;
    setEditingId(addEntry({ ...seedSelection, description: '' }).id);
  };
  const toggleEditing = (id: string) => setEditingId((current) => (current === id ? null : id));

  const renderEntry = (entry: SubagentModelEntry, index: number, group: SubagentModelEntry[]) => {
    const editing = editingId === entry.id;
    const suffix = suffixes.get(entry.id);
    const reasoning = reasoningSummary(entry, t);
    return (
      <div key={entry.id} data-slot="subagent-model-row" data-editing={editing || undefined}>
        <div className="flex items-start gap-3 px-4 py-2.5 pl-10 max-sm:pr-3 max-sm:pl-7">
          <button
            type="button"
            data-slot="subagent-model-summary"
            aria-expanded={editing}
            className="min-w-0 flex-1 cursor-pointer text-left"
            onClick={() => toggleEditing(entry.id)}
          >
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                data-slot="subagent-model-name"
                className={cn(
                  'break-all font-medium text-[13px]',
                  entry.enabled === false && 'text-muted-foreground'
                )}
              >
                {displayName(entry)}
              </span>
              <span
                data-slot="subagent-model-reasoning"
                className={cn(
                  'shrink-0 text-[11px]',
                  reasoning ? 'text-muted-foreground' : 'text-muted-foreground/60'
                )}
              >
                {reasoning ?? t('Follow parent')}
              </span>
              {entry.id === firstFallbackId && (
                <Badge variant="info" className="shrink-0 text-[10px]">
                  {t('Preferred fallback')}
                </Badge>
              )}
              {!isUsable(entry) && (
                <Badge variant="warning" className="shrink-0 text-[10px]">
                  {t('Model unavailable')}
                </Badge>
              )}
              {suffix !== undefined && (
                <Badge
                  variant="outline"
                  className="shrink-0 text-[10px]"
                  title={t('The agent sees this entry with suffix #{{count}}', { count: suffix })}
                >
                  #{suffix}
                </Badge>
              )}
            </span>
            <span
              data-slot="subagent-model-description-text"
              className={cn(
                'mt-0.5 block whitespace-pre-wrap break-words text-xs leading-relaxed',
                entry.description.trim() ? 'text-muted-foreground' : 'text-muted-foreground/50'
              )}
            >
              {entry.description.trim() ? entry.description : t('Click to add a description…')}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-slot="subagent-model-edit"
              aria-label={editing ? t('Done') : t('Edit')}
              aria-pressed={editing}
              className={cn('text-muted-foreground', editing && 'bg-accent text-foreground')}
              onClick={() => toggleEditing(entry.id)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Delete')}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => removeEntry(entry.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            <Switch
              data-slot="subagent-model-enabled"
              aria-label={t('Enable subagent model')}
              title={t('Make this model available to subagents')}
              className="ml-1.5"
              checked={entry.enabled !== false}
              onCheckedChange={(next) => updateEntry(entry.id, { enabled: next })}
            />
          </div>
        </div>
        {editing && (
          <div
            data-slot="subagent-model-editor"
            className="space-y-2 border-border/60 border-t bg-muted/45 px-4 py-3 pl-10 max-sm:pr-3 max-sm:pl-7 dark:bg-background/40"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="min-w-[240px] max-w-[420px] flex-1 max-sm:min-w-0">
                <SubagentEntryModelPicker
                  providers={candidates}
                  virtualModels={virtualModels}
                  value={entry}
                  onChange={(patch) => updateEntry(entry.id, patch)}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Move up')}
                disabled={index === 0}
                className="text-muted-foreground"
                onClick={() => moveEntry(entry.id, 'up')}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Move down')}
                disabled={index === group.length - 1}
                className="text-muted-foreground"
                onClick={() => moveEntry(entry.id, 'down')}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <SettingsButton
                data-slot="subagent-model-done"
                className="ml-auto"
                onClick={() => setEditingId(null)}
              >
                {t('Done')}
              </SettingsButton>
            </div>
            <Textarea
              data-slot="subagent-model-description"
              size="sm"
              className={COMPACT_TEXTAREA_CLASS}
              aria-label={t('Description')}
              value={entry.description}
              placeholder={t('When to use it, e.g. cheap and fast for simple subtasks')}
              onChange={(event) => updateEntry(entry.id, { description: event.target.value })}
            />
            <div className="flex flex-wrap gap-1.5">
              {SUBAGENT_ROLE_PRESETS.map((role) => (
                <Button
                  key={role.id}
                  type="button"
                  variant="outline"
                  size="xs"
                  data-slot="subagent-model-template-chip"
                  onClick={() => updateEntry(entry.id, { description: t(role.template) })}
                >
                  {t(role.chip)}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const noModelHint = !seedSelection && (
    <span className="text-muted-foreground text-xs">
      {t('Enable a model and configure valid provider credentials first.')}
    </span>
  );
  // 标题带运行期计数，不进设置搜索目录
  const disabledGroupLabel = t('Disabled ({{count}})', { count: disabled.length });

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

      {enabled && entries.length === 0 && (
        <SettingsEmptyState
          compact
          title={t('No subagent models yet')}
          description={noModelHint || undefined}
          actions={
            <>
              <Button
                size="sm"
                data-slot="subagent-models-wizard"
                disabled={!seedSelection}
                onClick={() => setWizardOpen(true)}
              >
                <Wand2 className="h-3.5 w-3.5" />
                {t('Quick setup wizard')}
              </Button>
              <SettingsButton
                data-slot="subagent-models-add"
                disabled={!seedSelection}
                onClick={addManually}
              >
                {t('Add model manually')}
              </SettingsButton>
            </>
          }
        />
      )}

      {enabled && entries.length > 0 && (
        <>
          {active.map(renderEntry)}
          {disabled.length > 0 && (
            <SettingsExpandableRow
              // defaultOpen 只在挂载时生效；「只剩停用项」切换时重挂载，免得列表整片藏进折叠里
              key={active.length === 0 ? 'disabled-only' : 'disabled-with-active'}
              rowId="providers.subagent-models-disabled"
              label={disabledGroupLabel}
              defaultOpen={active.length === 0}
            >
              {disabled.map(renderEntry)}
            </SettingsExpandableRow>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 pl-10 max-sm:pr-3 max-sm:pl-7">
            <SettingsButton
              data-slot="subagent-models-wizard"
              disabled={!seedSelection}
              onClick={() => setWizardOpen(true)}
            >
              <Wand2 className="h-3.5 w-3.5" />
              {t('Quick setup wizard')}
            </SettingsButton>
            <SettingsButton
              data-slot="subagent-models-add"
              disabled={!seedSelection}
              onClick={addManually}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('Add model')}
            </SettingsButton>
            {noModelHint}
          </div>
        </>
      )}

      {wizardOpen && <SubagentModelsWizard onClose={() => setWizardOpen(false)} />}
    </SettingsSection>
  );
}

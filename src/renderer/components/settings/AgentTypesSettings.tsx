import { isReservedAgentTypeName } from '@shared/builtinAgents';
import { MAX_MAX_ACTIVE_COWORKERS, MIN_MAX_ACTIVE_COWORKERS } from '@shared/maxActiveCoworkers';
import { pickModelCapabilityOverrides } from '@shared/modelCatalog';
import type {
  AgentTypeEntry,
  AgentTypeModelMode,
  MODEL_THINKING_LEVEL_OVERRIDES,
} from '@shared/types';
import { BUILTIN_AGENT_TYPES } from '@shared/types/assets';
import { findVirtualModel } from '@shared/virtualModels';
import { AlertCircle, Bot, Pencil, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { useMaterializedProviders, useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { NewSessionBadge } from './NewSessionBadge';
import { DetailRows, PickList, setFilteredIds } from './PresetsSettings';

export function AgentTypesSettings() {
  const { t } = useI18n();
  const subagentModelsEnabled = useSettingsStore((state) => state.subagentModelsEnabled);
  const subagentModels = useSettingsStore((state) => state.subagentModels);
  const hasSubagentModels = subagentModelsEnabled && subagentModels.length > 0;

  return (
    <div className="space-y-6">
      <div data-settings-row="agents.root">
        <h3 className="font-medium text-lg">
          {t('Agent types')}
          <NewSessionBadge />
        </h3>
        <p className="text-muted-foreground text-sm">
          {t(
            'Custom subagent presets: system prompt, model and toolset. The agent picks one via the agent_type parameter.'
          )}
        </p>
      </div>
      <MaxActiveCoworkersRow />
      {!hasSubagentModels && (
        <Alert variant="warning" className="text-xs">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="text-xs text-foreground/90">
            {t('Subagent models not configured warning')}
          </AlertDescription>
        </Alert>
      )}
      <AgentTypeList hasSubagentModels={hasSubagentModels} />
    </div>
  );
}

const MAX_ACTIVE_COWORKER_OPTIONS = Array.from(
  { length: MAX_MAX_ACTIVE_COWORKERS - MIN_MAX_ACTIVE_COWORKERS + 1 },
  (_, index) => MIN_MAX_ACTIVE_COWORKERS + index
);

function MaxActiveCoworkersRow() {
  const { t } = useI18n();
  const maxActiveCoworkers = useSettingsStore((state) => state.maxActiveCoworkers);
  const setMaxActiveCoworkers = useSettingsStore((state) => state.setMaxActiveCoworkers);
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      data-settings-row="agents.maxActiveCoworkers"
    >
      <div className="min-w-0">
        <p className="text-sm">{t('Max active coworkers')}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            'How many coworkers one conversation can keep at once. Existing ones stay if you lower the limit; hire more only after dismissing. Subagents are not counted.'
          )}
        </p>
      </div>
      <Select
        items={Object.fromEntries(
          MAX_ACTIVE_COWORKER_OPTIONS.map((value) => [String(value), String(value)])
        )}
        value={String(maxActiveCoworkers)}
        onValueChange={(value) => setMaxActiveCoworkers(Number(value))}
      >
        <SelectTrigger className="w-20">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {MAX_ACTIVE_COWORKER_OPTIONS.map((value) => (
            <SelectItem key={value} value={String(value)}>
              {value}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** 类型清单：内置可开关；自定义可增删改且保留名 fail-closed。 */
export function AgentTypeList({ hasSubagentModels = true }: { hasSubagentModels?: boolean }) {
  const { t } = useI18n();
  const agentTypes = useSettingsStore((state) => state.agentTypes);
  const removeAgentType = useSettingsStore((state) => state.removeAgentType);
  const disabledBuiltins = useSettingsStore((state) => state.disabledBuiltinAgentTypes);
  const toggleBuiltin = useSettingsStore((state) => state.toggleBuiltinAgentType);
  const providers = useMaterializedProviders();
  const virtualModels = useSettingsStore((state) => state.virtualModels);
  const [editing, setEditing] = React.useState<
    AgentTypeEntry | 'new' | { defaults: Omit<AgentTypeEntry, 'id'> } | null
  >(null);
  // 同名自定义覆盖内置：被覆盖的内置行隐藏（与 registry / 编码工具路径同口径），
  // 否则设置页会出现两个同名行，且内置行的开关看似有效实则已被顶替。
  const overriddenNames = React.useMemo(
    () => new Set(agentTypes.map((entry) => entry.name.trim().toLowerCase())),
    [agentTypes]
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
        <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            general
            <Badge variant="secondary">{t('Built-in')}</Badge>
          </p>
          <p className="text-muted-foreground text-xs">
            {t('Follows the conversation model, full toolset')}
          </p>
        </div>
      </div>

      {BUILTIN_AGENT_TYPES.filter((type) => !overriddenNames.has(type.name)).map((type) => (
        <div key={type.name} className="flex items-center gap-3 rounded-md border px-3 py-2.5">
          <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              {type.name}
              <Badge variant="secondary">{t('Built-in')}</Badge>
              {type.tools === 'readonly' && <Badge variant="outline">{t('Read-only')}</Badge>}
            </p>
            <p className="truncate text-muted-foreground text-xs">{type.description}</p>
            <p className="text-muted-foreground/80 text-[11px] mt-0.5">
              {hasSubagentModels
                ? t('Picked by main agent')
                : `${t('Picked by main agent')} (${t('Follows the conversation model')})`}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setEditing({ defaults: type })}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Switch
            checked={!disabledBuiltins.includes(type.name)}
            onCheckedChange={(checked) => toggleBuiltin(type.name, checked)}
          />
        </div>
      ))}

      {agentTypes.map((entry) => {
        const provider = providers.find((p) => p.id === entry.providerId);
        const virtual = findVirtualModel(virtualModels, entry);
        const mode = entry.modelMode ?? (entry.providerId && entry.modelId ? 'fixed' : 'follow');
        const modeLabel =
          mode === 'agent_pick'
            ? hasSubagentModels
              ? t('Picked by main agent')
              : `${t('Picked by main agent')} (${t('Follows the conversation model')})`
            : mode === 'fixed'
              ? virtual
                ? virtual.name
                : `${provider?.name ?? '?'} / ${entry.modelId}`
              : t('Follows the conversation model');
        const thinkingChoice = mode === 'fixed' ? thinkingChoiceOf(entry) : '';

        return (
          <div key={entry.id} className="flex items-center gap-3 rounded-md border px-3 py-2.5">
            <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 truncate text-sm font-medium">
                {entry.name}
                {BUILTIN_AGENT_TYPES.some(
                  (type) => type.name === entry.name.trim().toLowerCase()
                ) && <Badge variant="secondary">{t('Overrides built-in')}</Badge>}
                {entry.tools === 'readonly' && <Badge variant="outline">{t('Read-only')}</Badge>}
              </p>
              <p className="truncate text-muted-foreground text-xs">
                {modeLabel}
                {thinkingChoice
                  ? ` · ${t('Thinking level')}: ${thinkingChoice === 'off' ? t('Off') : thinkingChoice}`
                  : ''}
                {entry.description ? ` · ${entry.description}` : ''}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setEditing(entry)}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => removeAgentType(entry.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => setEditing('new')}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
      >
        <Plus className="h-4 w-4" />
        {t('New agent type')}
      </button>

      {editing && (
        <AgentTypeEditDialog
          entry={editing !== 'new' && 'id' in editing ? editing : null}
          defaults={editing !== 'new' && 'defaults' in editing ? editing.defaults : undefined}
          hasSubagentModels={hasSubagentModels}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** 类型级推理选项：'' 跟随 / 'off' 关 / 档位；与派发 thinking 参数同值域 */
type ThinkingChoice = '' | 'off' | (typeof MODEL_THINKING_LEVEL_OVERRIDES)[number];

const thinkingChoiceOf = (seed?: Pick<AgentTypeEntry, 'reasoning' | 'thinkingLevel'>) =>
  seed?.reasoning === 'off' ? 'off' : (seed?.thinkingLevel ?? '');

// 显式写 undefined：updateAgentType 是浅合并，否则改回「跟随」时旧值残留
const thinkingChoiceToFields = (
  choice: ThinkingChoice
): Pick<AgentTypeEntry, 'reasoning' | 'thinkingLevel'> =>
  choice === ''
    ? { reasoning: undefined, thinkingLevel: undefined }
    : choice === 'off'
      ? { reasoning: 'off', thinkingLevel: undefined }
      : { reasoning: 'on', thinkingLevel: choice };

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

export const isCustomAgentTypeNameAllowed = (value: string): boolean => {
  const slug = slugify(value);
  return Boolean(slug) && !isReservedAgentTypeName(value) && !isReservedAgentTypeName(slug);
};

export function AgentTypeEditDialog({
  entry,
  defaults,
  hasSubagentModels = true,
  onClose,
}: {
  entry: AgentTypeEntry | null;
  /** 编辑内置时的预填内容（保存生成同名 custom 覆盖，内置行随之隐藏；删除 custom 后内置恢复） */
  defaults?: Omit<AgentTypeEntry, 'id'>;
  hasSubagentModels?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const candidates = useUsableProviders();
  const virtualModels = useSettingsStore((state) => state.virtualModels);
  const addAgentType = useSettingsStore((state) => state.addAgentType);
  const updateAgentType = useSettingsStore((state) => state.updateAgentType);

  const seed = entry ?? defaults;
  const initialMode: AgentTypeModelMode =
    seed?.modelMode ?? (seed?.providerId && seed?.modelId ? 'fixed' : 'agent_pick');
  const [modelMode, setModelMode] = React.useState<AgentTypeModelMode>(initialMode);
  const [thinking, setThinking] = React.useState<ThinkingChoice>(thinkingChoiceOf(seed));
  const [name, setName] = React.useState(seed?.name ?? '');
  const [description, setDescription] = React.useState(seed?.description ?? '');
  const [systemPrompt, setSystemPrompt] = React.useState(seed?.systemPrompt ?? '');
  const [providerId, setProviderId] = React.useState(seed?.providerId ?? '');
  const [modelId, setModelId] = React.useState(seed?.modelId ?? '');
  const [tools, setTools] = React.useState<'all' | 'readonly'>(seed?.tools ?? 'all');
  const [skillIds, setSkillIds] = React.useState<string[]>(seed?.skillIds ?? []);
  const [mcpServerIds, setMcpServerIds] = React.useState<string[]>(seed?.mcpServerIds ?? []);
  const skills = useSettingsStore((state) => state.skills);
  const mcpServers = useSettingsStore((state) => state.mcpServers);
  const toggleId = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  // 固定模型也允许绑虚拟条目：推理能力按主成员展示与钳位
  const pickerThinkingLevel = thinking !== '' && thinking !== 'off' ? thinking : 'medium';
  // 与子模型一致：类型级推理预设是用户覆盖，不因模型声明能力丢掉档位入口
  const pickerCapabilityOverrides = pickModelCapabilityOverrides({
    reasoning: thinking === 'off' ? 'off' : thinking === '' ? undefined : 'on',
    thinkingLevel: thinking === '' || thinking === 'off' ? undefined : thinking,
  });

  const save = () => {
    const slug = slugify(name);
    if (!isCustomAgentTypeNameAllowed(name)) return;
    const payload = {
      name: slug,
      description,
      systemPrompt,
      tools,
      modelMode,
      skillIds,
      mcpServerIds,
      ...(modelMode === 'fixed' && providerId && modelId ? { providerId, modelId } : {}),
      // 非固定模型不存推理覆盖（跟随模型条目 / 会话）
      ...thinkingChoiceToFields(modelMode === 'fixed' ? thinking : ''),
    };
    if (entry) updateAgentType(entry.id, payload);
    else addAgentType(payload);
    onClose();
  };

  const isSaveDisabled =
    !isCustomAgentTypeNameAllowed(name) || (modelMode === 'fixed' && (!providerId || !modelId));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" disableNestedTransform>
        <DialogHeader>
          <DialogTitle>{entry ? t('Edit agent type') : t('New agent type')}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="max-h-[60vh] space-y-4">
          <Field>
            <FieldLabel>{t('Name (slug)')}</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="scout" />
            {!isCustomAgentTypeNameAllowed(name) && name.trim() && (
              <p className="text-destructive text-xs">{t('This Agent name is reserved')}</p>
            )}
          </Field>
          <Field>
            <FieldLabel>{t('Description (helps the agent pick this type)')}</FieldLabel>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('Fast read-only recon, returns compressed findings')}
            />
          </Field>
          <Field>
            <FieldLabel>{t('System prompt')}</FieldLabel>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={5}
              className="w-full rounded-md border bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
              placeholder={t('You are a fast recon agent. Explore, never modify…')}
            />
          </Field>
          <Field>
            <FieldLabel>{t('Model selection')}</FieldLabel>
            <Select
              items={[
                {
                  value: 'agent_pick',
                  label: `${t('Must be picked by main agent')}${
                    !hasSubagentModels ? ` (${t('Follows the conversation model')})` : ''
                  }`,
                },
                { value: 'follow', label: t('Follow conversation') },
                { value: 'fixed', label: t('Fixed model') },
              ]}
              value={modelMode}
              onValueChange={(value) => setModelMode(value as AgentTypeModelMode)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                <SelectItem value="agent_pick">
                  {t('Must be picked by main agent')}
                  {!hasSubagentModels ? ` (${t('Follows the conversation model')})` : ''}
                </SelectItem>
                <SelectItem value="follow">{t('Follow conversation')}</SelectItem>
                <SelectItem value="fixed">{t('Fixed model')}</SelectItem>
              </SelectPopup>
            </Select>
          </Field>
          {modelMode === 'fixed' && (
            <Field>
              <FieldLabel>{t('Model')}</FieldLabel>
              <ModelPicker
                providers={candidates}
                virtualModels={virtualModels}
                providerId={providerId}
                modelId={modelId}
                modelCapabilityOverrides={pickerCapabilityOverrides}
                reasoningMode={thinking === '' ? 'follow' : thinking === 'off' ? 'off' : 'on'}
                reasoningEnabled={thinking !== '' && thinking !== 'off'}
                thinkingLevel={pickerThinkingLevel}
                onReasoningModeChange={(mode, level) =>
                  setThinking(mode === 'follow' ? '' : mode === 'off' ? 'off' : level)
                }
                onSelect={(nextProviderId, nextModelId) => {
                  setProviderId(nextProviderId);
                  setModelId(nextModelId);
                }}
                onReasoningChange={(enabled) => setThinking(enabled ? pickerThinkingLevel : 'off')}
                onThinkingChange={(level) => setThinking(level)}
                side="bottom"
                triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
                zIndex={Z_INDEX.DROPDOWN_IN_MODAL}
              />
            </Field>
          )}
          <Field>
            <FieldLabel>{t('Toolset')}</FieldLabel>
            <Select
              items={[
                { value: 'all', label: t('All tools (bash/edit/write)') },
                { value: 'readonly', label: t('Read-only (read/grep/find/ls + bound MCP)') },
              ]}
              value={tools}
              onValueChange={(value) => setTools(value as 'all' | 'readonly')}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                <SelectItem value="all">{t('All tools (bash/edit/write)')}</SelectItem>
                <SelectItem value="readonly">
                  {t('Read-only (read/grep/find/ls + bound MCP)')}
                </SelectItem>
              </SelectPopup>
            </Select>
          </Field>
          <PickList
            title={t('Skills')}
            emptyText={t('No skills yet')}
            items={skills}
            getName={(s) => s.name}
            getSource={(s) => s.source}
            isChecked={(s) => skillIds.includes(s.id)}
            onToggle={(s) => setSkillIds((list) => toggleId(list, s.id))}
            onSetFiltered={(ids, selected) =>
              setSkillIds((list) => setFilteredIds(list, ids, selected))
            }
            placeholder={t('Filter skills...')}
            renderDetail={(s) => (
              <DetailRows
                rows={[
                  [t('Source'), s.source],
                  [t('Path'), s.path],
                  [t('Description'), s.description],
                ]}
              />
            )}
          />
          <PickList
            title={t('MCP Servers')}
            emptyText={t('No MCP servers yet')}
            items={mcpServers}
            getName={(m) => m.name}
            getSource={(m) => m.source}
            isChecked={(m) => mcpServerIds.includes(m.id)}
            onToggle={(m) => setMcpServerIds((list) => toggleId(list, m.id))}
            onSetFiltered={(ids, selected) =>
              setMcpServerIds((list) => setFilteredIds(list, ids, selected))
            }
            placeholder={t('Filter MCP servers...')}
            renderDetail={(m) => (
              <DetailRows
                rows={[
                  [t('Source'), m.source],
                  ['Transport', m.transport],
                  ['Command', [m.command, ...(m.args ?? [])].filter(Boolean).join(' ')],
                  ['URL', m.url],
                ]}
              />
            )}
          />
          <div className="h-2" />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={save} disabled={isSaveDisabled}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

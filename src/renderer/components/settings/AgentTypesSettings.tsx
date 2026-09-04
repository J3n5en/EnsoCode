import { ENSO_AGENT_TYPE_KEY, isReservedAgentTypeName } from '@shared/builtinAgents';
import type { AgentTypeEntry, AgentTypeModelMode } from '@shared/types';
import { hasProviderCredentials } from '@shared/types';
import { BUILTIN_AGENT_TYPES } from '@shared/types/assets';
import { AlertCircle, Bot, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert';
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
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { DetailRows, PickList, setFilteredIds } from './PresetsSettings';

export function AgentTypesSettings() {
  const { t } = useI18n();
  const subagentModelsEnabled = useSettingsStore((state) => state.subagentModelsEnabled);
  const subagentModels = useSettingsStore((state) => state.subagentModels);
  const hasSubagentModels = subagentModelsEnabled && subagentModels.length > 0;

  return (
    <div className="space-y-6">
      <div data-settings-row="agents.root">
        <h3 className="font-medium text-lg">{t('Agent types')}</h3>
        <p className="text-muted-foreground text-sm">
          {t(
            'Custom subagent presets: system prompt, model and toolset. The agent picks one via the agent_type parameter.'
          )}
        </p>
      </div>
      {!hasSubagentModels && (
        <Alert variant="warning" className="text-xs">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="text-xs text-foreground/90">
            {t('Subagent models not configured warning')}
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2.5 text-xs bg-background/80 hover:bg-background"
              onClick={() => {
                void window.electronAPI.window.summonAgent({
                  typeKey: ENSO_AGENT_TYPE_KEY,
                  prompt: t('Ask Enso to configure subagent models'),
                });
              }}
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              {t('Auto configure with AI')}
            </Button>
          </AlertAction>
        </Alert>
      )}
      <AgentTypeList hasSubagentModels={hasSubagentModels} />
    </div>
  );
}

/** 类型清单：Enso 固定只读；内置可开关；自定义可增删改且保留名 fail-closed。 */
export function AgentTypeList({ hasSubagentModels = true }: { hasSubagentModels?: boolean }) {
  const { t } = useI18n();
  const agentTypes = useSettingsStore((state) => state.agentTypes);
  const removeAgentType = useSettingsStore((state) => state.removeAgentType);
  const disabledBuiltins = useSettingsStore((state) => state.disabledBuiltinAgentTypes);
  const toggleBuiltin = useSettingsStore((state) => state.toggleBuiltinAgentType);
  const providers = useSettingsStore((state) => state.providers);
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
      <div className="flex items-center gap-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5">
        <Bot className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            Enso
            <Badge variant="secondary">{t('System')}</Badge>
            <Badge variant="outline">{t('Locked')}</Badge>
          </p>
          <p className="text-muted-foreground text-xs">
            {t('Inherits the conversation model and provides product capabilities')}
          </p>
        </div>
      </div>

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
        const mode = entry.modelMode ?? (entry.providerId && entry.modelId ? 'fixed' : 'follow');
        const modeLabel =
          mode === 'agent_pick'
            ? hasSubagentModels
              ? t('Picked by main agent')
              : `${t('Picked by main agent')} (${t('Follows the conversation model')})`
            : mode === 'fixed'
              ? `${provider?.name ?? '?'} / ${entry.modelId}`
              : t('Follows the conversation model');

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
  const providers = useSettingsStore((state) => state.providers);
  const addAgentType = useSettingsStore((state) => state.addAgentType);
  const updateAgentType = useSettingsStore((state) => state.updateAgentType);

  const seed = entry ?? defaults;
  const initialMode: AgentTypeModelMode =
    seed?.modelMode ?? (seed?.providerId && seed?.modelId ? 'fixed' : 'agent_pick');
  const [modelMode, setModelMode] = React.useState<AgentTypeModelMode>(initialMode);
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

  const provider = providers.find((p) => p.id === providerId);
  const models = (provider?.models ?? []).filter((m) => m.enabled !== false);

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
            <select
              value={modelMode}
              onChange={(e) => setModelMode(e.target.value as AgentTypeModelMode)}
              className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none"
            >
              <option value="agent_pick">
                {t('Must be picked by main agent')}
                {!hasSubagentModels ? ` (${t('Follows the conversation model')})` : ''}
              </option>
              <option value="follow">{t('Follow conversation')}</option>
              <option value="fixed">{t('Fixed model')}</option>
            </select>
          </Field>
          {modelMode === 'fixed' && (
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel>{t('Provider (optional)')}</FieldLabel>
                <select
                  value={providerId}
                  onChange={(e) => {
                    setProviderId(e.target.value);
                    setModelId('');
                  }}
                  className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none"
                >
                  <option value="">{t('Select provider') || '选择服务商'}</option>
                  {providers
                    .filter((p) => p.enabled && hasProviderCredentials(p))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field>
                <FieldLabel>{t('Model')}</FieldLabel>
                <select
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  disabled={!providerId}
                  className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none disabled:opacity-50"
                >
                  <option value="">{providerId ? t('Select model') : '—'}</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          <Field>
            <FieldLabel>{t('Toolset')}</FieldLabel>
            <select
              value={tools}
              onChange={(e) => setTools(e.target.value as 'all' | 'readonly')}
              className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none"
            >
              <option value="all">{t('All tools (bash/edit/write)')}</option>
              <option value="readonly">{t('Read-only (read/grep/find/ls)')}</option>
            </select>
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

import type { AgentTypeEntry } from '@shared/types';
import { BUILTIN_AGENT_TYPES } from '@shared/types/assets';
import { Bot, Pencil, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
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
import { DetailRows, PickList } from './PresetsSettings';

export function AgentTypesSettings() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-medium text-lg">{t('Agent types')}</h3>
        <p className="text-muted-foreground text-sm">
          {t(
            'Custom subagent presets: system prompt, model and toolset. The agent picks one via the agent_type parameter.'
          )}
        </p>
      </div>
      <AgentTypeList />
    </div>
  );
}

/** 类型清单(设置页与 onboarding 共用):内置可编辑成同名覆盖/开关禁用,自定义可增删改;编辑弹窗自足 */
export function AgentTypeList() {
  const { t } = useI18n();
  const agentTypes = useSettingsStore((state) => state.agentTypes);
  const removeAgentType = useSettingsStore((state) => state.removeAgentType);
  const disabledBuiltins = useSettingsStore((state) => state.disabledBuiltinAgentTypes);
  const toggleBuiltin = useSettingsStore((state) => state.toggleBuiltinAgentType);
  const providers = useSettingsStore((state) => state.providers);
  const [editing, setEditing] = React.useState<
    AgentTypeEntry | 'new' | { defaults: Omit<AgentTypeEntry, 'id'> } | null
  >(null);
  // 被自定义同名覆盖的内置隐藏；编辑内置＝创建同名自定义副本（删除副本即恢复默认）
  const overridden = new Set(agentTypes.map((entry) => entry.name));

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

      {BUILTIN_AGENT_TYPES.filter((type) => !overridden.has(type.name)).map((type) => (
        <div key={type.name} className="flex items-center gap-3 rounded-md border px-3 py-2.5">
          <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              {type.name}
              <Badge variant="secondary">{t('Built-in')}</Badge>
              {type.tools === 'readonly' && <Badge variant="outline">{t('Read-only')}</Badge>}
            </p>
            <p className="truncate text-muted-foreground text-xs">{type.description}</p>
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
        return (
          <div key={entry.id} className="flex items-center gap-3 rounded-md border px-3 py-2.5">
            <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 truncate text-sm font-medium">
                {entry.name}
                {entry.tools === 'readonly' && <Badge variant="outline">{t('Read-only')}</Badge>}
              </p>
              <p className="truncate text-muted-foreground text-xs">
                {entry.modelId
                  ? `${provider?.name ?? '?'} / ${entry.modelId}`
                  : t('Follows the conversation model')}
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

export function AgentTypeEditDialog({
  entry,
  defaults,
  onClose,
}: {
  entry: AgentTypeEntry | null;
  /** 编辑内置时的预填内容（保存生成同名自定义覆盖） */
  defaults?: Omit<AgentTypeEntry, 'id'>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const addAgentType = useSettingsStore((state) => state.addAgentType);
  const updateAgentType = useSettingsStore((state) => state.updateAgentType);

  const seed = entry ?? defaults;
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
    if (!slug) return;
    const payload = {
      name: slug,
      description,
      systemPrompt,
      tools,
      skillIds,
      mcpServerIds,
      ...(providerId && modelId ? { providerId, modelId } : {}),
    };
    if (entry) updateAgentType(entry.id, payload);
    else addAgentType(payload);
    onClose();
  };

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
                <option value="">{t('Follow conversation')}</option>
                {providers
                  .filter((p) => p.enabled && p.apiKey)
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
          <Button onClick={save} disabled={!slugify(name)}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

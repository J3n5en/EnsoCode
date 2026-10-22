import type { InstructionEntry, Preset } from '@shared/types';
import { Eye, Layers, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { ListFilterBar, matchesFilter } from './ListFilterBar';
import { NewSessionBadge } from './NewSessionBadge';

export function PresetsSettings() {
  const { t } = useI18n();
  const presets = useSettingsStore((state) => state.presets);
  const removePreset = useSettingsStore((state) => state.removePreset);
  const defaultPresetId = useSettingsStore((state) => state.defaultPresetId);
  const setDefaultPresetId = useSettingsStore((state) => state.setDefaultPresetId);
  const [editing, setEditing] = React.useState<Preset | 'new' | null>(null);
  const [previewDefault, setPreviewDefault] = React.useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4" data-settings-row="presets.root">
        <div>
          <h3 className="font-medium text-lg">
            {t('Presets')}
            <NewSessionBadge />
          </h3>
          <p className="text-muted-foreground text-sm">
            {t(
              'Role descriptions, skills, MCP servers and instruction files, chosen per conversation'
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t('New preset')}
        </Button>
      </div>

      <div className="space-y-2">
        {/* 内置全局预设：只读，跟随各条目的 enabled 开关 */}
        <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
          <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              {t('Global')}
              <Badge variant="outline">{t('Read-only')}</Badge>
              {defaultPresetId === 'default' && <Badge variant="secondary">{t('Default')}</Badge>}
            </p>
            <p className="text-muted-foreground text-xs">
              {t('Follows the enabled switches on the Skills / MCP / Instructions pages')}
            </p>
          </div>
          {defaultPresetId !== 'default' && (
            <Button variant="ghost" size="sm" onClick={() => setDefaultPresetId('default')}>
              {t('Set as default')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('View default role description')}
            onClick={() => setPreviewDefault(true)}
          >
            <Eye className="h-4 w-4" />
          </Button>
        </div>

        {presets
          .filter((preset) => preset.id !== 'default')
          .map((preset) => (
            <div key={preset.id} className="flex items-center gap-3 rounded-md border px-3 py-2.5">
              <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  {preset.name}
                  {preset.systemPromptId && <Badge variant="outline">{t('Custom role')}</Badge>}
                  {defaultPresetId === preset.id && (
                    <Badge variant="secondary">{t('Default')}</Badge>
                  )}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('{{skills}} skills · {{mcp}} MCP · {{instruction}} instruction', {
                    skills: preset.skillIds.length,
                    mcp: preset.mcpServerIds.length,
                    instruction: preset.instructionId ? 1 : 0,
                  })}
                </p>
              </div>
              {defaultPresetId !== preset.id && (
                <Button variant="ghost" size="sm" onClick={() => setDefaultPresetId(preset.id)}>
                  {t('Set as default')}
                </Button>
              )}
              <Button variant="ghost" size="icon" onClick={() => setEditing(preset)}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => removePreset(preset.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
      </div>

      {editing !== null && (
        <PresetEditDialog
          preset={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {previewDefault && <DefaultSystemPromptDialog onClose={() => setPreviewDefault(false)} />}
    </div>
  );
}

export function PresetEditDialog({
  preset,
  onClose,
}: {
  preset: Preset | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const skills = useSettingsStore((state) => state.skills);
  const mcpServers = useSettingsStore((state) => state.mcpServers);
  const instructions = useSettingsStore((state) => state.instructions);
  const addPreset = useSettingsStore((state) => state.addPreset);
  const updatePreset = useSettingsStore((state) => state.updatePreset);

  const [name, setName] = React.useState(preset?.name ?? '');
  const [skillIds, setSkillIds] = React.useState<string[]>(preset?.skillIds ?? []);
  const [mcpServerIds, setMcpServerIds] = React.useState<string[]>(preset?.mcpServerIds ?? []);
  const [instructionId, setInstructionId] = React.useState<string | undefined>(
    preset?.instructionId
  );
  const [customPrompt, setCustomPrompt] = React.useState(Boolean(preset?.systemPromptId));
  const prompt = useSystemPromptContent(preset?.systemPromptId);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const save = async () => {
    if (
      saving ||
      prompt.loading ||
      prompt.error ||
      (customPrompt && prompt.selectionError) ||
      preset?.id === 'default'
    )
      return;
    setSaving(true);
    setSaveError('');
    try {
      let systemPromptId: string | undefined;
      if (customPrompt) {
        if (!prompt.content.trim()) throw new Error(t('System prompt cannot be empty'));
        systemPromptId = preset?.systemPromptId;
        if (!systemPromptId || prompt.content !== prompt.originalContent) {
          systemPromptId = crypto.randomUUID();
          const result = await window.electronAPI.presets.writeSystemPrompt(
            systemPromptId,
            prompt.content
          );
          if (!result.ok) throw new Error(result.error || t('Failed to save system prompt'));
        }
      }
      const payload = {
        name: name.trim() || t('Untitled'),
        skillIds,
        mcpServerIds,
        instructionId,
        systemPromptId,
      };
      if (preset) updatePreset(preset.id, payload);
      else addPreset(payload);
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-xl" disableNestedTransform>
        <DialogHeader>
          <DialogTitle>{preset ? t('Edit preset') : t('New preset')}</DialogTitle>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <Field>
            <FieldLabel>{t('Name')}</FieldLabel>
            <Input value={name} disabled={saving} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field className="w-full">
            <FieldLabel>{t('Role description')}</FieldLabel>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={customPrompt}
                disabled={saving || prompt.loading || Boolean(prompt.error)}
                onCheckedChange={(checked) => setCustomPrompt(Boolean(checked))}
              />
              {t('Replace pi opening role description')}
            </label>
            {customPrompt && (
              <p className="text-xs text-muted-foreground">
                {t(
                  'Only replaces the opening role paragraph. Available tools and everything after it stay unchanged. Applies to new and cold-restored sessions.'
                )}
              </p>
            )}
            {(customPrompt || prompt.error) && (
              <SystemPromptText
                content={prompt.content}
                readOnly={saving}
                loading={prompt.loading}
                error={prompt.error || prompt.selectionError}
                onChange={prompt.setContent}
                onRetry={prompt.retry}
              />
            )}
          </Field>

          <PickList
            title={t('Skills')}
            emptyText={t('No skills yet')}
            items={skills}
            getName={(s) => s.name}
            getSource={(s) => s.source}
            isChecked={(s) => skillIds.includes(s.id)}
            onToggle={(s) => setSkillIds((list) => toggle(list, s.id))}
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
            onToggle={(m) => setMcpServerIds((list) => toggle(list, m.id))}
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

          <PickList
            title={t('Instruction Files')}
            emptyText={t('No instruction files yet')}
            items={instructions}
            getName={(i) => i.name}
            getSource={(i) => i.source}
            isChecked={(i) => instructionId === i.id}
            onToggle={(i) => setInstructionId((cur) => (cur === i.id ? undefined : i.id))}
            leading={
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5">
                <Checkbox
                  checked={instructionId === undefined}
                  onCheckedChange={() => setInstructionId(undefined)}
                />
                <span className="text-sm text-muted-foreground">{t('None')}</span>
              </label>
            }
            renderDetail={(i) => <InstructionDetail instruction={i} />}
          />
        </DialogPanel>

        <DialogFooter>
          {saveError && (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {saveError}
            </p>
          )}
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={
              saving ||
              prompt.loading ||
              Boolean(prompt.error) ||
              (customPrompt && (Boolean(prompt.selectionError) || !prompt.content.trim()))
            }
            onClick={save}
          >
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useSystemPromptContent(id?: string) {
  const { t } = useI18n();
  const [content, setContent] = React.useState('');
  const [originalContent, setOriginalContent] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [selectionError, setSelectionError] = React.useState('');
  const [attempt, setAttempt] = React.useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries failed file reads.
  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setSelectionError('');
    const readDefault = window.electronAPI.presets.readSystemPrompt();
    Promise.all([readDefault, id ? window.electronAPI.presets.readSystemPrompt(id) : readDefault])
      .then(([builtin, selected]) => {
        if (!alive) return;
        if (!builtin.ok) {
          setError(builtin.error || t('Failed to read system prompt'));
          return;
        }
        if (!selected.ok) {
          setSelectionError(selected.error || t('Failed to read system prompt'));
          return;
        }
        setOriginalContent(selected.content);
        setContent(selected.content);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, attempt, t]);
  return {
    content,
    setContent,
    originalContent,
    loading,
    error,
    selectionError,
    retry: () => setAttempt((value) => value + 1),
  };
}

function SystemPromptText({
  content,
  readOnly,
  loading,
  error,
  onChange,
  onRetry,
}: {
  content: string;
  readOnly: boolean;
  loading: boolean;
  error: string;
  onChange?: (content: string) => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  if (loading) return <p className="text-sm text-muted-foreground">{t('Loading...')}</p>;
  if (error)
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('Retry')}
        </Button>
      </div>
    );
  return (
    <Textarea
      aria-label={t('Role description')}
      className="h-32 w-full resize-y font-mono text-xs leading-relaxed"
      value={content}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(event) => onChange?.(event.target.value)}
    />
  );
}

function DefaultSystemPromptDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const prompt = useSystemPromptContent();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('Global')} · {t('Built-in default (read-only)')}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t(
              'This is the pi opening role paragraph. Custom presets replace only this paragraph; tools, guidelines and project context stay unchanged.'
            )}
          </p>
          <SystemPromptText
            content={prompt.content}
            readOnly
            loading={prompt.loading}
            error={prompt.error}
            onRetry={prompt.retry}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function setFilteredIds(
  current: string[],
  filteredIds: string[],
  selected: boolean
): string[] {
  if (filteredIds.length === 0) return current;
  const vis = new Set(filteredIds);
  if (selected) {
    const extra = filteredIds.filter((id) => !current.includes(id));
    return extra.length === 0 ? current : [...current, ...extra];
  }
  const next = current.filter((id) => !vis.has(id));
  return next.length === current.length ? current : next;
}

/** 带搜索的可勾选列表：每项 checkbox + 名字 + 来源角标 + 眼睛（居中 detail 弹窗） */
export function PickList<T extends { id: string }>({
  title,
  emptyText,
  items,
  getName,
  getSource,
  isChecked,
  onToggle,
  onSetFiltered,
  placeholder,
  renderDetail,
  leading,
}: {
  title: string;
  emptyText: string;
  items: T[];
  getName: (item: T) => string;
  getSource?: (item: T) => string;
  isChecked: (item: T) => boolean;
  onToggle: (item: T) => void;
  onSetFiltered?: (ids: string[], selected: boolean) => void;
  placeholder?: string;
  renderDetail: (item: T) => React.ReactNode;
  leading?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [detail, setDetail] = React.useState<T | null>(null);
  const filtered = items.filter((item) => matchesFilter(query, [getName(item), getSource?.(item)]));
  const filteredIds = filtered.map((item) => item.id);
  const selectedCount = filtered.filter(isChecked).length;
  const allSelected = filtered.length > 0 && selectedCount === filtered.length;
  const someSelected = selectedCount > 0 && !allSelected;

  return (
    <div>
      <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      <div className="rounded-md border">
        {items.length > 0 && (
          <div className="border-b p-1.5">
            <ListFilterBar
              query={query}
              onQueryChange={setQuery}
              placeholder={placeholder ?? t('Search')}
              allSelected={allSelected}
              someSelected={someSelected}
              onToggleSelectAll={
                onSetFiltered ? (selected) => onSetFiltered(filteredIds, selected) : undefined
              }
              onEnable={onSetFiltered ? () => onSetFiltered(filteredIds, true) : undefined}
              onDisable={onSetFiltered ? () => onSetFiltered(filteredIds, false) : undefined}
              selectDisabled={filtered.length === 0}
              actionDisabled={filtered.length === 0}
            />
          </div>
        )}

        <div className="max-h-40 overflow-y-auto p-1.5">
          {leading}
          {items.length === 0 && <Empty text={emptyText} />}
          {items.length > 0 && filtered.length === 0 && <Empty text={t('No results')} />}
          {filtered.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted"
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <Checkbox checked={isChecked(item)} onCheckedChange={() => onToggle(item)} />
                <span className="min-w-0 flex-1 truncate text-sm">{getName(item)}</span>
                {getSource && (
                  <Badge variant="secondary" className="shrink-0 text-[11px]">
                    {getSource(item)}
                  </Badge>
                )}
              </label>
              <button
                type="button"
                onClick={() => setDetail(item)}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-lg" zIndexLevel="nested">
          <DialogHeader>
            <DialogTitle>{detail ? getName(detail) : ''}</DialogTitle>
          </DialogHeader>
          <DialogPanel>{detail && renderDetail(detail)}</DialogPanel>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function DetailRows({ rows }: { rows: [string, string | undefined][] }) {
  return (
    <div className="space-y-2 text-xs">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label}>
            <p className="font-semibold text-muted-foreground">{label}</p>
            <p className="mt-0.5 break-words whitespace-pre-wrap">{value}</p>
          </div>
        ))}
    </div>
  );
}

/** 指令文件 detail：元信息 + 内容预览（异步读取） */
function InstructionDetail({ instruction }: { instruction: InstructionEntry }) {
  const { t } = useI18n();
  const [content, setContent] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    window.electronAPI.instructions
      .read(instruction.id, instruction.local, instruction.sourcePath)
      .then((r) => {
        if (alive) setContent(r.ok ? r.content : (r.error ?? ''));
      });
    return () => {
      alive = false;
    };
  }, [instruction]);

  return (
    <div className="space-y-2 text-xs">
      <DetailRows
        rows={[
          [t('Source'), instruction.source],
          [t('Path'), instruction.sourcePath ?? (instruction.local ? t('Local copy') : '')],
        ]}
      />
      <div>
        <p className="font-semibold text-muted-foreground">{t('Content')}</p>
        <pre className="mt-0.5 max-h-60 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {content ?? `${t('Loading...')}`}
        </pre>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-2 text-xs text-muted-foreground">{text}</p>;
}

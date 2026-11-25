import { BUILTIN_AGENT_TYPES } from '@shared/types/assets';
import type {
  WorkflowDesign,
  WorkflowPresetArg,
  WorkflowPresetDraft,
  WorkflowPresetSummary,
} from '@shared/types/workflow';
import { generateWorkflowScript, parseWorkflowDesign } from '@shared/workflowDesign';
import {
  CircleAlert,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  WandSparkles,
  Workflow,
  X,
} from 'lucide-react';
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
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs';
import { useI18n } from '@/i18n';
import { formatScript } from '@/lib/formatScript';
import { useSettingsStore } from '@/stores/settings';
import { CodeEditor } from './CodeEditor';
import {
  SettingsButton,
  SettingsEmptyState,
  SettingsPage,
  SettingsPreview,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from './kit';
import { WorkflowDesigner } from './WorkflowDesigner';

const NEW_DESIGN: WorkflowDesign = {
  phases: [
    {
      title: 'Investigate',
      steps: [
        {
          label: 'code',
          agentType: 'scout',
          prompt: 'Investigate {{args.topic}} in the source code.',
        },
        { label: 'tests', agentType: 'scout', prompt: 'Investigate {{args.topic}} in the tests.' },
      ],
    },
    {
      title: 'Summarize',
      steps: [
        {
          label: 'summary',
          agentType: 'scout',
          prompt: 'Merge these findings about {{args.topic}} into one short report:\n\n{{prev}}',
        },
      ],
    },
  ],
};

const NEW_DRAFT: WorkflowPresetDraft = {
  name: '',
  description: '',
  args: [{ key: 'topic', label: 'Topic', required: true }],
  design: NEW_DESIGN,
  script: generateWorkflowScript(NEW_DESIGN),
};

type EditorTab = 'design' | 'code';

/** 表单里空默认值/空标签不落盘，标签缺省用 key。 */
function normalizeArgs(args: WorkflowPresetArg[]): WorkflowPresetArg[] {
  return args.map(({ key, label, default: value, required }) => ({
    key: key.trim(),
    label: label.trim() || key.trim(),
    ...(value?.trim() ? { default: value } : {}),
    ...(required ? { required: true } : {}),
  }));
}

function WorkflowPresetDialog({
  target,
  onClose,
  onSaved,
}: {
  target: string | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<WorkflowPresetDraft>(NEW_DRAFT);
  const [tab, setTab] = React.useState<EditorTab>('design');
  const [epoch, setEpoch] = React.useState(0);
  /** 手改代码脱离设计后，切回设计器可恢复这份设计 */
  const detachedDesign = React.useRef<WorkflowDesign | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [formatting, setFormatting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const disabledBuiltinAgentTypes = useSettingsStore((state) => state.disabledBuiltinAgentTypes);
  const customAgentTypes = useSettingsStore((state) => state.agentTypes);
  const agentTypes = React.useMemo(
    () => [
      ...BUILTIN_AGENT_TYPES.map((type) => type.name).filter(
        (name) => !disabledBuiltinAgentTypes.includes(name)
      ),
      ...customAgentTypes.map((type) => type.name),
    ],
    [disabledBuiltinAgentTypes, customAgentTypes]
  );

  React.useEffect(() => {
    setError(null);
    if (target === null) return;
    detachedDesign.current = null;
    setEpoch((n) => n + 1);
    if (target === 'new') {
      setDraft(NEW_DRAFT);
      setTab('design');
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.electronAPI.workflowPresets
      .read(target)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded) {
          const { id: _id, ...rest } = loaded;
          setDraft(rest);
          setTab(rest.design ? 'design' : 'code');
          setEpoch((n) => n + 1);
        } else setError(t('Failed to read content'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target, t]);

  const patch = (next: Partial<WorkflowPresetDraft>) => setDraft((d) => ({ ...d, ...next }));
  const patchArg = (index: number, next: Partial<WorkflowPresetArg>) =>
    patch({ args: draft.args.map((arg, i) => (i === index ? { ...arg, ...next } : arg)) });
  const setDesign = (design: WorkflowDesign) =>
    patch({ design, script: generateWorkflowScript(design) });
  const editCode = (script: string) => {
    if (script === draft.script) return;
    if (draft.design) detachedDesign.current = draft.design;
    setDraft((d) => ({ ...d, script, design: undefined }));
  };
  const handleFormat = async () => {
    setFormatting(true);
    const result = await formatScript(draft.script);
    setFormatting(false);
    if (!result.ok) {
      setError(t('Format failed: {{error}}', { error: result.error }));
      return;
    }
    setError(null);
    if (result.code === draft.script) return;
    editCode(result.code);
    setEpoch((n) => n + 1);
  };
  const designValid = !draft.design || parseWorkflowDesign(draft.design) !== null;
  const canSave =
    !loading &&
    !saving &&
    draft.name.trim() !== '' &&
    draft.description.trim() !== '' &&
    designValid &&
    draft.script.trim() !== '';

  const handleSave = async () => {
    if (!canSave || target === null) return;
    setSaving(true);
    const result = await window.electronAPI.workflowPresets.save(
      { ...draft, args: normalizeArgs(draft.args) },
      target === 'new' ? undefined : target
    );
    setSaving(false);
    if (!result.ok) {
      setError(t(result.error));
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {target === 'new' ? t('Add workflow preset') : t('Edit workflow preset')}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <Field>
            <FieldLabel>{t('Name')}</FieldLabel>
            <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel>{t('Description')}</FieldLabel>
            <Input
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel>{t('Arguments')}</FieldLabel>
            <div className="w-full space-y-1.5">
              {draft.args.map((arg, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 行无稳定 id，key 可编辑
                <div key={index} className="flex items-center gap-1.5">
                  <Input
                    size="sm"
                    className="w-28 font-mono"
                    placeholder="key"
                    value={arg.key}
                    onChange={(e) => patchArg(index, { key: e.target.value })}
                  />
                  <Input
                    size="sm"
                    className="flex-1"
                    placeholder={t('Label')}
                    value={arg.label}
                    onChange={(e) => patchArg(index, { label: e.target.value })}
                  />
                  <Input
                    size="sm"
                    className="flex-1"
                    placeholder={t('Default value')}
                    value={arg.default ?? ''}
                    onChange={(e) => patchArg(index, { default: e.target.value })}
                  />
                  <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
                    <Checkbox
                      checked={arg.required === true}
                      onCheckedChange={(checked) => patchArg(index, { required: checked === true })}
                    />
                    {t('Required')}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('Remove')}
                    onClick={() => patch({ args: draft.args.filter((_, i) => i !== index) })}
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="xs"
                disabled={draft.args.length >= 8}
                onClick={() => patch({ args: [...draft.args, { key: '', label: '' }] })}
              >
                <Plus />
                {t('Add argument')}
              </Button>
            </div>
          </Field>
          <Field>
            <div className="flex w-full items-center justify-between gap-2">
              <FieldLabel>{t('Steps')}</FieldLabel>
              {tab === 'code' && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto"
                  disabled={loading || formatting || !!draft.design || !draft.script.trim()}
                  title={draft.design ? t('Generated code is already formatted') : undefined}
                  onClick={handleFormat}
                >
                  {formatting ? <Loader2 className="animate-spin" /> : <WandSparkles />}
                  {t('Format')}
                </Button>
              )}
              <Tabs value={tab} onValueChange={(value) => setTab(value as EditorTab)}>
                <TabsList>
                  <TabsTab value="design">{t('Design')}</TabsTab>
                  <TabsTab value="code">{t('Code')}</TabsTab>
                </TabsList>
              </Tabs>
            </div>
            {loading ? (
              <SettingsPreview className="flex w-full items-center justify-center py-12">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </SettingsPreview>
            ) : tab === 'design' ? (
              draft.design ? (
                <WorkflowDesigner
                  design={draft.design}
                  agentTypes={agentTypes}
                  args={draft.args}
                  onChange={setDesign}
                />
              ) : (
                <SettingsPreview className="flex w-full flex-col items-center gap-2 py-8 text-center">
                  <p className="max-w-md text-muted-foreground text-xs">
                    {t(
                      'This preset is plain code and cannot be shown in the designer. Using the designer replaces the current script.'
                    )}
                  </p>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setDesign(detachedDesign.current ?? NEW_DESIGN)}
                  >
                    {t('Use the designer')}
                  </Button>
                </SettingsPreview>
              )
            ) : (
              <CodeEditor
                fileName="workflow.js"
                className="h-80"
                value={draft.script}
                epoch={epoch}
                onChange={editCode}
              />
            )}
            <p className="text-muted-foreground text-xs">
              {tab === 'design'
                ? !designValid &&
                  t('Every phase needs a title and every step needs a label and a prompt.')
                : draft.design
                  ? t('Generated from the design. Editing the code detaches it from the designer.')
                  : t(
                      'Plain JavaScript with top-level await; end with return. Available: agent(prompt, opts), parallel, pipeline, phase, log, args.'
                    )}
            </p>
          </Field>
          {error && (
            <p className="flex items-center gap-1.5 text-destructive text-xs">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={!canSave} onClick={handleSave}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WorkflowsSettings() {
  const { t } = useI18n();
  const [all, setAll] = React.useState<WorkflowPresetSummary[]>([]);
  const [editing, setEditing] = React.useState<string | 'new' | null>(null);
  const disabled = useSettingsStore((state) => state.disabledWorkflowPresets);
  const toggleWorkflowPreset = useSettingsStore((state) => state.toggleWorkflowPreset);
  const reload = React.useCallback(() => {
    void window.electronAPI.workflowPresets.list().then(setAll);
  }, []);
  React.useEffect(reload, [reload]);
  const presets = all.filter((preset) => preset.source !== 'builtin');
  const builtins = all.filter((preset) => preset.source === 'builtin');

  return (
    <SettingsPage
      rowId="workflows.root"
      title={t('Workflows')}
      description={
        <>
          {t('Preset workflows you can run from the Workflow side panel')}
          <span className="mt-0.5 block text-xs">
            {t(
              'Project .agents/workflows files take precedence over these; ~/.agents/workflows and built-in presets come after.'
            )}
          </span>
        </>
      }
      actions={
        <SettingsButton variant="default" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" />
          {t('Add workflow preset')}
        </SettingsButton>
      }
    >
      <SettingsSection rowId="workflows.custom-presets" title={t('Custom presets')}>
        {presets.length === 0 ? (
          <SettingsEmptyState
            icon={Workflow}
            title={t('No custom workflow presets yet')}
            actions={
              <SettingsButton variant="default" onClick={() => setEditing('new')}>
                <Plus className="h-4 w-4" />
                {t('Add workflow preset')}
              </SettingsButton>
            }
          />
        ) : (
          presets.map((preset) => (
            <SettingsRow
              key={preset.id}
              rowId={`workflows.${preset.id}`}
              label={preset.name}
              description={<span className="block truncate">{preset.description}</span>}
              status={
                <Badge variant="secondary" className="shrink-0 font-mono text-[11px]">
                  {preset.id}
                </Badge>
              }
            >
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                aria-label={t('Edit')}
                onClick={() => setEditing(preset.id)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label={t('Delete')}
                onClick={() =>
                  void window.electronAPI.workflowPresets.delete(preset.id).then(reload)
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </SettingsRow>
          ))
        )}
      </SettingsSection>

      {builtins.length > 0 && (
        <SettingsSection rowId="workflows.built-in-presets" title={t('Built-in presets')}>
          {builtins.map((preset) => (
            <SettingsRow
              key={preset.id}
              rowId={`workflows.builtin.${preset.id}`}
              label={t(preset.name)}
              description={
                <>
                  {t(preset.description)}
                  {preset.args.length > 0 && (
                    <span className="mt-0.5 block">
                      {t('Arguments')}:{' '}
                      {preset.args
                        .map((arg) => `${t(arg.label)}${arg.required ? ' *' : ''}`)
                        .join(' · ')}
                    </span>
                  )}
                </>
              }
              status={
                <Badge variant="secondary" className="shrink-0 font-mono text-[11px]">
                  {preset.id}
                </Badge>
              }
            >
              <SettingsSwitch
                checked={!disabled.includes(preset.id)}
                onCheckedChange={(checked) => toggleWorkflowPreset(preset.id, checked)}
              />
            </SettingsRow>
          ))}
        </SettingsSection>
      )}

      <WorkflowPresetDialog target={editing} onClose={() => setEditing(null)} onSaved={reload} />
    </SettingsPage>
  );
}

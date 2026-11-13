import { type DefaultModelRef, resolveChatReasoning } from '@shared/defaultModel';
import { projectDisplayName } from '@shared/projectName';
import type { ProjectGroup, ThinkingLevel } from '@shared/types';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ScopedDefaultModelField } from '@/components/chat/ScopedDefaultModelField';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

const PRESET_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#eab308',
  '#f97316',
  '#ef4444',
  '#a855f7',
  '#06b6d4',
  '#64748b',
];

interface MovableProject {
  id: string;
  name: string;
  path: string;
  alias?: string;
}

interface GroupEditorDialogProps {
  open: boolean;
  group: ProjectGroup | null;
  /** 仅新建：可勾选移入本组的项目 */
  projects?: readonly MovableProject[];
  onOpenChange: (open: boolean) => void;
  onSave: (input: {
    name: string;
    emoji?: string;
    color?: string;
    defaultModel?: DefaultModelRef | null;
    defaultReasoningEnabled?: boolean | null;
    defaultThinkingLevel?: ThinkingLevel | null;
    projectIds?: string[];
  }) => void;
  onDelete?: () => void;
}

export function GroupEditorDialog({
  open,
  group,
  projects,
  onOpenChange,
  onSave,
  onDelete,
}: GroupEditorDialogProps) {
  const { t } = useI18n();
  const defaultReasoningEnabled = useSettingsStore((state) => state.defaultReasoningEnabled);
  const defaultThinkingLevel = useSettingsStore((state) => state.defaultThinkingLevel);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | undefined>();
  const [defaultModel, setDefaultModel] = useState<DefaultModelRef | null>(null);
  const [reasoningEnabled, setReasoningEnabled] = useState(true);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [projectQuery, setProjectQuery] = useState('');
  const creating = group === null;
  const movable = creating ? (projects ?? []) : [];
  const query = projectQuery.trim().toLowerCase();
  const visibleProjects = query
    ? movable.filter((project) =>
        [project.alias ?? '', project.name].some((text) => text.toLowerCase().includes(query))
      )
    : movable;

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setColor(group?.color);
    setDefaultModel(group?.defaultModel ?? null);
    const inherited = resolveChatReasoning({
      defaultReasoningEnabled,
      defaultThinkingLevel,
    });
    setReasoningEnabled(group?.defaultReasoningEnabled ?? inherited.reasoningEnabled);
    setThinkingLevel(group?.defaultThinkingLevel ?? inherited.thinkingLevel);
    setSelectedIds(new Set());
    setProjectQuery('');
  }, [open, group, defaultReasoningEnabled, defaultThinkingLevel]);

  const toggleProject = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          className="flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            onSave({
              name: trimmed,
              color,
              defaultModel,
              defaultReasoningEnabled: defaultModel ? reasoningEnabled : null,
              defaultThinkingLevel: defaultModel ? thinkingLevel : null,
              ...(creating && selectedIds.size > 0 ? { projectIds: [...selectedIds] } : {}),
            });
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{group ? t('Edit group') : t('New group')}</DialogTitle>
            <DialogDescription>{t('Groups organize projects in the sidebar.')}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Field>
              <FieldLabel>{t('Name')}</FieldLabel>
              <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </Field>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"
                style={{
                  outline: color == null ? '2px solid var(--color-ring)' : undefined,
                  outlineOffset: 2,
                }}
                onClick={() => setColor(undefined)}
                aria-label={t('No color')}
              >
                <X className="h-3 w-3" />
              </button>
              {PRESET_COLORS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="h-6 w-6 rounded-full border border-border"
                  style={{
                    backgroundColor: preset,
                    outline: color === preset ? '2px solid var(--color-ring)' : undefined,
                    outlineOffset: 2,
                  }}
                  onClick={() => setColor(color === preset ? undefined : preset)}
                  aria-label={preset}
                />
              ))}
            </div>
            <ScopedDefaultModelField
              value={defaultModel}
              reasoningEnabled={reasoningEnabled}
              thinkingLevel={thinkingLevel}
              onChange={(model) => {
                setDefaultModel(model);
                if (model) return;
                const inherited = resolveChatReasoning({
                  defaultReasoningEnabled,
                  defaultThinkingLevel,
                });
                setReasoningEnabled(inherited.reasoningEnabled);
                setThinkingLevel(inherited.thinkingLevel);
              }}
              onReasoningChange={setReasoningEnabled}
              onThinkingChange={setThinkingLevel}
              description={t('Used for new conversations in this group.')}
              inheritLabel={t('Follows the global default')}
            />
            {movable.length > 0 && (
              <Field className="w-full items-stretch">
                <FieldLabel>{t('Move projects into this group')}</FieldLabel>
                <Input
                  value={projectQuery}
                  onChange={(event) => setProjectQuery(event.target.value)}
                  placeholder={t('Filter projects...')}
                />
                <div className="max-h-48 w-full space-y-0.5 overflow-y-auto rounded-md border p-1.5">
                  {visibleProjects.map((project) => (
                    <label
                      key={project.id}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
                    >
                      <Checkbox
                        checked={selectedIds.has(project.id)}
                        onCheckedChange={() => toggleProject(project.id)}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {projectDisplayName(project)}
                      </span>
                    </label>
                  ))}
                  {visibleProjects.length === 0 && (
                    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                      {t('No matching projects found')}
                    </p>
                  )}
                </div>
              </Field>
            )}
          </DialogPanel>
          <DialogFooter className={group ? 'sm:justify-between' : undefined}>
            {group && onDelete ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive"
                onClick={() => {
                  onDelete();
                  onOpenChange(false);
                }}
              >
                {t('Delete group')}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={!name.trim()}>
                {t('Save')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

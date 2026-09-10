import { type DefaultModelRef, resolveChatReasoning } from '@shared/defaultModel';
import { projectDisplayName } from '@shared/projectName';
import type { Project, ThinkingLevel } from '@shared/types';
import { useEffect, useMemo, useState } from 'react';
import { ScopedDefaultModelField } from '@/components/chat/ScopedDefaultModelField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { useSettingsStore } from '@/stores/settings';

export function ProjectSettingsDialog({
  open,
  project,
  onOpenChange,
}: {
  open: boolean;
  project: Project | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const groups = useSettingsStore((state) => state.projectGroups);
  const defaultReasoningEnabled = useSettingsStore((state) => state.defaultReasoningEnabled);
  const defaultThinkingLevel = useSettingsStore((state) => state.defaultThinkingLevel);
  const setProjectDefaultModel = useSettingsStore((state) => state.setProjectDefaultModel);
  const setProjectGroupId = useSettingsStore((state) => state.setProjectGroupId);
  const setProjectAlias = useSettingsStore((state) => state.setProjectAlias);
  const [alias, setAlias] = useState('');
  const [defaultModel, setDefaultModel] = useState<DefaultModelRef | null>(null);
  const [reasoningEnabled, setReasoningEnabled] = useState(true);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium');
  const [groupId, setGroupId] = useState('');

  useEffect(() => {
    if (!open) return;
    setDefaultModel(project?.defaultModel ?? null);
    setGroupId(project?.groupId ?? '');
    setAlias(project?.alias ?? '');
    const group = project?.groupId
      ? groups.find((entry) => entry.id === project.groupId)
      : undefined;
    const inherited = resolveChatReasoning({
      groupReasoningEnabled: group?.defaultReasoningEnabled,
      groupThinkingLevel: group?.defaultThinkingLevel,
      defaultReasoningEnabled,
      defaultThinkingLevel,
    });
    setReasoningEnabled(project?.defaultReasoningEnabled ?? inherited.reasoningEnabled);
    setThinkingLevel(project?.defaultThinkingLevel ?? inherited.thinkingLevel);
  }, [open, project, groups, defaultReasoningEnabled, defaultThinkingLevel]);

  const groupItems = useMemo(
    () => [
      { value: '', label: t('Ungrouped') },
      ...groups
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((group) => ({ value: group.id, label: group.name })),
    ],
    [groups, t]
  );
  const pathLabel =
    project?.kind === 'ssh'
      ? `${project.sshConnectionName ?? project.sshHost}:${project.path}`
      : (project?.path ?? '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          className="flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!project) return;
            setProjectDefaultModel(
              project.id,
              defaultModel,
              defaultModel ? { reasoningEnabled, thinkingLevel } : null
            );
            setProjectGroupId(project.id, groupId || null);
            setProjectAlias(project.id, alias);
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('Project settings')}</DialogTitle>
            <DialogDescription>
              {project ? projectDisplayName(project) : t('Project')}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <Field className="w-full items-stretch">
              <FieldLabel>{t('Alias')}</FieldLabel>
              <Input
                value={alias}
                onChange={(event) => setAlias(event.target.value)}
                placeholder={project ? projectDisplayName({ ...project, alias: undefined }) : ''}
              />
              <FieldDescription>
                {t('Shown in the sidebar instead of the folder name. Leave blank to reset.')}
              </FieldDescription>
            </Field>
            <Field className="w-full items-stretch">
              <FieldLabel>{t('Path')}</FieldLabel>
              <p className="truncate font-mono text-muted-foreground text-xs" title={pathLabel}>
                {pathLabel}
              </p>
            </Field>
            {groups.length > 0 && (
              <Field className="w-full items-stretch">
                <FieldLabel>{t('Project group')}</FieldLabel>
                <Select
                  items={groupItems}
                  value={groupId}
                  onValueChange={(value) => setGroupId(value ?? '')}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                    {groupItems.map((item) => (
                      <SelectItem key={item.value || 'ungrouped'} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            )}
            <ScopedDefaultModelField
              value={defaultModel}
              reasoningEnabled={reasoningEnabled}
              thinkingLevel={thinkingLevel}
              onChange={(model) => {
                setDefaultModel(model);
                if (model) return;
                const group = groupId ? groups.find((entry) => entry.id === groupId) : undefined;
                const inherited = resolveChatReasoning({
                  groupReasoningEnabled: group?.defaultReasoningEnabled,
                  groupThinkingLevel: group?.defaultThinkingLevel,
                  defaultReasoningEnabled,
                  defaultThinkingLevel,
                });
                setReasoningEnabled(inherited.reasoningEnabled);
                setThinkingLevel(inherited.thinkingLevel);
              }}
              onReasoningChange={setReasoningEnabled}
              onThinkingChange={setThinkingLevel}
              description={t('Used for new conversations in this project.')}
              inheritLabel={t('Follows group, then global default')}
            />
            <p className="text-muted-foreground text-xs">
              {t('Session choice overrides the project default.')}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!project}>
              {t('Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

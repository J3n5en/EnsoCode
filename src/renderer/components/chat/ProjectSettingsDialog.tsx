import { type DefaultModelRef, resolveChatReasoning } from '@shared/defaultModel';
import { projectDisplayName } from '@shared/projectName';
import type { Project, ThinkingLevel } from '@shared/types';
import type { AgentMode } from '@shared/types/agent';
import { BUILTIN_TOOLS } from '@shared/types/builtinTools';
import { FolderOpen, ShieldAlert, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CopyButton } from '@/components/chat/CopyButton';
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
import { Switch } from '@/components/ui/switch';
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
  const setProjectDisabledBuiltinTools = useSettingsStore(
    (state) => state.setProjectDisabledBuiltinTools
  );
  const setProjectSubagentAllowedModes = useSettingsStore(
    (state) => state.setProjectSubagentAllowedModes
  );
  const setProjectTrustedCode = useSettingsStore((state) => state.setProjectTrustedCode);
  const globalDisabledBuiltinTools = useSettingsStore((state) => state.disabledBuiltinTools);
  const globalSubagentAllowedModes = useSettingsStore((state) => state.subagentAllowedModes);
  const [alias, setAlias] = useState('');
  const [defaultModel, setDefaultModel] = useState<DefaultModelRef | null>(null);
  const [reasoningEnabled, setReasoningEnabled] = useState(true);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium');
  const [groupId, setGroupId] = useState('');
  const [followGlobalTools, setFollowGlobalTools] = useState(true);
  const [disabledBuiltinTools, setDisabledBuiltinTools] = useState<string[]>([]);
  const [followGlobalSubagentModes, setFollowGlobalSubagentModes] = useState(true);
  const [subagentAllowedModes, setSubagentAllowedModes] = useState<AgentMode[]>([]);
  const [revokeTrust, setRevokeTrust] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRevokeTrust(false);
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
    const follow = project?.disabledBuiltinTools === undefined;
    setFollowGlobalTools(follow);
    setDisabledBuiltinTools(
      follow ? [...globalDisabledBuiltinTools] : [...(project?.disabledBuiltinTools ?? [])]
    );
    const followModes = project?.subagentAllowedModes === undefined;
    setFollowGlobalSubagentModes(followModes);
    setSubagentAllowedModes(
      followModes ? [...globalSubagentAllowedModes] : [...(project?.subagentAllowedModes ?? [])]
    );
  }, [
    open,
    project,
    groups,
    defaultReasoningEnabled,
    defaultThinkingLevel,
    globalDisabledBuiltinTools,
    globalSubagentAllowedModes,
  ]);

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
      <DialogContent className="max-w-lg">
        <form
          className="contents"
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
            setProjectDisabledBuiltinTools(
              project.id,
              followGlobalTools ? null : disabledBuiltinTools
            );
            setProjectSubagentAllowedModes(
              project.id,
              followGlobalSubagentModes ? null : subagentAllowedModes
            );
            if (revokeTrust) setProjectTrustedCode(project.id, null);
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('Project settings')}</DialogTitle>
            <DialogDescription>
              {project ? projectDisplayName(project) : t('Project')}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[60vh] space-y-4">
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
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <p className="min-w-0 flex-1 truncate font-mono text-xs" title={pathLabel}>
                  {pathLabel}
                </p>
                <CopyButton text={pathLabel} className="shrink-0" />
                {/* ssh 项目路径在远端，本机打不开 */}
                {project && project.kind !== 'ssh' && (
                  <button
                    type="button"
                    onClick={() =>
                      void window.electronAPI.projects.reveal({ projectId: project.id })
                    }
                    className="shrink-0 transition-colors hover:text-foreground"
                    title={t('Open folder')}
                  >
                    <FolderOpen className="h-3 w-3" />
                  </button>
                )}
              </div>
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
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium text-sm">{t('Follow global built-in tools')}</p>
                  <p className="text-muted-foreground text-xs">
                    {t(
                      'When off, configure built-in tools for this project. They override the global setting on the next session.'
                    )}
                  </p>
                </div>
                <Switch checked={followGlobalTools} onCheckedChange={setFollowGlobalTools} />
              </div>
              {!followGlobalTools && (
                <div className="space-y-2">
                  {BUILTIN_TOOLS.map((tool) => (
                    <div
                      key={tool.id}
                      className="flex items-center gap-3 rounded-md border px-3 py-2.5"
                    >
                      <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{t(tool.name)}</p>
                        <p className="text-muted-foreground text-xs">{t(tool.description)}</p>
                      </div>
                      <Switch
                        checked={!disabledBuiltinTools.includes(tool.id)}
                        onCheckedChange={(checked) =>
                          setDisabledBuiltinTools((list) =>
                            checked
                              ? list.filter((id) => id !== tool.id)
                              : [...new Set([...list, tool.id])]
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium text-sm">{t('Follow global unified agent modes')}</p>
                  <p className="text-muted-foreground text-xs">
                    {t('When off, this project uses its own explicit Agent mode permission mask.')}
                  </p>
                </div>
                <Switch
                  checked={followGlobalSubagentModes}
                  onCheckedChange={(checked) => {
                    setFollowGlobalSubagentModes(checked);
                    if (!checked) setSubagentAllowedModes([...globalSubagentAllowedModes]);
                  }}
                />
              </div>
              {!followGlobalSubagentModes && (
                <div className="space-y-2 rounded-lg border px-3 py-2.5">
                  {(
                    [
                      ['task', 'One-shot task agents'],
                      ['coworker', 'Persistent coworkers'],
                    ] as const
                  ).map(([mode, label]) => (
                    <div key={mode} className="flex items-center justify-between gap-4">
                      <span className="text-sm">{t(label)}</span>
                      <Switch
                        checked={subagentAllowedModes.includes(mode)}
                        disabled={(followGlobalTools
                          ? globalDisabledBuiltinTools
                          : disabledBuiltinTools
                        ).includes('subagent')}
                        onCheckedChange={(checked) =>
                          setSubagentAllowedModes((modes) =>
                            checked
                              ? [...new Set([...modes, mode])]
                              : modes.filter((item) => item !== mode)
                          )
                        }
                      />
                    </div>
                  ))}
                  {(followGlobalTools ? globalDisabledBuiltinTools : disabledBuiltinTools).includes(
                    'subagent'
                  ) && (
                    <p className="text-muted-foreground text-xs">
                      {t(
                        'The unified subagent tool is off. Re-enabling it keeps this mode selection.'
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
            {project?.trustedProjectCode?.length ? (
              <div className="flex items-start gap-3 rounded-lg border px-3 py-2.5">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{t('Trusted project extensions')}</p>
                  <p
                    className="truncate font-mono text-muted-foreground text-xs"
                    title={project.trustedProjectCode.join('\n')}
                  >
                    {project.trustedProjectCode.join(', ')}
                  </p>
                  {revokeTrust && (
                    <p className="text-muted-foreground text-xs">
                      {t('No longer loaded after saving, starting with the next session.')}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={revokeTrust}
                  onClick={() => setRevokeTrust(true)}
                >
                  {t('Revoke trust')}
                </Button>
              </div>
            ) : null}
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

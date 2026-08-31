import type { RecentProject } from '@shared/types';
import * as React from 'react';
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from '@/components/ui/autocomplete';
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
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { useSettingsStore } from '@/stores/settings';

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (request: { path: string; sshConnectionId?: string }) => void;
}

export function AddProjectDialog({ open, onOpenChange, onAdd }: AddProjectDialogProps) {
  const { t } = useI18n();
  const projects = useSettingsStore((state) => state.projects);
  const [mode, setMode] = React.useState<'local' | 'ssh'>('local');
  const [pathValue, setPathValue] = React.useState('');
  const [sshConnectionId, setSshConnectionId] = React.useState('');
  const [sshPath, setSshPath] = React.useState('');
  const [connections, setConnections] = React.useState<
    Awaited<ReturnType<typeof window.electronAPI.sshConnections.list>>
  >([]);
  const [recent, setRecent] = React.useState<RecentProject[]>([]);

  React.useEffect(() => {
    if (!open) return;
    setMode('local');
    setPathValue('');
    setSshConnectionId('');
    setSshPath('');
    window.electronAPI.sshConnections
      .list()
      .then(setConnections)
      .catch(() => setConnections([]));
    window.electronAPI.projects
      .getRecent()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, [open]);

  const existing = React.useMemo(
    () => new Set(projects.map((project) => project.path)),
    [projects]
  );
  const items = React.useMemo(
    () => recent.filter((project) => !existing.has(project.path)),
    [recent, existing]
  );

  const filterProject = React.useCallback((project: RecentProject, query: string) => {
    if (!query) return true;
    const needle = query.toLowerCase();
    return (
      project.path.toLowerCase().includes(needle) ||
      project.displayPath.toLowerCase().includes(needle) ||
      project.sourceName.toLowerCase().includes(needle)
    );
  }, []);

  const handleBrowse = async () => {
    const selected = await window.electronAPI.dialog.selectDirectory();
    if (selected) setPathValue(selected);
  };

  const canSubmit =
    mode === 'local'
      ? pathValue.trim().length > 0
      : sshConnectionId.length > 0 && sshPath.trim().startsWith('/');

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (mode === 'ssh') {
      onAdd({ path: sshPath.trim(), sshConnectionId });
    } else {
      onAdd({ path: pathValue.trim() });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={handleSubmit} className="flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('Add project')}</DialogTitle>
            <DialogDescription>
              {t('Add a local directory as the conversation working folder.')}
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="space-y-4">
            <Tabs value={mode} onValueChange={(value) => setMode(value as 'local' | 'ssh')}>
              <TabsList>
                <TabsTab value="local">{t('Local directory')}</TabsTab>
                <TabsTab value="ssh">{t('Remote (SSH)')}</TabsTab>
              </TabsList>
            </Tabs>
            {mode === 'ssh' ? (
              <>
                <Field className="w-full">
                  <FieldLabel>{t('SSH connection')}</FieldLabel>
                  {connections.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('Add an SSH connection in Settings first.')}
                    </p>
                  ) : (
                    <select
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={sshConnectionId}
                      onChange={(event) => setSshConnectionId(event.target.value)}
                    >
                      <option value="">{t('Select an SSH connection')}</option>
                      {connections.map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.name} ({connection.user ? `${connection.user}@` : ''}
                          {connection.host})
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field className="w-full">
                  <FieldLabel>{t('Remote directory')}</FieldLabel>
                  <Input
                    value={sshPath}
                    onChange={(event) => setSshPath(event.target.value)}
                    placeholder="/home/user/project"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  {t('Tools run on the remote host; chat history stays local.')}
                </p>
              </>
            ) : (
              <Field className="w-full">
                <FieldLabel>{t('Working directory')}</FieldLabel>
                <Autocomplete
                  value={pathValue}
                  onValueChange={(value) => setPathValue(value ?? '')}
                  items={items}
                  filter={filterProject}
                  itemToStringValue={(item) => item.path}
                >
                  <div className="flex w-full gap-2">
                    <div className="min-w-0 flex-1">
                      <AutocompleteInput
                        placeholder={t('Type a path or select from recent projects...')}
                        showClear={!!pathValue}
                        showTrigger
                      />
                    </div>
                    <Button type="button" variant="outline" onClick={() => void handleBrowse()}>
                      {t('Browse')}
                    </Button>
                  </div>
                  <AutocompletePopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                    <AutocompleteEmpty>{t('No matching projects found')}</AutocompleteEmpty>
                    <AutocompleteList>
                      {(project: RecentProject) => (
                        <AutocompleteItem key={project.path} value={project} className="gap-2">
                          <span className="min-w-0 flex-1 truncate" title={project.path}>
                            {project.displayPath}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {project.sourceName}
                          </span>
                        </AutocompleteItem>
                      )}
                    </AutocompleteList>
                  </AutocompletePopup>
                </Autocomplete>
              </Field>
            )}
          </DialogPanel>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {t('Add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

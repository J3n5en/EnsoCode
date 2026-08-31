import type { RecentProject } from '@shared/types';
import { Loader2 } from 'lucide-react';
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

/** 内嵌远程目录浏览：逐级钻取，选中回填路径输入框（避免嵌套 Dialog） */
function RemoteDirBrowser({
  connectionId,
  initialPath,
  onSelect,
  onClose,
}: {
  connectionId: string;
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [path, setPath] = React.useState<string | null>(null);
  const [dirs, setDirs] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const requestSeq = React.useRef(0);

  const load = React.useCallback(
    (target?: string) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError('');
      window.electronAPI.sshConnections
        .listDirs(connectionId, target)
        .then((result) => {
          if (seq !== requestSeq.current) return;
          if (result.ok) {
            setPath(result.path);
            setDirs(result.dirs);
          } else {
            setError(result.error);
          }
        })
        .catch(() => {
          if (seq === requestSeq.current) setError(t('Failed to list remote directory.'));
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    },
    [connectionId, t]
  );

  // 仅挂载/切换连接时以当前输入为起点；后续导航由 load 驱动，不跟随输入框变化
  const initialRef = React.useRef(initialPath);
  React.useEffect(() => {
    const initial = initialRef.current;
    load(initial?.startsWith('/') ? initial : undefined);
  }, [load]);

  const parent = path && path !== '/' ? path.replace(/\/[^/]+$/, '') || '/' : null;

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
          {path ?? '…'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={!parent || loading}
          onClick={() => parent && load(parent)}
        >
          {t('Up')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onClose}
        >
          {t('Close')}
        </Button>
      </div>
      <div className="relative min-h-16 max-h-40 overflow-y-auto">
        {error ? (
          <p className="px-1 py-2 text-destructive text-xs">{error}</p>
        ) : dirs.length === 0 && !loading ? (
          <p className="px-1 py-2 text-muted-foreground text-xs">{t('No subdirectories')}</p>
        ) : (
          <div className={loading ? 'pointer-events-none space-y-0.5 opacity-40' : 'space-y-0.5'}>
            {dirs.map((dir) => (
              <button
                key={dir}
                type="button"
                className="block w-full truncate rounded px-1.5 py-1 text-left font-mono text-xs hover:bg-muted"
                disabled={loading}
                onClick={() => path && load(path === '/' ? `/${dir}` : `${path}/${dir}`)}
              >
                {dir}/
              </button>
            ))}
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="sr-only">{t('Loading...')}</span>
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 w-full text-xs"
        disabled={!path || loading}
        onClick={() => path && onSelect(path)}
      >
        {t('Use this directory')}
      </Button>
    </div>
  );
}

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (request: { path: string; sshConnectionId?: string; sshHost?: string }) => void;
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
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const [recent, setRecent] = React.useState<RecentProject[]>([]);

  React.useEffect(() => {
    if (!open) return;
    setMode('local');
    setPathValue('');
    setSshConnectionId('');
    setSshPath('');
    setBrowserOpen(false);
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
      const connection = connections.find((item) => item.id === sshConnectionId);
      onAdd({
        path: sshPath.trim(),
        sshConnectionId,
        sshHost: connection?.name,
      });
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
                  <div className="flex w-full gap-2">
                    <Input
                      value={sshPath}
                      onChange={(event) => setSshPath(event.target.value)}
                      placeholder="/home/user/project"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      className="min-w-0 flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!sshConnectionId}
                      onClick={() => setBrowserOpen((open) => !open)}
                    >
                      {t('Browse')}
                    </Button>
                  </div>
                </Field>
                {browserOpen && sshConnectionId && (
                  <RemoteDirBrowser
                    connectionId={sshConnectionId}
                    initialPath={sshPath.trim() || undefined}
                    onSelect={(selected) => {
                      setSshPath(selected);
                      setBrowserOpen(false);
                    }}
                    onClose={() => setBrowserOpen(false)}
                  />
                )}
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

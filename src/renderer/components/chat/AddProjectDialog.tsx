import type { ProjectGroup, RecentProject, SshHostKeyChallenge } from '@shared/types';
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { hostKeyFromSshFailure, SshHostKeyDialog } from '@/components/chat/SshHostKeyDialog';
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { useSettingsStore } from '@/stores/settings';

export type DirPage = { path: string; parent: string | null; dirs: string[] };

/** 拿不到列表时：error 显示在浏览器里，null 表示已另行处理（如弹出主机指纹确认） */
export type ListDirs = (
  target: string | undefined,
  retry: boolean
) => Promise<DirPage | { error: string } | null>;

export type CreateDir = (parent: string, name: string) => Promise<DirPage | { error: string }>;

const posixParent = (dir: string) => (dir === '/' ? null : dir.replace(/\/[^/]+$/, '') || '/');

function childPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** 内嵌目录浏览：逐级钻取，选中回填路径输入框（避免嵌套 Dialog）；reloadKey 变化时以 retry 重载当前目录 */
export function DirBrowser({
  list,
  create,
  initialPath,
  reloadKey = 0,
  onSelect,
  onClose,
}: {
  list: ListDirs;
  /** 提供时显示“新建文件夹”，建好后直接进入新目录 */
  create?: CreateDir;
  initialPath?: string;
  reloadKey?: number;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [page, setPage] = React.useState<DirPage | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [newName, setNewName] = React.useState<string | null>(null);
  const [createError, setCreateError] = React.useState('');
  const requestSeq = React.useRef(0);
  const pathRef = React.useRef<string | null>(null);
  const listRef = React.useRef(list);
  listRef.current = list;

  const load = React.useCallback(
    (target?: string, retry = false) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError('');
      listRef
        .current(target, retry)
        .then((result) => {
          if (seq !== requestSeq.current || !result) return;
          if ('error' in result) {
            setError(result.error);
            return;
          }
          setPage(result);
          pathRef.current = result.path;
        })
        .catch(() => {
          if (seq === requestSeq.current) setError(t('Failed to list remote directory.'));
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    },
    [t]
  );

  // 仅挂载时以当前输入为起点；后续导航由 load 驱动，不跟随输入框变化
  const initialRef = React.useRef(initialPath);
  React.useEffect(() => {
    load(initialRef.current);
  }, [load]);

  React.useEffect(() => {
    if (reloadKey) load(pathRef.current ?? initialRef.current, true);
  }, [reloadKey, load]);

  const path = page?.path ?? null;
  const dirs = page?.dirs ?? [];
  const parent = page?.parent ?? null;

  const submitNewFolder = () => {
    if (!create || !path || newName === null || !newName.trim()) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setCreateError('');
    create(path, newName)
      .then((result) => {
        if (seq !== requestSeq.current) return;
        if ('error' in result) {
          setCreateError(t(result.error));
          return;
        }
        setNewName(null);
        setError('');
        setPage(result);
        pathRef.current = result.path;
      })
      .catch(() => {
        if (seq === requestSeq.current) setCreateError(t('Failed to list remote directory.'));
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  };

  return (
    <div className="w-full space-y-1.5 rounded-md border bg-muted/30 p-2">
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
        {create && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!path || loading || newName !== null}
            onClick={() => {
              setNewName('');
              setCreateError('');
            }}
          >
            {t('New Folder')}
          </Button>
        )}
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
      {newName !== null && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Input
              autoFocus
              size="sm"
              className="min-w-0 flex-1 font-mono text-xs"
              placeholder={t('Folder name')}
              value={newName}
              disabled={loading}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  // 输入法组字中的回车只是确认候选词
                  if (event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  submitNewFolder();
                } else if (event.key === 'Escape') {
                  // 只收起输入框，不关整个对话框
                  event.preventDefault();
                  event.stopPropagation();
                  setNewName(null);
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={loading || !newName.trim()}
              onClick={submitNewFolder}
            >
              {t('Create')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={loading}
              onClick={() => setNewName(null)}
            >
              {t('Cancel')}
            </Button>
          </div>
          {createError && <p className="px-1 text-destructive text-xs">{createError}</p>}
        </div>
      )}
      <div className="relative min-h-16 max-h-56 overflow-y-auto">
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
                onClick={() => path && load(childPath(path, dir))}
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
  onAdd: (request: {
    path: string;
    sshConnectionId?: string;
    sshHost?: string;
    groupId?: string;
  }) => void;
  groups?: readonly ProjectGroup[];
  defaultGroupId?: string;
}

export function AddProjectDialog({
  open,
  onOpenChange,
  onAdd,
  groups = [],
  defaultGroupId,
}: AddProjectDialogProps) {
  const { t } = useI18n();
  const projects = useSettingsStore((state) => state.projects);
  const [mode, setMode] = React.useState<'local' | 'ssh'>('local');
  const [pathValue, setPathValue] = React.useState('');
  const [sshConnectionId, setSshConnectionId] = React.useState('');
  const [sshPath, setSshPath] = React.useState('');
  const [connections, setConnections] = React.useState<
    Awaited<ReturnType<typeof window.electronAPI.sshConnections.list>>
  >([]);
  const [groupId, setGroupId] = React.useState<string | undefined>(defaultGroupId);
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const [recent, setRecent] = React.useState<RecentProject[]>([]);
  const [formError, setFormError] = React.useState('');
  const [hostKey, setHostKey] = React.useState<SshHostKeyChallenge | null>(null);
  const [afterTrust, setAfterTrust] = React.useState<'submit' | 'browse' | null>(null);
  const [hostKeyRetry, setHostKeyRetry] = React.useState(0);
  const [trusting, setTrusting] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  // 递增即作废进行中的连接测试：关闭或重开弹窗后，迟到的成功结果不能再添加项目
  const submitSeq = React.useRef(0);
  const groupItems = React.useMemo(
    () => [
      { value: '', label: t('Ungrouped') },
      ...groups.map((group) => ({ value: group.id, label: group.name })),
    ],
    [groups, t]
  );

  React.useEffect(() => {
    submitSeq.current += 1;
    setSubmitting(false);
    if (!open) return;
    setMode('local');
    setPathValue('');
    setSshConnectionId('');
    setSshPath('');
    setGroupId(defaultGroupId);
    setBrowserOpen(false);
    setFormError('');
    setHostKey(null);
    setAfterTrust(null);
    setHostKeyRetry(0);
    window.electronAPI.sshConnections
      .list()
      .then(setConnections)
      .catch(() => setConnections([]));
    window.electronAPI.projects
      .getRecent()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, [open, defaultGroupId]);

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

  // 远端客户端没有系统目录选择框：在对话框内浏览宿主机目录
  const hostBrowse = Boolean(window.electronAPI.remote);

  const handleBrowse = async () => {
    if (hostBrowse) {
      setBrowserOpen((value) => !value);
      return;
    }
    const selected = await window.electronAPI.dialog.selectDirectory();
    if (selected) setPathValue(selected);
  };

  const listHostDirs = React.useCallback<ListDirs>(
    (target) =>
      window.electronAPI.projects
        .listHostDirs(target)
        .then((result) => (result.ok ? result : { error: result.error })),
    []
  );

  const createHostDir = React.useCallback<CreateDir>(
    (parent, name) =>
      window.electronAPI.projects
        .createHostDir(parent, name)
        .then((result) => (result.ok ? result : { error: result.error })),
    []
  );

  const listSshDirs = React.useCallback<ListDirs>(
    async (target, retry) => {
      const result = await window.electronAPI.sshConnections.listDirs(sshConnectionId, target);
      if (result.ok)
        return { path: result.path, parent: posixParent(result.path), dirs: result.dirs };
      const challenge = hostKeyFromSshFailure(
        result,
        connections.find((item) => item.id === sshConnectionId)
      );
      if (!challenge || retry) return { error: result.error };
      setAfterTrust('browse');
      setHostKey(challenge);
      return null;
    },
    [sshConnectionId, connections]
  );

  const canSubmit =
    mode === 'local'
      ? pathValue.trim().length > 0
      : sshConnectionId.length > 0 && sshPath.trim().startsWith('/');

  const submitSsh = () => {
    const connection = connections.find((item) => item.id === sshConnectionId);
    onAdd({
      path: sshPath.trim(),
      sshConnectionId,
      sshHost: connection?.name,
      ...(groupId ? { groupId } : {}),
    });
    onOpenChange(false);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (mode !== 'ssh') {
      onAdd({ path: pathValue.trim(), ...(groupId ? { groupId } : {}) });
      onOpenChange(false);
      return;
    }
    // 测试连接要等网络往返，期间连点或回车不能重复添加
    if (submitting) return;
    setSubmitting(true);
    setFormError('');
    const seq = ++submitSeq.current;
    const connection = connections.find((item) => item.id === sshConnectionId);
    void window.electronAPI.sshConnections
      .test(sshConnectionId)
      .then((result) => {
        if (seq !== submitSeq.current) return;
        if (!result.ok) {
          const challenge = hostKeyFromSshFailure(result, connection);
          if (challenge) {
            setAfterTrust('submit');
            setHostKey(challenge);
            return;
          }
          setFormError(result.error);
          return;
        }
        submitSsh();
      })
      .finally(() => {
        if (seq === submitSeq.current) setSubmitting(false);
      });
  };

  const trustHost = async () => {
    if (!hostKey) return;
    setTrusting(true);
    const trusted = await window.electronAPI.sshConnections.trustHost(sshConnectionId);
    setTrusting(false);
    if (!trusted.ok) {
      setFormError(trusted.error || t('Could not save host key.'));
      setHostKey(null);
      setAfterTrust(null);
      return;
    }
    const resume = afterTrust;
    setHostKey(null);
    setAfterTrust(null);
    if (resume === 'browse') {
      setHostKeyRetry((value) => value + 1);
      return;
    }
    if (resume === 'submit') submitSsh();
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
            <Tabs
              value={mode}
              onValueChange={(value) => {
                setMode(value as 'local' | 'ssh');
                setBrowserOpen(false);
              }}
            >
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
                    <Select
                      items={[
                        { value: '', label: t('Select an SSH connection') },
                        ...connections.map((connection) => ({
                          value: connection.id,
                          label: `${connection.name} (${connection.user ? `${connection.user}@` : ''}${connection.host})`,
                        })),
                      ]}
                      value={sshConnectionId}
                      onValueChange={(value) => setSshConnectionId(value ?? '')}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                        <SelectItem value="">{t('Select an SSH connection')}</SelectItem>
                        {connections.map((connection) => (
                          <SelectItem key={connection.id} value={connection.id}>
                            {connection.name} ({connection.user ? `${connection.user}@` : ''}
                            {connection.host})
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
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
                  <DirBrowser
                    key={sshConnectionId}
                    list={listSshDirs}
                    initialPath={sshPath.trim().startsWith('/') ? sshPath.trim() : undefined}
                    reloadKey={hostKeyRetry}
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
                {formError && <p className="text-destructive text-xs">{formError}</p>}
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
                {browserOpen && hostBrowse && (
                  <DirBrowser
                    list={listHostDirs}
                    create={createHostDir}
                    initialPath={pathValue.trim() || undefined}
                    onSelect={(selected) => {
                      setPathValue(selected);
                      setBrowserOpen(false);
                    }}
                    onClose={() => setBrowserOpen(false)}
                  />
                )}
              </Field>
            )}
            {groups.length > 0 && (
              <Field>
                <FieldLabel>{t('Project group')}</FieldLabel>
                <Select
                  items={groupItems}
                  value={groupId ?? ''}
                  onValueChange={(value) => setGroupId(value || undefined)}
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
          </DialogPanel>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit || submitting}>
              {t('Add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      <SshHostKeyDialog
        challenge={hostKey}
        nested
        busy={trusting}
        onTrust={() => void trustHost()}
        onDismiss={() => {
          if (trusting) return;
          setHostKey(null);
          setAfterTrust(null);
        }}
      />
    </Dialog>
  );
}

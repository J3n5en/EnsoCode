import type { ProjectGroup, RecentProject, SshHostKeyChallenge } from '@shared/types';
import { Folder, Loader2 } from 'lucide-react';
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

/** 空、`.`、`..`、斜杠或控制字符都不能当文件夹名。返回 i18n 键。 */
export function validateNewFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return 'Enter a folder name';
  const hasControl = [...trimmed].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (/[\\/]/.test(trimmed) || hasControl) {
    return 'Folder name cannot contain slashes or control characters.';
  }
  return null;
}

function joinDirectoryPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  const base = parent.replace(/[\\/]+$/, '');
  return `${base || parent}${sep}${name}`;
}

function normalizeParent(parent: string): string {
  const trimmed = parent.trim();
  if (!trimmed) return '';
  return trimmed.replace(/[\\/]+$/, '') || trimmed;
}

/** 克隆落盘目录名：取 url 末段并去掉 `.git`。`git@host:owner/repo.git` 取冒号后的路径。 */
export function cloneFolderName(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const scp = /^[^/\s]+@[^/\s:]+:(.+)$/.exec(trimmed);
  const segment = (scp?.[1] ?? trimmed).split(/[\\/]/).pop() ?? '';
  return segment.replace(/\.git$/i, '');
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

function ParentLocation({
  parentDir,
  destination,
  onParentDirChange,
  onBrowse,
}: {
  parentDir: string;
  destination: string;
  onParentDirChange: (value: string) => void;
  onBrowse: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Field className="w-full">
        <FieldLabel>{t('Location')}</FieldLabel>
        <div className="flex w-full gap-2">
          <Input
            value={parentDir}
            size="sm"
            className="min-w-0 flex-1 font-mono text-xs"
            placeholder={t('Parent directory')}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => onParentDirChange(event.target.value)}
          />
          <Button type="button" variant="outline" size="sm" onClick={onBrowse}>
            {t('Browse')}
          </Button>
        </div>
      </Field>
      {destination ? (
        <p className="truncate font-mono text-muted-foreground text-xs">{destination}</p>
      ) : null}
    </>
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

/** 本机目录搜索：debounce 后查家目录，点选回填路径。仅 local tab 使用。 */
function DirSearch({ onSelect }: { onSelect: (path: string) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [host, setHost] = React.useState('');
  const [results, setResults] = React.useState<{ path: string; displayPath: string }[]>([]);
  const [pending, setPending] = React.useState(false);
  const [settled, setSettled] = React.useState(false);
  const seq = React.useRef(0);

  React.useEffect(() => {
    const trimmed = query.trim();
    const id = ++seq.current;
    if (!trimmed) {
      setPending(false);
      setSettled(false);
      setResults([]);
      return;
    }
    setPending(true);
    setSettled(false);
    setResults([]);
    const timer = setTimeout(() => {
      void window.electronAPI.projects
        .searchHostDirs(trimmed)
        .then((result) => {
          if (id !== seq.current) return;
          if (result.ok) {
            setHost(result.host);
            setResults(result.results);
          } else {
            setResults([]);
          }
          setSettled(true);
        })
        .catch(() => {
          if (id !== seq.current) return;
          setResults([]);
          setSettled(true);
        })
        .finally(() => {
          if (id === seq.current) setPending(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  React.useEffect(
    () => () => {
      seq.current += 1;
    },
    []
  );

  const trimmed = query.trim();
  return (
    <div className="space-y-1.5">
      <Input
        value={query}
        size="sm"
        className="font-mono text-xs"
        placeholder={t('Search for directory')}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
      />
      {host && trimmed ? (
        <p className="text-muted-foreground text-xs">
          {t('Find a directory on {{host}}', { host })}
        </p>
      ) : null}
      {pending ? (
        <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('Searching...')}
        </p>
      ) : null}
      {settled && results.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('No matching directories')}</p>
      ) : null}
      {settled && results.length > 0 ? (
        <div className="max-h-40 overflow-auto rounded-md border bg-muted/30">
          {results.map((result) => (
            <button
              key={result.path}
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-xs hover:bg-muted"
              onClick={() => {
                onSelect(result.path);
                setQuery('');
              }}
            >
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={result.path}>
                {result.displayPath}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
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
  const [localMethod, setLocalMethod] = React.useState<'existing' | 'clone' | 'new-folder'>(
    'existing'
  );
  const [pathValue, setPathValue] = React.useState('');
  const [parentDir, setParentDir] = React.useState('');
  const [folderName, setFolderName] = React.useState('');
  const [repoUrl, setRepoUrl] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [browseTarget, setBrowseTarget] = React.useState<'path' | 'parent'>('path');
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
    setLocalMethod('existing');
    setPathValue('');
    setParentDir('');
    setFolderName('');
    setRepoUrl('');
    setActionError('');
    setBrowseTarget('path');
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

  const handleBrowse = async (target: 'path' | 'parent') => {
    if (hostBrowse) {
      setBrowseTarget(target);
      setBrowserOpen((open) => (browseTarget === target ? !open : true));
      return;
    }
    const selected = await window.electronAPI.dialog.selectDirectory();
    if (!selected) return;
    if (target === 'parent') setParentDir(selected);
    else setPathValue(selected);
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

  const folderError = validateNewFolderName(folderName);
  const clonedName = cloneFolderName(repoUrl);
  const parent = normalizeParent(parentDir);
  const canSubmit =
    mode === 'ssh'
      ? sshConnectionId.length > 0 && sshPath.trim().startsWith('/')
      : localMethod === 'clone'
        ? Boolean(clonedName && parent)
        : localMethod === 'new-folder'
          ? folderError === null && Boolean(parent)
          : pathValue.trim().length > 0;
  const folderDestination =
    folderError === null && parent ? joinDirectoryPath(parent, folderName.trim()) : '';
  const cloneDestination = clonedName && parent ? joinDirectoryPath(parent, clonedName) : '';

  const addCreatedPath = (
    work: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>,
    fallback: string
  ) => {
    setSubmitting(true);
    setActionError('');
    const seq = ++submitSeq.current;
    void work()
      .then((result) => {
        if (seq !== submitSeq.current) return;
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        onAdd({ path: result.path, ...(groupId ? { groupId } : {}) });
        onOpenChange(false);
      })
      .catch(() => {
        if (seq === submitSeq.current) setActionError(fallback);
      })
      .finally(() => {
        if (seq === submitSeq.current) setSubmitting(false);
      });
  };

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
    if (mode === 'local' && localMethod === 'new-folder') {
      const name = folderName.trim();
      if (submitting || validateNewFolderName(name) || !parent) return;
      addCreatedPath(
        () => window.electronAPI.projects.createHostDir(parent, name),
        'Failed to create folder.'
      );
      return;
    }
    if (mode === 'local' && localMethod === 'clone') {
      const url = repoUrl.trim();
      if (submitting || !cloneFolderName(url) || !parent) return;
      addCreatedPath(
        () => window.electronAPI.projects.gitClone({ url, parentDir: parent }),
        'git clone failed.'
      );
      return;
    }
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
              <>
                <Tabs
                  value={localMethod}
                  onValueChange={(value) => {
                    setLocalMethod(value as 'existing' | 'clone' | 'new-folder');
                    setBrowserOpen(false);
                    setActionError('');
                  }}
                >
                  <TabsList>
                    <TabsTab value="existing" className="h-7 px-2 text-xs">
                      {t('Existing directory')}
                    </TabsTab>
                    <TabsTab value="clone" className="h-7 px-2 text-xs">
                      {t('Clone')}
                    </TabsTab>
                    <TabsTab value="new-folder" className="h-7 px-2 text-xs">
                      {t('New folder')}
                    </TabsTab>
                  </TabsList>
                </Tabs>
                {localMethod === 'clone' ? (
                  <>
                    <Field className="w-full">
                      <FieldLabel>{t('Repository')}</FieldLabel>
                      <Input
                        value={repoUrl}
                        size="sm"
                        className="font-mono text-xs"
                        placeholder={t('owner/repo or a git URL')}
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        onChange={(event) => setRepoUrl(event.target.value)}
                      />
                    </Field>
                    <ParentLocation
                      parentDir={parentDir}
                      destination={cloneDestination}
                      onParentDirChange={setParentDir}
                      onBrowse={() => void handleBrowse('parent')}
                    />
                  </>
                ) : localMethod === 'new-folder' ? (
                  <>
                    <Field className="w-full">
                      <FieldLabel>{t('Name')}</FieldLabel>
                      <Input
                        value={folderName}
                        size="sm"
                        className="font-mono text-xs"
                        placeholder={t('Folder name')}
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        onChange={(event) => setFolderName(event.target.value)}
                      />
                      {folderName.trim() && folderError ? (
                        <p className="text-destructive text-xs">{t(folderError)}</p>
                      ) : null}
                    </Field>
                    <ParentLocation
                      parentDir={parentDir}
                      destination={folderDestination}
                      onParentDirChange={setParentDir}
                      onBrowse={() => void handleBrowse('parent')}
                    />
                  </>
                ) : (
                  <>
                    <DirSearch key={open ? 'open' : 'closed'} onSelect={setPathValue} />
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
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void handleBrowse('path')}
                          >
                            {t('Browse')}
                          </Button>
                        </div>
                        <AutocompletePopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                          <AutocompleteEmpty>{t('No matching projects found')}</AutocompleteEmpty>
                          <AutocompleteList>
                            {(project: RecentProject) => (
                              <AutocompleteItem
                                key={project.path}
                                value={project}
                                className="gap-2"
                              >
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
                  </>
                )}
                {browserOpen && hostBrowse ? (
                  <DirBrowser
                    key={browseTarget}
                    list={listHostDirs}
                    create={createHostDir}
                    initialPath={
                      (browseTarget === 'parent' ? parentDir : pathValue).trim() || undefined
                    }
                    onSelect={(selected) => {
                      if (browseTarget === 'parent') setParentDir(selected);
                      else setPathValue(selected);
                      setBrowserOpen(false);
                    }}
                    onClose={() => setBrowserOpen(false)}
                  />
                ) : null}
                {actionError ? <p className="text-destructive text-xs">{t(actionError)}</p> : null}
              </>
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
              {submitting && mode === 'local' && localMethod !== 'existing' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {mode === 'local' && localMethod === 'clone'
                ? t('Clone and add')
                : mode === 'local' && localMethod === 'new-folder'
                  ? t('Create and add')
                  : t('Add')}
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

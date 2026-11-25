import type {
  GitFile,
  GitFileDiffResult,
  GitOperationResult,
  GitStatusResult,
} from '@shared/types/git';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Download,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { GitCommitAiButton } from './GitCommitAiButton';
import { GitDiffPreview } from './GitDiffPreview';
import { type GitFileDirectory, GitFileList, GitFileViewToggle } from './GitFileList';
import { GitFileRow } from './GitFileRow';
import { GitHistoryView } from './GitHistoryView';
import { GitPanelLayout } from './GitPanelLayout';
import { usePanelVisibility } from './panelVisibility';

type Status = Extract<GitStatusResult, { ok: true }>;
type Selection = { path: string; staged: boolean };
type BulkDiscard = {
  kind: 'all' | 'untracked';
  tracked: string[];
  untracked: string[];
  /** 仅从树状视图文件夹右键触发时设置，用于确认弹窗明确标注目标目录 */
  directory?: string;
};

export function GitChangesView({
  conversationId,
  projectId,
  disabled,
  unavailable,
  editWriteKey,
}: {
  conversationId: string;
  projectId: string;
  disabled: boolean;
  unavailable: boolean;
  editWriteKey: string;
}) {
  const { t } = useI18n();
  // 面板不在屏幕上（隐藏会话的 dock、tab 未选中、侧栏收起）就不读 Git，免得和 agent 的 git 操作抢 index.lock
  const { visible: panelVisible } = usePanelVisibility();
  const request = useMemo(() => ({ conversationId, projectId }), [conversationId, projectId]);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<'changes' | 'history'>('changes');
  const [tree, setTree] = useState(true);
  const [message, setMessage] = useState('');
  const [generating, setGenerating] = useState(false);
  const commitRow = useRef<HTMLDivElement>(null);
  const focusMessage = useRef(false);
  const [query, setQuery] = useState('');
  const filterInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [discard, setDiscard] = useState<GitFile | null>(null);
  const [bulkDiscard, setBulkDiscard] = useState<BulkDiscard | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ staged: true });
  const [diff, setDiff] = useState<GitFileDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const alive = useRef(false);
  const busyRef = useRef(false);
  const readSequence = useRef(0);
  const readInFlight = useRef(0);

  const refresh = useCallback(
    async (visible = false) => {
      if (
        !panelVisible ||
        disabled ||
        unavailable ||
        busyRef.current ||
        (readInFlight.current !== 0 && !visible)
      )
        return;
      const sequence = ++readSequence.current;
      readInFlight.current = sequence;
      if (visible) setLoading(true);
      try {
        const result = await window.electronAPI.git.status(request);
        if (!alive.current || sequence !== readSequence.current) return;
        if (result.ok) {
          setStatus(result);
          setReadError(null);
        } else {
          setStatus(null);
          setReadError(result.error);
        }
      } catch {
        if (alive.current && sequence === readSequence.current) {
          setStatus(null);
          setReadError('Could not read Git status.');
        }
      } finally {
        if (readInFlight.current === sequence) readInFlight.current = 0;
        if (alive.current && sequence === readSequence.current) setLoading(false);
      }
    },
    // panelVisible 变化会换掉 refresh：重新挂轮询，并由下方 effect 在切回可见时立即读一次
    [panelVisible, disabled, unavailable, request]
  );

  useEffect(() => {
    alive.current = true;
    const onFocus = () => {
      void refresh();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void refresh();
    }, 5000);
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      readSequence.current += 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    void editWriteKey;
    void refresh(true);
  }, [refresh, editWriteKey]);

  // 生成结果回填后聚焦：等输入框解除禁用再聚焦
  useEffect(() => {
    if (!focusMessage.current || generating || !message) return;
    focusMessage.current = false;
    commitRow.current?.querySelector('textarea')?.focus();
  }, [generating, message]);

  useEffect(() => {
    if (!selected || !status) return;
    const files = selected.staged ? status.staged : status.unstaged;
    if (!files.some((file) => file.path === selected.path)) {
      setSelected(null);
      setDiff(null);
      setDiffLoading(false);
    }
  }, [selected, status]);

  useEffect(() => {
    void historyVersion;
    if (
      !panelVisible ||
      !selected ||
      disabled ||
      unavailable ||
      busy !== null ||
      view !== 'changes'
    )
      return;
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await window.electronAPI.git.fileDiff({ ...request, ...selected });
        if (active) setDiff(result);
      } catch {
        if (active) setDiff({ ok: false, error: 'Could not load the diff.' });
      } finally {
        inFlight = false;
        if (active) setDiffLoading(false);
      }
    };
    void load();
    const onFocus = () => {
      void load();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void load();
    }, 5000);
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [panelVisible, request, selected, historyVersion, disabled, unavailable, view, busy]);

  const perform = async (
    label: string,
    action: () => Promise<GitOperationResult>,
    onSuccess?: () => void
  ) => {
    if (busyRef.current || disabled || unavailable || loading || !status) return;
    busyRef.current = true;
    readSequence.current += 1;
    setBusy(label);
    setError(null);
    try {
      const result = await action();
      if (!alive.current) return;
      if (result.ok) {
        onSuccess?.();
      } else setError(result.error);
    } catch {
      if (alive.current) setError('Could not complete the Git operation.');
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(null);
        setHistoryVersion((version) => version + 1);
        void refresh(true);
        void useSessionsStore
          .getState()
          .refreshWorktreeStatuses()
          .catch(() => {});
      }
    }
  };

  const blocked = disabled || unavailable || loading || busy !== null || !status;
  const canCommit =
    !blocked && !generating && Boolean(message.trim()) && Boolean(status?.staged.length);
  const select = (file: GitFile, staged: boolean) => {
    if (selected?.path === file.path && selected.staged === staged) return;
    setDiff(null);
    setDiffLoading(true);
    setSelected({ path: file.path, staged });
  };
  const groups = [
    { id: 'staged', staged: true, title: t('Staged changes'), files: status?.staged ?? [] },
    {
      id: 'unstaged',
      staged: false,
      title: t('Unstaged changes'),
      files: status?.unstaged.filter((file) => file.status !== 'untracked') ?? [],
    },
    {
      id: 'untracked',
      staged: false,
      title: t('Untracked changes'),
      files: status?.unstaged.filter((file) => file.status === 'untracked') ?? [],
    },
  ];
  const filter = query.trim().toLowerCase();
  const visibleGroups = groups.map((group) => ({
    ...group,
    files: group.files.filter((file) => file.path.toLowerCase().includes(filter)),
  }));
  const visibleCount = visibleGroups.reduce((count, group) => count + group.files.length, 0);
  // 有冲突时 Main 会整批拒绝写操作，批量入口直接禁用
  const conflicted = groups[1].files.filter((file) => file.status === 'conflicted').length;
  const trackedPaths = groups[1].files.map((file) => file.path);
  const untrackedPaths = groups[2].files.map((file) => file.path);
  const bulkDescription = bulkDiscard
    ? [
        bulkDiscard.tracked.length > 0 &&
          t(
            bulkDiscard.directory
              ? 'Unstaged changes in {{count}} tracked files in {{path}} will be lost; the files are restored to their staged version.'
              : 'Unstaged changes in {{count}} tracked files will be lost; the files are restored to their staged version.',
            { count: bulkDiscard.tracked.length, path: bulkDiscard.directory ?? '' }
          ),
        bulkDiscard.untracked.length > 0 &&
          t(
            bulkDiscard.directory
              ? '{{count}} untracked files in {{path}} will be permanently deleted and cannot be recovered.'
              : '{{count}} untracked files will be permanently deleted and cannot be recovered.',
            { count: bulkDiscard.untracked.length, path: bulkDiscard.directory ?? '' }
          ),
        bulkDiscard.kind === 'untracked' && t('Tracked files are not changed.'),
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  const commit = () => {
    if (canCommit) {
      void perform(
        'Commit',
        () => window.electronAPI.git.commit({ ...request, message }),
        () => setMessage('')
      );
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-[36px] shrink-0 items-center gap-1 border-b px-2">
        {status && !disabled && !unavailable && !readError && (
          <div
            className="flex shrink-0 items-center gap-1"
            role="tablist"
            aria-label={t('Git views')}
          >
            <Button
              role="tab"
              aria-selected={view === 'changes'}
              variant={view === 'changes' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setView('changes')}
            >
              <FileDiff className="size-3.5" />
              {t('Changes')}
            </Button>
            <Button
              role="tab"
              aria-selected={view === 'history'}
              variant={view === 'history' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setView('history')}
            >
              <History className="size-3.5" />
              {t('History')}
            </Button>
          </div>
        )}
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs" title={status?.branch ?? undefined}>
          {status?.branch ?? (status ? t('Detached HEAD') : t('Git'))}
        </span>
        {status?.upstream && (
          <span className="shrink-0 text-[11px] text-muted-foreground" title={status.upstream}>
            ↓{status.behind} ↑{status.ahead}
          </span>
        )}
        {status && !status.upstream && (
          <span
            className="max-w-20 truncate text-[11px] text-muted-foreground"
            title={t('No upstream branch configured.')}
          >
            {t('No upstream')}
          </span>
        )}
        <GitAction
          title={t('Fetch')}
          disabled={blocked}
          onClick={() => void perform('Fetch', () => window.electronAPI.git.fetch(request))}
        >
          <Download className="size-3.5" />
        </GitAction>
        <GitAction
          title={t('Pull')}
          disabled={blocked || !status?.upstream}
          onClick={() => void perform('Pull', () => window.electronAPI.git.pull(request))}
        >
          <ArrowDown className="size-3.5" />
        </GitAction>
        <GitAction
          title={t('Push')}
          disabled={blocked || !status?.upstream}
          onClick={() => void perform('Push', () => window.electronAPI.git.push(request))}
        >
          <ArrowUp className="size-3.5" />
        </GitAction>
        <GitAction
          title={t('Refresh')}
          disabled={disabled || unavailable || busy !== null || loading}
          onClick={() => {
            setHistoryVersion((version) => version + 1);
            void refresh(true);
          }}
        >
          <RefreshCw
            className={cn('size-3.5', loading && !unavailable && !disabled && 'animate-spin')}
          />
        </GitAction>
      </div>
      {busy && (
        <p
          role="status"
          className="flex shrink-0 items-center gap-2 px-3 py-1 text-xs text-muted-foreground"
        >
          <Loader2 className="size-3 animate-spin" />
          {t(busy)}…
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap break-words border-b px-3 py-2 text-xs text-destructive"
        >
          {t(error)}
        </p>
      )}
      {unavailable || disabled || readError || !status ? (
        <div
          role="status"
          className="m-3 flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground"
        >
          {t(
            unavailable
              ? 'Git diff is not available for this workspace.'
              : disabled
                ? 'Workspace is changing. Please wait.'
                : (readError ?? 'Loading...')
          )}
        </div>
      ) : view === 'history' ? (
        <GitHistoryView
          key={`${status.head}:${historyVersion}`}
          request={request}
          head={status.head}
          tree={tree}
          onToggleTree={() => setTree((value) => !value)}
        />
      ) : (
        <GitPanelLayout
          title={t('Changed files')}
          hasSelection={selected !== null}
          actions={
            <>
              <Menu>
                <MenuTrigger
                  render={<Button variant="ghost" size="icon-xs" />}
                  title={t('Discard…')}
                  aria-label={t('Discard…')}
                  disabled={blocked}
                >
                  <Undo2 className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-56">
                  <MenuItem
                    variant="destructive"
                    data-discard-option="all"
                    disabled={conflicted > 0 || trackedPaths.length + untrackedPaths.length === 0}
                    onClick={() =>
                      setBulkDiscard({
                        kind: 'all',
                        tracked: trackedPaths,
                        untracked: untrackedPaths,
                      })
                    }
                  >
                    <span className="flex flex-col">
                      {t('Discard all')}
                      <span className="text-[11px] text-muted-foreground">
                        {conflicted > 0
                          ? t('Resolve conflicts first.')
                          : t(
                              'Discard {{tracked}} tracked changes, delete {{untracked}} untracked files',
                              { tracked: trackedPaths.length, untracked: untrackedPaths.length }
                            )}
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem
                    variant="destructive"
                    data-discard-option="untracked"
                    disabled={conflicted > 0 || untrackedPaths.length === 0}
                    onClick={() =>
                      setBulkDiscard({
                        kind: 'untracked',
                        tracked: [],
                        untracked: untrackedPaths,
                      })
                    }
                  >
                    <span className="flex flex-col">
                      {t('Discard untracked')}
                      <span className="text-[11px] text-muted-foreground">
                        {conflicted > 0
                          ? t('Resolve conflicts first.')
                          : t('Permanently delete {{count}} untracked files', {
                              count: untrackedPaths.length,
                            })}
                      </span>
                    </span>
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem data-discard-option="cancel">{t('Cancel')}</MenuItem>
                </MenuPopup>
              </Menu>
              <GitFileViewToggle tree={tree} onToggle={() => setTree((value) => !value)} />
            </>
          }
          navigation={
            <>
              <div className="shrink-0 px-2 pb-1.5">
                <InputGroup className="text-xs">
                  <InputGroupInput
                    ref={filterInput}
                    size="sm"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('Filter changed files…')}
                    aria-label={t('Filter changed files…')}
                  />
                  {query.length > 0 && (
                    <InputGroupAddon align="inline-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        title={t('Clear')}
                        aria-label={t('Clear')}
                        onClick={() => {
                          setQuery('');
                          filterInput.current?.focus();
                        }}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </InputGroupAddon>
                  )}
                </InputGroup>
              </div>
              <div className="relative min-h-0 flex-1 overflow-y-auto px-1 pb-1">
                {visibleGroups.map((group) => {
                  if (group.files.length === 0) return null;
                  // 搜索命中时强制展开，免得结果被折叠挡住
                  const expanded = Boolean(filter) || !collapsed[group.id];
                  const hiddenConflicts = expanded
                    ? 0
                    : group.files.filter((file) => file.status === 'conflicted').length;
                  return (
                    <section key={group.id} data-git-group={group.id} className="mb-2 last:mb-0">
                      <div className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-muted-foreground">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
                          aria-expanded={expanded}
                          onClick={() => {
                            if (!filter)
                              setCollapsed((value) => ({ ...value, [group.id]: !value[group.id] }));
                          }}
                        >
                          <span className="min-w-0 truncate">{group.title}</span>
                          <span className="shrink-0 font-normal">· {group.files.length}</span>
                          {hiddenConflicts > 0 && (
                            <span className="shrink-0 font-normal text-destructive">
                              {t('{{count}} conflicted', { count: hiddenConflicts })}
                            </span>
                          )}
                          {expanded ? (
                            <ChevronDown className="size-3 shrink-0" />
                          ) : (
                            <ChevronRight className="size-3 shrink-0" />
                          )}
                        </button>
                        <GitAction
                          title={t(group.staged ? 'Unstage all' : 'Stage all')}
                          disabled={blocked}
                          onClick={() =>
                            void perform(group.staged ? 'Unstage' : 'Stage', () =>
                              window.electronAPI.git[group.staged ? 'unstage' : 'stage']({
                                ...request,
                                paths: group.files.map((file) => file.path),
                              })
                            )
                          }
                        >
                          {group.staged ? (
                            <Minus className="size-3.5" />
                          ) : (
                            <Plus className="size-3.5" />
                          )}
                        </GitAction>
                      </div>
                      {expanded && (
                        <GitFileList
                          key={filter}
                          files={group.files}
                          tree={tree}
                          renderDirectory={(directory: GitFileDirectory, trigger: ReactElement) => {
                            const paths = directory.files.map((file) => file.path);
                            const count = paths.length;
                            const isUntrackedGroup = group.id === 'untracked';
                            return (
                              <ContextMenu>
                                <ContextMenuTrigger
                                  render={trigger as ReactElement<Record<string, unknown>>}
                                />
                                <ContextMenuPopup className="min-w-44">
                                  <ContextMenuItem
                                    data-git-dir-action={group.staged ? 'unstage' : 'stage'}
                                    data-git-dir-path={directory.path}
                                    disabled={blocked || count === 0}
                                    onClick={() =>
                                      void perform(group.staged ? 'Unstage' : 'Stage', () =>
                                        window.electronAPI.git[group.staged ? 'unstage' : 'stage']({
                                          ...request,
                                          paths,
                                        })
                                      )
                                    }
                                  >
                                    {group.staged ? (
                                      <Minus className="size-3.5" />
                                    ) : (
                                      <Plus className="size-3.5" />
                                    )}
                                    <span className="flex-1">
                                      {t(group.staged ? 'Unstage' : 'Stage')}
                                    </span>
                                    <span className="font-mono text-[11px] opacity-70">
                                      {count}
                                    </span>
                                  </ContextMenuItem>
                                  {!group.staged && (
                                    <>
                                      <ContextMenuSeparator />
                                      <ContextMenuItem
                                        variant="destructive"
                                        data-git-dir-action="discard"
                                        data-git-dir-path={directory.path}
                                        disabled={blocked || conflicted > 0 || count === 0}
                                        onClick={() => {
                                          const tracked = directory.files
                                            .filter((file) => file.status !== 'untracked')
                                            .map((file) => file.path);
                                          const untracked = directory.files
                                            .filter((file) => file.status === 'untracked')
                                            .map((file) => file.path);
                                          if (!tracked.length && !untracked.length) return;
                                          setBulkDiscard({
                                            kind: isUntrackedGroup ? 'untracked' : 'all',
                                            tracked,
                                            untracked,
                                            directory: directory.path,
                                          });
                                        }}
                                      >
                                        <Undo2 className="size-3.5" />
                                        <span className="flex flex-1 flex-col">
                                          {t(
                                            isUntrackedGroup
                                              ? 'Delete untracked files'
                                              : 'Discard changes'
                                          )}
                                          {conflicted > 0 && (
                                            <span className="text-[11px] text-muted-foreground">
                                              {t('Resolve conflicts first.')}
                                            </span>
                                          )}
                                        </span>
                                        <span className="font-mono text-[11px] opacity-70">
                                          {count}
                                        </span>
                                      </ContextMenuItem>
                                    </>
                                  )}
                                </ContextMenuPopup>
                              </ContextMenu>
                            );
                          }}
                        >
                          {(file) => (
                            <GitFileRow
                              file={file}
                              showDirectory={!tree}
                              selected={
                                selected?.path === file.path && selected.staged === group.staged
                              }
                              onSelect={() => select(file, group.staged)}
                              actions={
                                <>
                                  {!group.staged && (
                                    <GitAction
                                      title={t(
                                        file.status === 'untracked'
                                          ? 'Delete untracked file'
                                          : 'Discard changes'
                                      )}
                                      disabled={blocked || file.status === 'conflicted'}
                                      onClick={() => setDiscard(file)}
                                    >
                                      <Undo2 className="size-3.5" />
                                    </GitAction>
                                  )}
                                  <GitAction
                                    title={t(group.staged ? 'Unstage' : 'Stage')}
                                    disabled={blocked}
                                    onClick={() =>
                                      void perform(group.staged ? 'Unstage' : 'Stage', () =>
                                        window.electronAPI.git[group.staged ? 'unstage' : 'stage']({
                                          ...request,
                                          paths: [file.path],
                                        })
                                      )
                                    }
                                  >
                                    {group.staged ? (
                                      <Minus className="size-3.5" />
                                    ) : (
                                      <Plus className="size-3.5" />
                                    )}
                                  </GitAction>
                                </>
                              }
                            />
                          )}
                        </GitFileList>
                      )}
                    </section>
                  );
                })}
                {visibleCount === 0 && (
                  <p className="m-1 rounded-md border border-dashed px-2 py-5 text-center text-xs text-muted-foreground">
                    {t(
                      status.staged.length + status.unstaged.length === 0
                        ? 'Working tree clean.'
                        : 'No matching files.'
                    )}
                  </p>
                )}
              </div>
              <div ref={commitRow} className="flex shrink-0 items-end gap-1.5 border-t p-2">
                <Textarea
                  size="sm"
                  rows={3}
                  value={message}
                  aria-label={t('Commit message')}
                  placeholder={t('Enter commit message…')}
                  className="min-w-0 flex-1 text-xs [&_textarea]:max-h-[calc(6lh+0.5rem)] [&_textarea]:min-h-[calc(3lh+0.5rem)] [&_textarea]:resize-none [&_textarea]:overflow-auto"
                  disabled={busy !== null || generating}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.key === 'Enter' &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      commit();
                    }
                  }}
                />
                <GitCommitAiButton
                  request={request}
                  message={message}
                  disabled={blocked}
                  onRunningChange={setGenerating}
                  onGenerated={(generated) => {
                    focusMessage.current = true;
                    setMessage(generated);
                  }}
                />
                <Button
                  size="xs"
                  className="mb-0.5 shrink-0"
                  title={t('{{count}} staged files', { count: status.staged.length })}
                  aria-label={t('Commit')}
                  disabled={!canCommit}
                  onClick={commit}
                >
                  <GitCommitHorizontal className="size-3.5" />
                  {t('Commit')}
                  {status.staged.length > 0 && (
                    <span className="font-mono text-[11px]">{status.staged.length}</span>
                  )}
                </Button>
              </div>
            </>
          }
        >
          {selected && (
            <div
              className="shrink-0 truncate border-b px-3 py-1 text-[11px] text-muted-foreground"
              title={selected.path}
            >
              {t(selected.staged ? 'Staged changes' : 'Unstaged changes')} · {selected.path}
            </div>
          )}
          <GitDiffPreview result={diff} loading={selected !== null && diffLoading} />
        </GitPanelLayout>
      )}
      <ConfirmDialog
        open={discard !== null && !blocked}
        onOpenChange={(open) => {
          if (!open) setDiscard(null);
        }}
        title={t(discard?.status === 'untracked' ? 'Delete untracked file' : 'Discard changes')}
        description={
          discard?.status === 'untracked'
            ? t('Delete untracked file {{path}} permanently?', { path: discard.path })
            : t('Restore {{path}} to its staged version? Unstaged changes will be lost.', {
                path: discard?.path ?? '',
              })
        }
        confirmLabel={t(discard?.status === 'untracked' ? 'Delete' : 'Discard')}
        onConfirm={() => {
          if (discard) {
            void perform('Discard', () =>
              window.electronAPI.git.discard({
                ...request,
                paths: [discard.path],
                confirmUntracked: discard.status === 'untracked',
              })
            );
          }
        }}
      />
      <ConfirmDialog
        open={bulkDiscard !== null && !blocked}
        onOpenChange={(open) => {
          if (!open) setBulkDiscard(null);
        }}
        title={t(
          bulkDiscard?.directory
            ? bulkDiscard.kind === 'untracked'
              ? 'Delete untracked files'
              : 'Discard changes'
            : bulkDiscard?.kind === 'untracked'
              ? 'Discard untracked'
              : 'Discard all'
        )}
        description={bulkDescription}
        confirmLabel={
          bulkDiscard?.untracked.length
            ? t(
                bulkDiscard.kind === 'all'
                  ? 'Discard and delete {{count}} untracked files'
                  : 'Delete {{count}} untracked files',
                { count: bulkDiscard.untracked.length }
              )
            : t(bulkDiscard?.directory ? 'Discard' : 'Discard all')
        }
        onConfirm={() => {
          if (bulkDiscard) {
            const { tracked, untracked } = bulkDiscard;
            // 分两次调用：已跟踪那批不放行删除，确认期间若有文件变成未跟踪，Main 会拒绝而不是删掉
            void perform('Discard', async () => {
              if (tracked.length) {
                const result = await window.electronAPI.git.discard({
                  ...request,
                  paths: tracked,
                  confirmUntracked: false,
                });
                if (!result.ok || !untracked.length) return result;
              }
              return window.electronAPI.git.discard({
                ...request,
                paths: untracked,
                confirmUntracked: true,
              });
            });
          }
        }}
      />
    </div>
  );
}

function GitAction({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

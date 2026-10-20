import type {
  GitFile,
  GitFileDiffResult,
  GitOperationResult,
  GitStatusResult,
} from '@shared/types/git';
import {
  ArrowDown,
  ArrowUp,
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
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { GitDiffPreview } from './GitDiffPreview';
import { GitFileList, GitFileViewToggle } from './GitFileList';
import { GitFileRow } from './GitFileRow';
import { GitHistoryView } from './GitHistoryView';
import { GitPanelLayout } from './GitPanelLayout';

type Status = Extract<GitStatusResult, { ok: true }>;
type Selection = { path: string; staged: boolean };

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
  const request = useMemo(() => ({ conversationId, projectId }), [conversationId, projectId]);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<'changes' | 'history'>('changes');
  const [tree, setTree] = useState(true);
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const filterInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [discard, setDiscard] = useState<GitFile | null>(null);
  const [diff, setDiff] = useState<GitFileDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const alive = useRef(false);
  const busyRef = useRef(false);
  const readSequence = useRef(0);
  const readInFlight = useRef(0);

  const refresh = useCallback(
    async (visible = false) => {
      if (disabled || unavailable || busyRef.current || (readInFlight.current !== 0 && !visible))
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
    [disabled, unavailable, request]
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
    if (!selected || disabled || unavailable || busy !== null || view !== 'changes') return;
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
  }, [request, selected, historyVersion, disabled, unavailable, view, busy]);

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
  const canCommit = !blocked && Boolean(message.trim()) && Boolean(status?.staged.length);
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
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        {status && !disabled && !unavailable && !readError && (
          <div className="flex shrink-0 items-center gap-1" role="tablist" aria-label={t('Git views')}>
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
      ) : (
        <>
          {view === 'history' ? (
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
              actions={<GitFileViewToggle tree={tree} onToggle={() => setTree((value) => !value)} />}
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
                  <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
                    {visibleGroups.map((group) =>
                      group.files.length === 0 ? null : (
                        <section key={group.id} className="mb-2 last:mb-0">
                          <div className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-muted-foreground">
                            <span className="min-w-0 flex-1 truncate">
                              {group.title}{' '}
                              <span className="ml-1 font-normal">{group.files.length}</span>
                            </span>
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
                          <GitFileList key={filter} files={group.files} tree={tree}>
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
                        </section>
                      )
                    )}
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
                  <div className="flex shrink-0 items-end gap-1.5 border-t p-2">
                    <Textarea
                      size="sm"
                      rows={3}
                      value={message}
                      aria-label={t('Commit message')}
                      placeholder={t('Enter commit message…')}
                      className="min-w-0 flex-1 text-xs [&_textarea]:max-h-[calc(6lh+0.5rem)] [&_textarea]:min-h-[calc(3lh+0.5rem)] [&_textarea]:resize-none [&_textarea]:overflow-auto"
                      disabled={busy !== null}
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
        </>
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

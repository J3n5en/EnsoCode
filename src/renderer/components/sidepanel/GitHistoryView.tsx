import type { GitFile, GitFileDiffResult, GitHistoryEntry, GitRequest } from '@shared/types/git';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { GitDiffPreview } from './GitDiffPreview';
import { GitFileList, GitFileViewToggle } from './GitFileList';
import { GitFileRow } from './GitFileRow';
import { GitPanelLayout } from './GitPanelLayout';

export function GitHistoryView({
  request,
  head,
  tree,
  onToggleTree,
}: {
  request: GitRequest;
  head: string | null;
  tree: boolean;
  onToggleTree: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [commits, setCommits] = useState<GitHistoryEntry[]>([]);
  const [skip, setSkip] = useState(0);
  const [retry, setRetry] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<GitHistoryEntry | null>(null);
  const [files, setFiles] = useState<GitFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    void retry;
    let alive = true;
    setLoading(true);
    setError(null);
    void window.electronAPI.git
      .history({ ...request, head: head ?? undefined, skip, limit: 20 })
      .then((result) => {
        if (!alive) return;
        if (result.ok) {
          setCommits((prev) => (skip === 0 ? result.commits : [...prev, ...result.commits]));
          setHasMore(result.hasMore);
        } else setError(result.error);
      })
      .catch(() => {
        if (alive) setError('Could not load Git history.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [request, head, skip, retry]);

  useEffect(() => {
    if (!selectedCommit) return;
    let alive = true;
    setFilesLoading(true);
    setFilesError(null);
    void window.electronAPI.git
      .commitFiles({ ...request, hash: selectedCommit.hash })
      .then((result) => {
        if (!alive) return;
        if (result.ok) setFiles(result.files);
        else setFilesError(result.error);
      })
      .catch(() => {
        if (alive) setFilesError('Could not load the changed files.');
      })
      .finally(() => {
        if (alive) setFilesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [request, selectedCommit]);

  useEffect(() => {
    if (!path || !selectedCommit) return;
    let alive = true;
    setDiffLoading(true);
    void window.electronAPI.git
      .commitDiff({ ...request, hash: selectedCommit.hash, path })
      .then((result) => {
        if (alive) setDiff(result);
      })
      .catch(() => {
        if (alive) setDiff({ ok: false, error: 'Could not load the diff.' });
      })
      .finally(() => {
        if (alive) setDiffLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [request, selectedCommit, path]);

  return (
    <GitPanelLayout
      title={t('History')}
      hasSelection={path !== null}
      actions={<GitFileViewToggle tree={tree} onToggle={onToggleTree} />}
      navigation={
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          {commits.map((commit) => {
            const expanded = selectedCommit?.hash === commit.hash;
            return (
              <div key={commit.hash}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={expanded ? `${id}-${commit.hash}` : undefined}
                  className={cn(
                    'flex w-full min-w-0 items-start gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                    expanded && 'bg-brand/10 dark:bg-brand/15'
                  )}
                  title={`${commit.subject}\n${commit.hash}\n${commit.author} · ${commit.date}`}
                  onClick={() => {
                    setSelectedCommit(expanded ? null : commit);
                    setFiles([]);
                    setFilesLoading(!expanded);
                    setFilesError(null);
                    setPath(null);
                    setDiff(null);
                    setDiffLoading(false);
                  }}
                >
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 size-3.5 shrink-0 text-muted-foreground',
                      !expanded && '-rotate-90'
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-xs">{commit.subject}</span>
                    <span className="flex min-w-0 gap-2 text-[11px] text-muted-foreground">
                      <span className="shrink-0 font-mono">{commit.hash.slice(0, 7)}</span>
                      <span className="min-w-0 flex-1 truncate">{commit.author}</span>
                      <time className="shrink-0" dateTime={commit.date}>
                        {new Date(commit.date).toLocaleDateString()}
                      </time>
                    </span>
                  </span>
                </button>
                {expanded && (
                  <div id={`${id}-${commit.hash}`} className="my-1 ml-3 border-l pl-1">
                    {filesLoading ? (
                      <p className="px-2 py-3 text-xs text-muted-foreground">{t('Loading...')}</p>
                    ) : filesError ? (
                      <p role="alert" className="px-2 py-3 text-xs text-destructive">
                        {t(filesError)}
                      </p>
                    ) : files.length === 0 ? (
                      <p className="px-2 py-3 text-xs text-muted-foreground">
                        {t('No file changes in this commit.')}
                      </p>
                    ) : (
                      <GitFileList key={commit.hash} files={files} tree={tree}>
                        {(file) => (
                          <GitFileRow
                            file={file}
                            showDirectory={!tree}
                            selected={path === file.path}
                            onSelect={() => {
                              if (path === file.path) return;
                              setPath(file.path);
                              setDiff(null);
                              setDiffLoading(true);
                            }}
                          />
                        )}
                      </GitFileList>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {loading && (
            <div className="flex justify-center p-3">
              <Loader2 className="size-4 animate-spin" aria-label={t('Loading...')} />
            </div>
          )}
          {error && (
            <p role="alert" className="px-2 py-3 text-xs text-destructive">
              {t(error)}
            </p>
          )}
          {!loading && !error && commits.length === 0 && (
            <p className="m-1 rounded-md border border-dashed px-2 py-5 text-center text-xs text-muted-foreground">
              {t('No commits yet.')}
            </p>
          )}
          {hasMore && !loading && !error && (
            <Button
              variant="ghost"
              size="xs"
              className="w-full"
              onClick={() => setSkip(commits.length)}
            >
              {t('Load more commits')}
            </Button>
          )}
          {error && (
            <Button
              variant="ghost"
              size="xs"
              className="w-full"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t('Retry')}
            </Button>
          )}
        </div>
      }
    >
      {selectedCommit && path && (
        <div
          className="shrink-0 truncate border-b px-3 py-1 text-[11px] text-muted-foreground"
          title={`${selectedCommit.subject} · ${path}`}
        >
          {selectedCommit.hash.slice(0, 7)} · {path}
        </div>
      )}
      <GitDiffPreview result={diff} loading={diffLoading} />
    </GitPanelLayout>
  );
}

import { type CodeViewItem, parseDiffFromFile } from '@pierre/diffs';
import { CodeView } from '@pierre/diffs/react';
import { useEffect, useMemo, useState } from 'react';
import { CODE_THEME, ensureHighlighter } from '@/components/chat/codeHighlighter';
import { useI18n } from '@/i18n';
import { aggregateSessionChanges } from '@/lib/sessionChanges';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { buildTimeline } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { useSidePanelStore } from '@/stores/sidePanel';

const CODE_VIEW_OPTIONS = {
  themeType: 'system',
  theme: CODE_THEME,
  diffStyle: 'split',
  lineDiffType: 'word',
  preferredHighlighter: 'shiki-js',
  overflow: 'scroll',
  stickyHeaders: true,
} as const;

const CODE_VIEW_STYLE = { height: '100%', overflow: 'auto' } as const;

function resolvePath(root: string | undefined, rel: string): string | null {
  if (!rel) return null;
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) return rel;
  if (!root) return null;
  return `${root.replace(/[/\\]+$/, '')}/${rel}`;
}

export function ChangesView({
  conversationId,
  projectId,
}: {
  conversationId: string;
  projectId: string;
}) {
  const { t } = useI18n();
  const mode = useSidePanelStore((s) => s.changesModeByConversation[conversationId]) ?? 'all';
  const setMode = useSidePanelStore((s) => s.setChangesMode);
  const snapshots = useSidePanelStore((s) => s.snapshotsByConversation[conversationId]) ?? {};
  const saveSnapshots = useSidePanelStore((s) => s.saveSnapshots);

  const conversation = useSessionsStore((s) => s.conversations[conversationId]);
  const project = useSettingsStore((s) => s.projects.find((item) => item.id === projectId));
  const ssh = project?.kind === 'ssh';
  const root = conversation?.worktree?.path ?? project?.path;
  const running = conversation?.status === 'running';
  const timeline = useMemo(
    () =>
      buildTimeline(conversation?.messages ?? [], running, conversation?.customEntries ?? [], root),
    [conversation?.customEntries, conversation?.messages, running, root]
  );

  const tools = useMemo(
    () =>
      timeline.flatMap((item) => {
        if (item.kind !== 'tool' || item.state !== 'ok') return [];
        if (item.name !== 'edit' && item.name !== 'write') return [];
        if (!item.summary) return [];
        if (item.name === 'edit' && !(item.edits && item.edits.length > 0)) return [];
        if (item.name === 'write' && !item.writeContent) return [];
        return [
          {
            path: item.summary,
            edits: item.edits,
            writeContent: item.writeContent,
          },
        ];
      }),
    [timeline]
  );

  const [ready, setReady] = useState(false);
  const [currentByPath, setCurrentByPath] = useState<Record<string, string | null>>({});
  const [gitError, setGitError] = useState<'not-repo' | 'unavailable' | null>(null);
  const [gitFiles, setGitFiles] = useState<{ path: string; oldText: string; newText: string }[]>(
    []
  );

  useEffect(() => {
    let alive = true;
    ensureHighlighter().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== 'all') return;
    const paths = [...new Set(tools.map((tool) => tool.path))];
    let alive = true;
    void Promise.all(
      paths.map(async (rel) => {
        const abs = resolvePath(root, rel);
        const text = abs ? await window.electronAPI.files.read(abs) : null;
        return [rel, text] as const;
      })
    ).then((entries) => {
      if (!alive) return;
      setCurrentByPath(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [mode, root, tools]);

  const allResult = useMemo(
    () => aggregateSessionChanges({ tools, snapshots, currentByPath }),
    [tools, snapshots, currentByPath]
  );

  useEffect(() => {
    if (mode !== 'all') return;
    const next = allResult.snapshots;
    const keys = Object.keys(next);
    if (
      keys.length === Object.keys(snapshots).length &&
      keys.every((key) => snapshots[key] === next[key])
    ) {
      return;
    }
    saveSnapshots(conversationId, next);
  }, [allResult.snapshots, conversationId, mode, saveSnapshots, snapshots]);

  useEffect(() => {
    if (mode !== 'git') return;
    if (ssh) {
      setGitError('unavailable');
      setGitFiles([]);
      return;
    }
    let alive = true;
    void window.electronAPI.git.diffHead({ conversationId, projectId }).then((result) => {
      if (!alive) return;
      if (!result.ok) {
        setGitError(result.error);
        setGitFiles([]);
        return;
      }
      setGitError(null);
      setGitFiles(
        result.files.map((file) => ({
          path: file.path,
          oldText: file.oldText,
          newText: file.newText,
        }))
      );
    });
    return () => {
      alive = false;
    };
  }, [conversationId, mode, projectId, ssh]);

  const files = mode === 'git' ? gitFiles : allResult.files;
  const items = useMemo<CodeViewItem[]>(
    () =>
      files.map((file) => ({
        id: `diff:${file.path}`,
        type: 'diff' as const,
        fileDiff: parseDiffFromFile(
          { name: file.path, contents: file.oldText },
          { name: file.path, contents: file.newText }
        ),
        version: 0,
      })),
    [files]
  );

  const emptyText = (() => {
    if (mode === 'git') {
      if (gitError === 'not-repo') return t('Not a git repository.');
      if (gitError === 'unavailable') return t('Git diff is not available for this workspace.');
      return t('No changes relative to HEAD.');
    }
    return t('No file changes in this conversation yet.');
  })();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 gap-1 border-b px-2 py-1">
        <ModeTab active={mode === 'all'} onClick={() => setMode(conversationId, 'all')}>
          {t('Session')}
        </ModeTab>
        <ModeTab active={mode === 'git'} onClick={() => setMode(conversationId, 'git')}>
          {t('Git')}
        </ModeTab>
      </div>
      <div className="min-h-0 flex-1">
        {!ready || files.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {ready ? emptyText : t('Loading...')}
          </div>
        ) : (
          <CodeView
            items={items}
            disableWorkerPool
            style={CODE_VIEW_STYLE}
            options={CODE_VIEW_OPTIONS}
          />
        )}
      </div>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'
      )}
    >
      {children}
    </button>
  );
}

import type { CodeViewItem } from '@pierre/diffs';
import { CodeView } from '@pierre/diffs/react';
import type { ProjectedMessage } from '@shared/types/agent';
import type { SessionChangeSnapshots } from '@shared/types/fileChanges';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CODE_THEME, ensureHighlighter } from '@/components/chat/codeHighlighter';
import { useI18n } from '@/i18n';
import { buildChangeItems, type ChangeItemMemo } from '@/lib/changesItems';
import {
  aggregateSessionChanges,
  type SessionChangeTool,
  sameRecord,
  sameTools,
} from '@/lib/sessionChanges';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { buildTimeline, completedEditWriteFingerprint } from '@/stores/sessions/timeline';
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

const NO_FILES: {
  files: never[];
  snapshots: SessionChangeSnapshots;
  incompletePaths?: string[];
} = {
  files: [],
  snapshots: {},
};
const EMPTY_MESSAGES: ProjectedMessage[] = [];

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
  // tabs sliding：pill 位置/尺寸由 JS 测量写入，CSS 负责补间；首帧挂起过渡避免从 0 宽飞入
  const tabsRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const pillReady = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect 通过 ref 读写 DOM，依赖项是重定位 pill/镜像层的真实触发信号
  useLayoutEffect(() => {
    const bar = tabsRef.current;
    const pill = pillRef.current;
    const active = bar?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!bar || !pill || !active) return;
    if (!pillReady.current) pill.style.transition = 'none';
    pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.height = `${active.offsetHeight}px`;
    if (!pillReady.current) {
      void pill.offsetWidth;
      pill.style.transition = '';
      pillReady.current = true;
    }
  }, [mode]);
  // undefined = 尚未从主进程回读；回读前不聚合、不保存，否则 reconstruct 结果会盖掉磁盘上更早的快照
  const snapshots = useSidePanelStore((s) => s.snapshotsByConversation[conversationId]);
  const saveSnapshots = useSidePanelStore((s) => s.saveSnapshots);
  const loadSnapshots = useSidePanelStore((s) => s.loadSnapshots);

  const editWriteKey = useSessionsStore((s) =>
    completedEditWriteFingerprint(s.conversations[conversationId]?.messages ?? EMPTY_MESSAGES)
  );
  const workspaceRevision = useSessionsStore(
    (s) => s.workspaceRevisionByConversation[conversationId] ?? 0
  );
  const workspaceMigrating = useSessionsStore((s) =>
    Boolean(s.conversations[conversationId]?.workspaceMigrating)
  );
  const project = useSettingsStore((s) => s.projects.find((item) => item.id === projectId));
  const ssh = project?.kind === 'ssh';
  const root = useSessionsStore(
    (s) => s.conversations[conversationId]?.worktree?.path ?? project?.path
  );
  const running = useSessionsStore((s) => s.conversations[conversationId]?.status === 'running');

  // 思考流式不改指纹；只有完成的 edit/write 才重建 timeline / 下游 diff
  const toolsRef = useRef<SessionChangeTool[]>([]);
  const tools = useMemo(() => {
    void editWriteKey;
    const conversation = useSessionsStore.getState().conversations[conversationId];
    const timeline = buildTimeline(
      conversation?.messages ?? EMPTY_MESSAGES,
      running,
      conversation?.customEntries ?? [],
      root
    );
    const next = timeline.flatMap((item): SessionChangeTool[] => {
      if (item.kind !== 'tool') return [];
      if (item.name === 'apply_patch') {
        return (item.fileChanges ?? []).map((change) => ({
          path: change.path,
          edits: null,
          writeContent: null,
          fileChange: change,
        }));
      }
      if (item.state !== 'ok' || (item.name !== 'edit' && item.name !== 'write')) return [];
      if (!item.summary) return [];
      if (item.name === 'edit' && !(item.edits && item.edits.length > 0)) return [];
      if (item.name === 'write' && item.writeContent == null) return [];
      return [{ path: item.summary, edits: item.edits, writeContent: item.writeContent }];
    });
    if (sameTools(toolsRef.current, next)) return toolsRef.current;
    toolsRef.current = next;
    return next;
  }, [conversationId, editWriteKey, root, running]);

  const [ready, setReady] = useState(false);
  const [currentByPath, setCurrentByPath] = useState<Record<string, string | null>>({});
  const [gitError, setGitError] = useState<'not-repo' | 'unavailable' | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
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
    if (mode === 'all') loadSnapshots(conversationId);
  }, [conversationId, loadSnapshots, mode]);

  useEffect(() => {
    void workspaceRevision;
    if (mode !== 'all' || workspaceMigrating) return;
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
      const next = Object.fromEntries(entries);
      setCurrentByPath((prev) => (sameRecord(prev, next) ? prev : next));
    });
    return () => {
      alive = false;
    };
  }, [mode, root, tools, workspaceMigrating, workspaceRevision]);

  const allResult = useMemo(
    () => (snapshots ? aggregateSessionChanges({ tools, snapshots, currentByPath }) : NO_FILES),
    [tools, snapshots, currentByPath]
  );

  useEffect(() => {
    if (mode !== 'all' || !snapshots) return;
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
    void workspaceRevision;
    if (mode !== 'git') return;
    if (workspaceMigrating) {
      setGitLoading(true);
      return;
    }
    if (ssh) {
      setGitError('unavailable');
      setGitFiles([]);
      return;
    }
    let alive = true;
    setGitLoading(true);
    void window.electronAPI.git
      .diffHead({ conversationId, projectId })
      .then((result) => {
        if (!alive) return;
        setGitLoading(false);
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
      })
      .catch(() => {
        if (!alive) return;
        setGitLoading(false);
        setGitError('unavailable');
        setGitFiles([]);
      });
    return () => {
      alive = false;
    };
  }, [conversationId, mode, projectId, ssh, workspaceMigrating, workspaceRevision]);

  const files = mode === 'git' ? gitFiles : allResult.files;
  const incompletePaths = mode === 'git' ? [] : (allResult.incompletePaths ?? []);
  // 折叠态按 item id 记；折叠的文件 CodeView 只渲 header，不解析不高亮
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const memoRef = useRef<ChangeItemMemo>(new Map());
  const items = useMemo<CodeViewItem[]>(
    () => buildChangeItems(files, collapsedIds, memoRef.current),
    [files, collapsedIds]
  );
  const allCollapsed = items.length > 0 && items.every((item) => item.collapsed);
  const toggleAll = () =>
    setCollapsedIds(allCollapsed ? new Set() : new Set(items.map((item) => item.id)));
  // 默认 header 是库在 shadow DOM 里生成的固定结构，点不到；整块自己画才能整行可点
  const renderCustomHeader = useCallback(
    (item: CodeViewItem) => (
      <ChangeFileHeader item={item} onToggle={() => toggleCollapsed(item.id)} />
    ),
    [toggleCollapsed]
  );

  const loading = !ready || (mode === 'git' ? gitLoading : !snapshots);
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
        <div ref={tabsRef} role="tablist" className="t-tabs">
          <span ref={pillRef} aria-hidden="true" className="t-tabs-pill" />
          <ModeTab active={mode === 'all'} onClick={() => setMode(conversationId, 'all')}>
            {t('Session')}
          </ModeTab>
          <ModeTab active={mode === 'git'} onClick={() => setMode(conversationId, 'git')}>
            {t('Git')}
          </ModeTab>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            onClick={toggleAll}
            title={allCollapsed ? t('Expand all') : t('Collapse all')}
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            {allCollapsed ? (
              <ChevronsUpDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronsDownUp className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {loading || (files.length === 0 && incompletePaths.length === 0) ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {loading ? t('Loading...') : emptyText}
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {incompletePaths.map((path) => (
              <div
                key={path}
                className="m-2 flex shrink-0 items-start gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
              >
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0">
                  <div className="truncate font-mono text-foreground" title={path}>
                    {path}
                  </div>
                  <div>{t('Diff unavailable because the original snapshot was truncated.')}</div>
                </div>
              </div>
            ))}
            {files.length > 0 && (
              <div className="min-h-0 flex-1">
                <CodeView
                  items={items}
                  style={CODE_VIEW_STYLE}
                  options={CODE_VIEW_OPTIONS}
                  renderCustomHeader={renderCustomHeader}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 整行可点的文件头：chevron + 路径 + ±行数 */
function ChangeFileHeader({ item, onToggle }: { item: CodeViewItem; onToggle: () => void }) {
  const diff = item.type === 'diff' ? item.fileDiff : null;
  let additions = 0;
  let deletions = 0;
  for (const hunk of diff?.hunks ?? []) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  const name = diff?.name ?? (item.type === 'file' ? item.file.name : '');
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left font-mono text-xs hover:bg-muted/50"
    >
      {item.collapsed ? (
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate" title={name}>
        {name}
      </span>
      {deletions > 0 && <span className="shrink-0 text-red-500">-{deletions}</span>}
      {additions > 0 && <span className="shrink-0 text-green-600">+{additions}</span>}
    </button>
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
      role="tab"
      onClick={onClick}
      aria-selected={active}
      className={cn(
        't-tab rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'font-medium' : 'text-muted-foreground hover:bg-muted/50'
      )}
    >
      {children}
    </button>
  );
}

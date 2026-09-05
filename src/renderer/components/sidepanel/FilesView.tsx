import { useDraggable } from '@dnd-kit/core';
import { Editor, type EditorOptions } from '@pierre/diffs/edit';
import { EditProvider, File, Virtualizer } from '@pierre/diffs/react';
import type { FilesDirEntry } from '@shared/types';
import { ChevronRight, Code2, Eye } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { CODE_THEME, ensureHighlighter } from '@/components/chat/codeHighlighter';
import {
  insertComposerMention,
  requestFocusComposer,
} from '@/components/chat/composerMentionBridge';
import type { DragPayload } from '@/components/chat/dragDrop';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { addSidePanelBrowser, registerFilesTabCloser } from '@/lib/sidePanelDock';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { buildTimeline } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { fileTypeIcon, fileTypeIconClass } from './fileIcons';
import { FileMarkdownPreview } from './filePreviewMarkdown';
import {
  fromPreviewKey,
  type RelMutation,
  remapRelForRename,
  shouldCloseForDelete,
  toggleViewMode,
  toPreviewKey,
  wasPathInvalidated,
} from './filesViewRel';
import { FileTreeMenu, isMarkdownRel } from './fileTreeMenu';

const FILE_OPTIONS = {
  themeType: 'system',
  theme: CODE_THEME,
  disableFileHeader: true,
  overflow: 'scroll',
  preferredHighlighter: 'shiki-js',
} as const;

function createEditor<A>(options: EditorOptions<A>) {
  return new Editor(options);
}

function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function fileName(rel: string): string {
  return rel.split('/').pop() || rel;
}

function dirOf(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? '' : rel.slice(0, idx);
}

interface OpenDoc {
  rel: string;
  contents: string;
  draft: string;
  version: number;
  dirty: boolean;
  conflict: boolean;
  tooLarge?: boolean;
  preview?: boolean;
  /** 同 tab 内的 source/preview 切换（仅 Markdown）；undefined 视为 source */
  viewMode?: 'source' | 'preview';
}

interface FilesViewProps {
  conversationId: string;
  projectId: string;
}

export function FilesView({ conversationId, projectId }: FilesViewProps) {
  const { t } = useI18n();
  const req = useMemo(() => ({ conversationId, projectId }), [conversationId, projectId]);
  const [ready, setReady] = useState(false);
  const [openDocs, setOpenDocs] = useState<OpenDoc[]>([]);
  const [activeRel, setActiveRel] = useState<string | null>(null);
  const [treeGen, setTreeGen] = useState(0);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<null | { parent: string; kind: 'file' | 'dir' }>(null);
  const [renaming, setRenaming] = useState<null | { rel: string; name: string }>(null);
  const [confirmDelete, setConfirmDelete] = useState<null | { rel: string; name: string }>(null);
  const local = useSettingsStore((s) => s.projects.find((p) => p.id === projectId)?.kind !== 'ssh');
  const openDocsRef = useRef(openDocs);
  openDocsRef.current = openDocs;
  const activeRelRef = useRef(activeRel);
  activeRelRef.current = activeRel;
  const tabStripRef = useRef<HTMLDivElement>(null);
  /** 重命名/删除留痕：让 rename/delete 期间已在途的 read/write 不再复活失效路径 */
  const opEpochRef = useRef(0);
  const mutationsRef = useRef<RelMutation[]>([]);
  const recordMutation = useCallback((rel: string) => {
    opEpochRef.current += 1;
    mutationsRef.current.push({ epoch: opEpochRef.current, rel });
    if (mutationsRef.current.length > 200) mutationsRef.current.splice(0, 100);
  }, []);

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip || !activeRel) return;
    const tab = strip.querySelector(`[data-file-tab="${CSS.escape(activeRel)}"]`);
    tab?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeRel]);

  useEffect(() => {
    let alive = true;
    ensureHighlighter().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const applyDisk = useCallback((rel: string, content: string) => {
    setOpenDocs((docs) =>
      docs.map((doc) => {
        if (doc.rel !== rel) return doc;
        if (doc.dirty) {
          if (content !== doc.contents && content !== doc.draft) {
            return { ...doc, conflict: true };
          }
          return doc;
        }
        if (content === doc.draft) return doc;
        return {
          ...doc,
          contents: content,
          draft: content,
          version: doc.version + 1,
          conflict: false,
        };
      })
    );
  }, []);

  const failToast = useCallback(
    (error?: string) => {
      addToast({
        title: t(
          error === 'exists'
            ? 'A file or folder with that name already exists.'
            : error === 'invalid-name'
              ? 'Invalid name.'
              : 'Could not complete the file action.'
        ),
      });
    },
    [t]
  );

  const openFile = useCallback(
    async (rel: string) => {
      const existing = openDocsRef.current.find((doc) => doc.rel === rel);
      if (existing) {
        setActiveRel(rel);
        return;
      }
      const epoch = opEpochRef.current;
      const result = await window.electronAPI.workspaceFiles.read({ ...req, rel });
      if (wasPathInvalidated(mutationsRef.current, rel, epoch)) return;
      if (!result.ok) {
        if (result.error !== 'too-large') {
          failToast(result.error);
          return;
        }
        setOpenDocs((docs) => [
          ...docs,
          {
            rel,
            contents: '',
            draft: '',
            version: 0,
            dirty: false,
            conflict: false,
            tooLarge: true,
          },
        ]);
        setActiveRel(rel);
        return;
      }
      setOpenDocs((docs) => [
        ...docs,
        {
          rel,
          contents: result.content,
          draft: result.content,
          version: 0,
          dirty: false,
          conflict: false,
        },
      ]);
      setActiveRel(rel);
      void window.electronAPI.workspaceFiles.watchStart({ ...req, rel });
    },
    [failToast, req]
  );

  const [confirmClose, setConfirmClose] = useState<null | {
    kind: 'one' | 'others' | 'all';
    rel?: string;
  }>(null);

  const closeRels = useCallback(
    (shouldClose: (rel: string) => boolean) => {
      const docs = openDocsRef.current;
      const nextDocs = docs.filter((doc) => !shouldClose(doc.rel));
      for (const doc of docs) {
        if (shouldClose(doc.rel)) {
          void window.electronAPI.workspaceFiles.watchStop({ ...req, rel: doc.rel });
        }
      }
      setOpenDocs(nextDocs);
      setActiveRel((current) => {
        if (current && nextDocs.some((doc) => doc.rel === current)) return current;
        return nextDocs.at(-1)?.rel ?? null;
      });
    },
    [req]
  );

  const closeFile = useCallback(
    (rel: string) => {
      closeRels((path) => path === rel);
    },
    [closeRels]
  );

  const requestCloseFile = useCallback(
    (rel: string) => {
      const doc = openDocsRef.current.find((item) => item.rel === rel);
      if (doc?.dirty) {
        setConfirmClose({ kind: 'one', rel });
        return;
      }
      closeFile(rel);
    },
    [closeFile]
  );

  useEffect(() => {
    return registerFilesTabCloser(conversationId, () => {
      const rel = activeRelRef.current;
      if (!rel || openDocsRef.current.length === 0) return false;
      requestCloseFile(rel);
      return true;
    });
  }, [conversationId, requestCloseFile]);

  useEffect(() => {
    return () => {
      for (const doc of openDocsRef.current) {
        void window.electronAPI.workspaceFiles.watchStop({ ...req, rel: doc.rel });
      }
    };
  }, [req]);

  useEffect(() => {
    return window.electronAPI.workspaceFiles.onChange((event) => {
      if (event.conversationId !== conversationId) return;
      const doc = openDocsRef.current.find((item) => item.rel === event.rel);
      if (!doc) return;
      void window.electronAPI.workspaceFiles.read({ ...req, rel: event.rel }).then((result) => {
        if (result.ok) applyDisk(event.rel, result.content);
      });
    });
  }, [applyDisk, conversationId, req]);

  const conversation = useSessionsStore((s) => s.conversations[conversationId]);
  const running = conversation?.status === 'running';
  const timeline = useMemo(
    () => buildTimeline(conversation?.messages ?? [], running, conversation?.customEntries ?? []),
    [conversation?.customEntries, conversation?.messages, running]
  );
  useEffect(() => {
    const rels = new Set(
      timeline.flatMap((item) => {
        if (item.kind !== 'tool' || item.state !== 'ok') return [];
        if (item.name !== 'edit' && item.name !== 'write') return [];
        return item.summary ? [item.summary] : [];
      })
    );
    for (const rel of rels) {
      if (!openDocsRef.current.some((doc) => doc.rel === rel)) continue;
      void window.electronAPI.workspaceFiles.read({ ...req, rel }).then((result) => {
        if (result.ok) applyDisk(rel, result.content);
      });
    }
  }, [applyDisk, req, timeline]);

  const bumpTree = useCallback(() => setTreeGen((n) => n + 1), []);

  const expandDir = useCallback((rel: string) => {
    if (!rel) return;
    setExpandedDirs((set) => {
      if (set.has(rel)) return set;
      const next = new Set(set);
      next.add(rel);
      return next;
    });
  }, []);

  const toggleDir = useCallback((rel: string) => {
    setExpandedDirs((set) => {
      const next = new Set(set);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);

  const handleNewFile = useCallback(
    (parent: string) => {
      expandDir(parent);
      setDraft({ parent, kind: 'file' });
    },
    [expandDir]
  );

  const handleNewFolder = useCallback(
    (parent: string) => {
      expandDir(parent);
      setDraft({ parent, kind: 'dir' });
    },
    [expandDir]
  );

  const openPreview = useCallback(
    async (rel: string) => {
      const key = toPreviewKey(rel);
      const existing = openDocsRef.current.find((doc) => doc.rel === key);
      if (existing) {
        setActiveRel(key);
        return;
      }
      const epoch = opEpochRef.current;
      const result = await window.electronAPI.workspaceFiles.read({ ...req, rel });
      if (wasPathInvalidated(mutationsRef.current, rel, epoch)) return;
      if (!result.ok) {
        failToast(result.error);
        return;
      }
      setOpenDocs((docs) => [
        ...docs,
        {
          rel: key,
          contents: result.content,
          draft: result.content,
          version: 0,
          dirty: false,
          conflict: false,
          preview: true,
        },
      ]);
      setActiveRel(key);
    },
    [failToast, req]
  );

  const resolvePreviewImage = useCallback(
    (rel: string) =>
      window.electronAPI.workspaceFiles
        .readImage({ ...req, rel })
        .then((result) => (result.ok ? result.dataUrl : null)),
    [req]
  );

  const resolveRemotePreviewImage = useCallback(
    (url: string) =>
      window.electronAPI.workspaceFiles
        .fetchRemoteImage({ ...req, url })
        .then((result) => (result.ok ? result.dataUrl : null)),
    [req]
  );

  const openInBrowser = useCallback(
    async (rel: string) => {
      const resolved = await window.electronAPI.workspaceFiles.absPath({ ...req, rel });
      if (!resolved.ok || !resolved.local || !resolved.fileUrl) {
        failToast(resolved.ok ? 'unsupported' : resolved.error);
        return;
      }
      const tabId = `browser:file:${conversationId}:${rel}`;
      addSidePanelBrowser({ conversationId, tabId, title: fileName(rel) });
      const result = await window.electronAPI.browser.navigate(
        tabId,
        conversationId,
        resolved.fileUrl
      );
      if (!result.ok) failToast(result.error);
    },
    [conversationId, failToast, req]
  );

  const save = useCallback(
    async (rel: string) => {
      const doc = openDocsRef.current.find((item) => item.rel === rel);
      if (!doc || doc.preview) return;
      const content = doc.draft;
      const epoch = opEpochRef.current;
      const result = await window.electronAPI.workspaceFiles.write({ ...req, rel, content });
      // rel 在写盘期间被重命名/删除：结果已过期，别把陈旧路径标记为「已保存」
      if (wasPathInvalidated(mutationsRef.current, rel, epoch)) return;
      if (!result.ok) {
        failToast(result.error);
        return;
      }
      setOpenDocs((docs) =>
        docs.map((item) =>
          item.rel === rel
            ? { ...item, contents: content, dirty: item.draft !== content, conflict: false }
            : item
        )
      );
    },
    [failToast, req]
  );

  const toggleDocViewMode = useCallback((rel: string) => {
    setOpenDocs((docs) =>
      docs.map((doc) =>
        doc.rel === rel ? { ...doc, viewMode: toggleViewMode(doc.viewMode) } : doc
      )
    );
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      if (!activeRel) return;
      event.preventDefault();
      void save(activeRel);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeRel, save]);

  const active = openDocs.find((doc) => doc.rel === activeRel) ?? null;
  const editOptions = useMemo<EditorOptions<undefined>>(
    () => ({
      enabledSelectionAction: true,
      renderSelectionAction(ctx) {
        const button = document.createElement('button');
        button.type = 'button';
        button.style.cssText =
          'appearance:none;border:0;margin:0;background:transparent;padding:2px 8px;font:inherit;font-size:12px;font-weight:500;line-height:20px;cursor:pointer;color:inherit;border-radius:6px';
        button.textContent = t('Send to conversation');
        button.addEventListener('mouseenter', () => {
          button.style.background = 'color-mix(in lab, currentColor 8%, transparent)';
        });
        button.addEventListener('mouseleave', () => {
          button.style.background = 'transparent';
        });
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => {
          const text = ctx.getSelectionText().trim();
          const rel = activeRel;
          if (!text || !rel) {
            ctx.close();
            return;
          }
          const start = ctx.selection.start.line + 1;
          let end = ctx.selection.end.line + 1;
          if (ctx.selection.end.character === 0 && end > start) end -= 1;
          const loc = start === end ? `L${start}` : `L${start}-L${end}`;
          insertComposerMention({
            kind: 'file',
            id: `${rel}#${loc}`,
            label: `${fileName(rel)}#${loc}`,
            relativePath: `${rel}#${loc}`,
          });
          requestFocusComposer();
          ctx.close();
        });
        return button;
      },
      onChange(file) {
        const rel = activeRel;
        if (!rel) return;
        const next = file.contents;
        setOpenDocs((docs) =>
          docs.map((doc) =>
            doc.rel === rel ? { ...doc, draft: next, dirty: next !== doc.contents } : doc
          )
        );
      },
    }),
    [activeRel, t]
  );

  return (
    <EditProvider createEditor={createEditor}>
      <div className="flex h-full min-h-0 bg-background">
        <div className="w-56 shrink-0 overflow-auto border-r text-sm">
          <FileTreeMenu
            target={{ kind: 'blank' }}
            local={local}
            onNewFile={handleNewFile}
            onNewFolder={handleNewFolder}
            onCopyPath={() => undefined}
            onCopyRel={() => undefined}
          >
            <div className="min-h-full">
              <FileTree
                rel=""
                depth={0}
                conversationId={conversationId}
                projectId={projectId}
                treeEpoch={treeGen}
                draft={draft}
                renaming={renaming}
                local={local}
                expandedDirs={expandedDirs}
                onToggleDir={toggleDir}
                onOpen={openFile}
                onPreview={openPreview}
                onBrowser={openInBrowser}
                onCopyPath={(rel) =>
                  void window.electronAPI.workspaceFiles.copyPath({ ...req, rel, mode: 'absolute' })
                }
                onCopyRel={(rel) =>
                  void window.electronAPI.workspaceFiles.copyPath({ ...req, rel, mode: 'relative' })
                }
                onCopyFile={(rel) =>
                  void window.electronAPI.workspaceFiles.copyFile({ ...req, rel }).then((r) => {
                    if (!r.ok) failToast(r.error);
                  })
                }
                onReveal={(rel) => void window.electronAPI.workspaceFiles.reveal({ ...req, rel })}
                onNewFile={handleNewFile}
                onNewFolder={handleNewFolder}
                onRenameStart={(rel, name) => setRenaming({ rel, name })}
                onDelete={(rel, name) => setConfirmDelete({ rel, name })}
                onDraftCancel={() => setDraft(null)}
                onRenameCancel={() => setRenaming(null)}
                onDraftCommit={async (parent, kind, name) => {
                  const api =
                    kind === 'dir'
                      ? window.electronAPI.workspaceFiles.mkdir
                      : window.electronAPI.workspaceFiles.createFile;
                  const result = await api({ ...req, rel: parent || undefined, name });
                  if (!result.ok) {
                    failToast(result.error);
                    return;
                  }
                  setDraft(null);
                  bumpTree();
                  if (kind === 'file' && result.rel) void openFile(result.rel);
                }}
                onRenameCommit={async (rel, name) => {
                  const result = await window.electronAPI.workspaceFiles.rename({
                    ...req,
                    rel,
                    name,
                  });
                  if (!result.ok) {
                    failToast(result.error);
                    return;
                  }
                  setRenaming(null);
                  const toRel = result.rel;
                  if (toRel) {
                    recordMutation(rel);
                    for (const doc of openDocsRef.current) {
                      if (doc.preview || doc.tooLarge) continue;
                      const nextRel = remapRelForRename(doc.rel, rel, toRel);
                      if (nextRel == null) continue;
                      void window.electronAPI.workspaceFiles.watchStop({ ...req, rel: doc.rel });
                      void window.electronAPI.workspaceFiles.watchStart({ ...req, rel: nextRel });
                    }
                    setOpenDocs((docs) =>
                      docs.map((doc) => {
                        const nextRel = remapRelForRename(doc.rel, rel, toRel);
                        return nextRel == null ? doc : { ...doc, rel: nextRel };
                      })
                    );
                    setActiveRel((cur) =>
                      cur == null ? cur : (remapRelForRename(cur, rel, toRel) ?? cur)
                    );
                    setExpandedDirs((set) => {
                      let changed = false;
                      const next = new Set<string>();
                      for (const dirRel of set) {
                        const mapped = remapRelForRename(dirRel, rel, toRel) ?? dirRel;
                        if (mapped !== dirRel) changed = true;
                        next.add(mapped);
                      }
                      return changed ? next : set;
                    });
                  }
                  bumpTree();
                }}
              />
            </div>
          </FileTreeMenu>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {openDocs.length > 0 && (
            <div
              ref={tabStripRef}
              className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1"
            >
              {openDocs.map((doc) => {
                const tab = (
                  <button
                    type="button"
                    data-file-tab={doc.rel}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
                      doc.rel === activeRel
                        ? 'bg-muted font-medium'
                        : 'text-muted-foreground hover:bg-muted/50'
                    )}
                    onClick={() => setActiveRel(doc.rel)}
                  >
                    <span className="max-w-36 truncate">
                      {fileName(doc.preview ? fromPreviewKey(doc.rel) : doc.rel)}
                      {doc.preview ? ` ${t('Preview')}` : ''}
                      {doc.dirty ? '*' : ''}
                    </span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={(event) => {
                        event.stopPropagation();
                        requestCloseFile(doc.rel);
                      }}
                    >
                      ×
                    </button>
                  </button>
                );
                return (
                  <ContextMenu key={doc.rel}>
                    <ContextMenuTrigger render={tab as ReactElement<Record<string, unknown>>} />
                    <ContextMenuPopup className="min-w-40">
                      <ContextMenuItem
                        onClick={() => {
                          const docs = openDocsRef.current;
                          const keep = doc.rel;
                          const dirtyOthers = docs.some((item) => item.rel !== keep && item.dirty);
                          closeRels(
                            (path) =>
                              path !== keep && !docs.find((item) => item.rel === path)?.dirty
                          );
                          if (dirtyOthers) setConfirmClose({ kind: 'others', rel: keep });
                        }}
                      >
                        {t('Close others')}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => {
                          const docs = openDocsRef.current;
                          const anyDirty = docs.some((item) => item.dirty);
                          closeRels((path) => !docs.find((item) => item.rel === path)?.dirty);
                          if (anyDirty) setConfirmClose({ kind: 'all' });
                        }}
                      >
                        {t('Close all')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => closeRels((path) => path !== doc.rel)}>
                        {t('Force close others')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => closeRels(() => true)}>
                        {t('Force close all')}
                      </ContextMenuItem>
                    </ContextMenuPopup>
                  </ContextMenu>
                );
              })}
            </div>
          )}
          {active?.conflict && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1 text-[11px]">
              <span>{t('This file changed on disk.')}</span>
              <button
                type="button"
                className="underline"
                onClick={() => {
                  void window.electronAPI.workspaceFiles
                    .read({ ...req, rel: active.rel })
                    .then((result) => {
                      if (!result.ok) return;
                      setOpenDocs((docs) =>
                        docs.map((doc) =>
                          doc.rel === active.rel
                            ? {
                                ...doc,
                                contents: result.content,
                                draft: result.content,
                                version: doc.version + 1,
                                dirty: false,
                                conflict: false,
                              }
                            : doc
                        )
                      );
                    });
                }}
              >
                {t('Reload')}
              </button>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {active && !active.preview && !active.tooLarge && isMarkdownRel(active.rel) && (
              <div className="absolute top-2 right-2 z-10">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={active.viewMode === 'preview' ? t('View Source') : t('Preview')}
                  onClick={() => toggleDocViewMode(active.rel)}
                >
                  {active.viewMode === 'preview' ? (
                    <Code2 className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                  {active.viewMode === 'preview' ? t('View Source') : t('Preview')}
                </Button>
              </div>
            )}
            {!ready || !active ? (
              <div className="flex h-full items-center justify-center px-3 text-center text-sm text-muted-foreground">
                {ready ? t('Open a file from the tree.') : t('Loading...')}
              </div>
            ) : active.tooLarge ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t('This file is too large to open in the editor.')}
              </div>
            ) : active.preview || (active.viewMode === 'preview' && isMarkdownRel(active.rel)) ? (
              <div className="h-full overflow-auto px-3 py-2 text-sm">
                <FileMarkdownPreview
                  text={active.preview ? active.contents : active.draft}
                  baseDirRel={dirOf(fromPreviewKey(active.rel))}
                  resolveImage={resolvePreviewImage}
                  resolveRemoteImage={resolveRemotePreviewImage}
                />
              </div>
            ) : (
              <Virtualizer style={{ height: '100%', overflow: 'auto' }}>
                <File
                  key={`${active.rel}:${active.version}`}
                  file={{ name: fileName(active.rel), contents: active.draft }}
                  disableWorkerPool
                  edit
                  editorOptions={editOptions}
                  options={FILE_OPTIONS}
                />
              </Virtualizer>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmClose !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmClose(null);
        }}
        title={t('Unsaved changes')}
        description={
          confirmClose?.kind === 'one'
            ? t('This file has unsaved changes. Close anyway?')
            : t('Some files have unsaved changes. Close anyway?')
        }
        confirmLabel={t('Close')}
        onConfirm={() => {
          if (!confirmClose) return;
          if (confirmClose.kind === 'one' && confirmClose.rel) closeFile(confirmClose.rel);
          else if (confirmClose.kind === 'others' && confirmClose.rel) {
            const keep = confirmClose.rel;
            closeRels((path) => path !== keep);
          } else closeRels(() => true);
          setConfirmClose(null);
        }}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title={t('Delete')}
        description={t('Delete {{name}} permanently?', { name: confirmDelete?.name ?? '' })}
        confirmLabel={t('Delete')}
        onConfirm={() => {
          if (!confirmDelete) return;
          const { rel } = confirmDelete;
          void window.electronAPI.workspaceFiles.remove({ ...req, rel }).then((result) => {
            if (!result.ok) {
              failToast(result.error);
              return;
            }
            recordMutation(rel);
            closeRels((path) => shouldCloseForDelete(path, rel));
            setExpandedDirs((set) => {
              let changed = false;
              const next = new Set<string>();
              for (const dirRel of set) {
                if (shouldCloseForDelete(dirRel, rel)) {
                  changed = true;
                  continue;
                }
                next.add(dirRel);
              }
              return changed ? next : set;
            });
            setConfirmDelete(null);
            bumpTree();
          });
        }}
      />
    </EditProvider>
  );
}

type TreeHandlers = {
  draft: { parent: string; kind: 'file' | 'dir' } | null;
  renaming: { rel: string; name: string } | null;
  local: boolean;
  expandedDirs: Set<string>;
  onToggleDir: (rel: string) => void;
  onOpen: (rel: string) => void;
  onPreview: (rel: string) => void;
  onBrowser: (rel: string) => void;
  onCopyPath: (rel: string) => void;
  onCopyRel: (rel: string) => void;
  onCopyFile: (rel: string) => void;
  onReveal: (rel: string) => void;
  onNewFile: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onRenameStart: (rel: string, name: string) => void;
  onDelete: (rel: string, name: string) => void;
  onDraftCancel: () => void;
  onRenameCancel: () => void;
  onDraftCommit: (parent: string, kind: 'file' | 'dir', name: string) => void;
  onRenameCommit: (rel: string, name: string) => void;
};

function NameDraft({
  depth,
  kind,
  initial,
  onCancel,
  onCommit,
}: {
  depth: number;
  kind: 'file' | 'dir';
  initial: string;
  onCancel: () => void;
  onCommit: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <input
      ref={inputRef}
      className="mx-1 my-0.5 w-[calc(100%-0.5rem)] rounded-sm border bg-background px-1 py-0.5 text-sm outline-none"
      style={{ marginLeft: 8 + depth * 12 }}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const name = value.trim();
          if (name) onCommit(name);
        }
      }}
      aria-label={kind === 'dir' ? 'New Folder' : 'New File'}
    />
  );
}

function FileTree({
  rel,
  depth,
  conversationId,
  projectId,
  treeEpoch,
  ...handlers
}: {
  rel: string;
  depth: number;
  conversationId: string;
  projectId: string;
  treeEpoch: number;
} & TreeHandlers) {
  const [entries, setEntries] = useState<FilesDirEntry[] | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: treeEpoch 强制 listDir 刷新
  useEffect(() => {
    let alive = true;
    void window.electronAPI.workspaceFiles
      .listDir({ conversationId, projectId, rel: rel || undefined })
      .then((result) => {
        if (!alive) return;
        setEntries(result.ok ? result.entries : []);
      });
    return () => {
      alive = false;
    };
  }, [conversationId, projectId, rel, treeEpoch]);

  if (!entries) {
    return <div className="px-2 py-1 text-muted-foreground">…</div>;
  }

  const showDraft = handlers.draft?.parent === rel;

  return (
    <div>
      {entries.map((entry) => {
        const child = joinRel(rel, entry.name);
        const expanded = handlers.expandedDirs.has(child);
        if (entry.kind === 'dir') {
          const renameHere = handlers.renaming?.rel === child;
          const row = renameHere ? (
            <NameDraft
              depth={depth}
              kind="dir"
              initial={entry.name}
              onCancel={handlers.onRenameCancel}
              onCommit={(name) => handlers.onRenameCommit(child, name)}
            />
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/60"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => handlers.onToggleDir(child)}
            >
              <ChevronRight className={cn('h-3.5 w-3.5 shrink-0', expanded && 'rotate-90')} />
              {(() => {
                const Icon = fileTypeIcon(entry.name, true, expanded);
                return (
                  <Icon className={cn('h-4 w-4 shrink-0', fileTypeIconClass(entry.name, true))} />
                );
              })()}
              <span className="truncate">{entry.name}</span>
            </button>
          );
          return (
            <div key={child}>
              <FileTreeMenu
                target={{ kind: 'dir', rel: child, name: entry.name }}
                local={handlers.local}
                onNewFile={handlers.onNewFile}
                onNewFolder={handlers.onNewFolder}
                onCopyPath={handlers.onCopyPath}
                onCopyRel={handlers.onCopyRel}
                onReveal={handlers.onReveal}
                onRename={handlers.onRenameStart}
                onDelete={handlers.onDelete}
              >
                {row}
              </FileTreeMenu>
              {expanded && (
                <FileTree
                  rel={child}
                  depth={depth + 1}
                  conversationId={conversationId}
                  projectId={projectId}
                  treeEpoch={treeEpoch}
                  {...handlers}
                />
              )}
            </div>
          );
        }
        return (
          <FileRow
            key={child}
            rel={child}
            name={entry.name}
            depth={depth}
            renaming={handlers.renaming?.rel === child}
            handlers={handlers}
          />
        );
      })}
      {showDraft && handlers.draft && (
        <NameDraft
          depth={depth}
          kind={handlers.draft.kind}
          initial=""
          onCancel={handlers.onDraftCancel}
          onCommit={(name) => handlers.onDraftCommit(rel, handlers.draft!.kind, name)}
        />
      )}
    </div>
  );
}

function FileRow({
  rel,
  name,
  depth,
  renaming,
  handlers,
}: {
  rel: string;
  name: string;
  depth: number;
  renaming: boolean;
  handlers: TreeHandlers;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `workspace-file:${rel}`,
    data: { type: 'workspace-file', relativePath: rel, name } satisfies DragPayload,
  });
  if (renaming) {
    return (
      <NameDraft
        depth={depth}
        kind="file"
        initial={name}
        onCancel={handlers.onRenameCancel}
        onCommit={(next) => handlers.onRenameCommit(rel, next)}
      />
    );
  }
  const row = (
    <button
      type="button"
      ref={setNodeRef}
      {...listeners}
      style={{ paddingLeft: 20 + depth * 12, opacity: isDragging ? 0.4 : undefined }}
      className="flex w-full cursor-default items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/60"
      onClick={() => handlers.onOpen(rel)}
    >
      {(() => {
        const Icon = fileTypeIcon(name, false);
        return <Icon className={cn('h-4 w-4 shrink-0', fileTypeIconClass(name, false))} />;
      })()}
      <span className="truncate">{name}</span>
    </button>
  );
  return (
    <FileTreeMenu
      target={{ kind: 'file', rel, name }}
      local={handlers.local}
      onNewFile={handlers.onNewFile}
      onNewFolder={handlers.onNewFolder}
      onView={handlers.onOpen}
      onPreview={handlers.onPreview}
      onBrowser={handlers.onBrowser}
      onCopyPath={handlers.onCopyPath}
      onCopyRel={handlers.onCopyRel}
      onCopyFile={handlers.onCopyFile}
      onReveal={handlers.onReveal}
      onRename={handlers.onRenameStart}
      onDelete={handlers.onDelete}
      onSend={(path, label) => {
        insertComposerMention({
          kind: 'file',
          id: path,
          label,
          relativePath: path,
        });
      }}
    >
      {row}
    </FileTreeMenu>
  );
}

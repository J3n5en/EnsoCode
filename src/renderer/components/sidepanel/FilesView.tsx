import { useDraggable } from '@dnd-kit/core';
import { Editor, type EditorOptions } from '@pierre/diffs/edit';
import { EditProvider, File, Virtualizer } from '@pierre/diffs/react';
import type { FilesDirEntry } from '@shared/types';
import { ChevronRight } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { CODE_THEME, ensureHighlighter } from '@/components/chat/codeHighlighter';
import {
  insertComposerMention,
  requestFocusComposer,
} from '@/components/chat/composerMentionBridge';
import type { DragPayload } from '@/components/chat/dragDrop';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useI18n } from '@/i18n';
import { registerFilesTabCloser } from '@/lib/sidePanelDock';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { buildTimeline } from '@/stores/sessions/timeline';
import { fileTypeIcon, fileTypeIconClass } from './fileIcons';

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

interface OpenDoc {
  rel: string;
  contents: string;
  draft: string;
  version: number;
  dirty: boolean;
  conflict: boolean;
  tooLarge?: boolean;
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
  const openDocsRef = useRef(openDocs);
  openDocsRef.current = openDocs;
  const activeRelRef = useRef(activeRel);
  activeRelRef.current = activeRel;
  const tabStripRef = useRef<HTMLDivElement>(null);

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

  const openFile = useCallback(
    async (rel: string) => {
      const existing = openDocsRef.current.find((doc) => doc.rel === rel);
      if (existing) {
        setActiveRel(rel);
        return;
      }
      const result = await window.electronAPI.workspaceFiles.read({ ...req, rel });
      if (!result.ok) {
        if (result.error !== 'too-large') return;
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
    [req]
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

  const save = useCallback(
    async (rel: string) => {
      const doc = openDocsRef.current.find((item) => item.rel === rel);
      if (!doc) return;
      const result = await window.electronAPI.workspaceFiles.write({
        ...req,
        rel,
        content: doc.draft,
      });
      if (!result.ok) return;
      setOpenDocs((docs) =>
        docs.map((item) =>
          item.rel === rel ? { ...item, contents: item.draft, dirty: false, conflict: false } : item
        )
      );
    },
    [req]
  );

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
      <div className="flex h-full min-h-0">
        <div className="w-56 shrink-0 overflow-auto border-r text-sm">
          <FileTree
            rel=""
            depth={0}
            conversationId={conversationId}
            projectId={projectId}
            onOpen={openFile}
          />
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
                      {fileName(doc.rel)}
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
                            (path) => path !== keep && !docs.find((item) => item.rel === path)?.dirty
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
          <div className="min-h-0 flex-1">
            {!ready || !active ? (
              <div className="flex h-full items-center justify-center px-3 text-center text-sm text-muted-foreground">
                {ready ? t('Open a file from the tree.') : t('Loading...')}
              </div>
            ) : active.tooLarge ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t('This file is too large to open in the editor.')}
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
    </EditProvider>
  );
}

function FileTree({
  rel,
  depth,
  conversationId,
  projectId,
  onOpen,
}: {
  rel: string;
  depth: number;
  conversationId: string;
  projectId: string;
  onOpen: (rel: string) => void;
}) {
  const [entries, setEntries] = useState<FilesDirEntry[] | null>(null);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());

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
  }, [conversationId, projectId, rel]);

  if (!entries) {
    return <div className="px-2 py-1 text-muted-foreground">…</div>;
  }

  return (
    <div>
      {entries.map((entry) => {
        const child = joinRel(rel, entry.name);
        const expanded = openDirs.has(child);
        if (entry.kind === 'dir') {
          return (
            <div key={child}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/60"
                style={{ paddingLeft: 8 + depth * 12 }}
                onClick={() =>
                  setOpenDirs((set) => {
                    const next = new Set(set);
                    if (next.has(child)) next.delete(child);
                    else next.add(child);
                    return next;
                  })
                }
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
              {expanded && (
                <FileTree
                  rel={child}
                  depth={depth + 1}
                  conversationId={conversationId}
                  projectId={projectId}
                  onOpen={onOpen}
                />
              )}
            </div>
          );
        }
        return <FileRow key={child} rel={child} name={entry.name} depth={depth} onOpen={onOpen} />;
      })}
    </div>
  );
}

function FileRow({
  rel,
  name,
  depth,
  onOpen,
}: {
  rel: string;
  name: string;
  depth: number;
  onOpen: (rel: string) => void;
}) {
  const { t } = useI18n();
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `workspace-file:${rel}`,
    data: { type: 'workspace-file', relativePath: rel, name } satisfies DragPayload,
  });
  const row = (
    <button
      type="button"
      ref={setNodeRef}
      {...listeners}
      style={{ paddingLeft: 20 + depth * 12, opacity: isDragging ? 0.4 : undefined }}
      className="flex w-full cursor-default items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/60"
      onClick={() => onOpen(rel)}
    >
      {(() => {
        const Icon = fileTypeIcon(name, false);
        return <Icon className={cn('h-4 w-4 shrink-0', fileTypeIconClass(name, false))} />;
      })()}
      <span className="truncate">{name}</span>
    </button>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row as ReactElement<Record<string, unknown>>} />
      <ContextMenuPopup>
        <ContextMenuItem
          onClick={() => {
            insertComposerMention({
              kind: 'file',
              id: rel,
              label: name,
              relativePath: rel,
            });
          }}
        >
          {t('Send to conversation')}
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

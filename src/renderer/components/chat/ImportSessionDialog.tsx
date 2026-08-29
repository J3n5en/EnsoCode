import type { Project } from '@shared/types';
import type { ExternalSessionSource, SimpleMessage } from '@shared/types/sessionImport';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';

interface ImportSessionDialogProps {
  project: Project | null;
  onClose: () => void;
}

/** 从本地 AI 应用（Claude Code / Codex）导入该项目下的会话历史 */
export function ImportSessionDialog({ project, onClose }: ImportSessionDialogProps) {
  const { t } = useI18n();
  const [sources, setSources] = useState<ExternalSessionSource[] | null>(null);
  const [selected, setSelected] = useState<{ sourceId: string; path: string } | null>(null);
  const [preview, setPreview] = useState<SimpleMessage[] | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!project) return;
    setSources(null);
    setSelected(null);
    setPreview(null);
    window.electronAPI.sessionImport
      .scan(project.path)
      .then(setSources)
      .catch(() => setSources([]));
  }, [project]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    setPreview(null);
    window.electronAPI.sessionImport
      .read(selected.sourceId, selected.path)
      .then(setPreview)
      .catch(() => setPreview([]));
  }, [selected]);

  const handleImport = async () => {
    if (!project || !selected) return;
    setImporting(true);
    try {
      const result = await window.electronAPI.sessionImport.import(
        selected.sourceId,
        selected.path,
        project.path
      );
      if (result) {
        void useSessionsStore.getState().addImportedConversation(project.id, result);
        onClose();
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={project !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('Import session')}</DialogTitle>
          <DialogDescription>
            {t('Pick a conversation from a local AI app under {{name}}.', {
              name: project?.name ?? '',
            })}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {sources === null ? (
            <div className="flex flex-col items-center gap-3 py-12">
              <Spinner className="size-5" />
            </div>
          ) : sources.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t('No sessions found for this project')}
            </p>
          ) : (
            <div className="flex h-96 gap-3">
              <div className="flex w-64 shrink-0 flex-col overflow-y-auto rounded-lg border">
                {sources.map((source) => (
                  <div key={source.sourceId}>
                    <p className="sticky top-0 bg-background px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                      {source.sourceName}
                    </p>
                    {source.sessions.map((session) => (
                      <button
                        key={session.path}
                        type="button"
                        onClick={() =>
                          setSelected({ sourceId: source.sourceId, path: session.path })
                        }
                        className={cn(
                          'w-full px-2.5 py-1.5 text-left',
                          selected?.path === session.path ? 'bg-muted' : 'hover:bg-muted/50'
                        )}
                      >
                        <p className="truncate text-xs">{session.title || t('Untitled')}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {new Date(session.updatedAt).toLocaleString()} ·{' '}
                          {t('{{count}} messages', { count: session.messageCount })}
                        </p>
                      </button>
                    ))}
                  </div>
                ))}
              </div>

              <div className="min-w-0 flex-1 overflow-y-auto rounded-lg border bg-muted/20 p-3">
                {!selected ? (
                  <p className="py-12 text-center text-xs text-muted-foreground">
                    {t('Select a session to preview')}
                  </p>
                ) : preview === null ? (
                  <div className="flex justify-center py-12">
                    <Spinner className="size-4" />
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {preview.map((message, index) => (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: 预览列表只读且整体替换
                        key={index}
                        className={cn(
                          'max-w-[90%] rounded-lg px-2.5 py-1.5 text-xs whitespace-pre-wrap',
                          message.role === 'user'
                            ? 'self-end bg-primary/10'
                            : 'self-start bg-background border'
                        )}
                      >
                        {message.text.length > 600
                          ? `${message.text.slice(0, 600)}…`
                          : message.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => void handleImport()} disabled={!selected || importing}>
            {importing ? (
              <Spinner className="mr-1.5 size-3.5" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('Import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

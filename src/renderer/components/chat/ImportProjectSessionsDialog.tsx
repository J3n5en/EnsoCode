import type { ImportProjectSessionsMode } from '@shared/moveConversation';
import type { Project } from '@shared/types';
import { Copy, FolderInput } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import {
  defaultImportMode,
  importProjectSessionsFromDialog,
  moveConversationTargets,
  projectRootConversationCount,
  removeEmptyProjectFromDialog,
} from '@/components/chat/moveConversationAction';
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
import { Radio, RadioGroup } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

interface ImportProjectSessionsDialogProps {
  project: Project | null;
  onClose: () => void;
}

type Preview = { sourceExists: boolean; copies: number };

/** 把其他项目的全部会话移动或复制到当前项目（项目挪路径后找回历史） */
export function ImportProjectSessionsDialog({
  project,
  onClose,
}: ImportProjectSessionsDialogProps) {
  const { t } = useI18n();
  const projects = useSettingsStore((state) => state.projects);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportProjectSessionsMode>('copy');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [importing, setImporting] = useState(false);
  const [emptiedSource, setEmptiedSource] = useState<Project | null>(null);

  useEffect(() => {
    if (project) setSelectedId(null);
  }, [project]);

  useEffect(() => {
    setPreview(null);
    if (!project || !selectedId) return;
    let current = true;
    void window.electronAPI.settings
      .importProjectSessionsPreview({ sourceProjectId: selectedId, targetProjectId: project.id })
      .then((result) => {
        if (!current || !result.ok) return;
        setPreview(result);
        setMode(defaultImportMode(result.sourceExists));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [project, selectedId]);

  const candidates = useMemo(() => {
    if (!project) return [];
    const { conversations } = useSessionsStore.getState();
    return moveConversationTargets(projects, project.id).map((candidate) => ({
      project: candidate,
      count: projectRootConversationCount(conversations, candidate.id),
    }));
  }, [project, projects]);
  const selected = candidates.find((candidate) => candidate.project.id === selectedId);

  const handleImport = async () => {
    if (!project || !selected) return;
    setImporting(true);
    try {
      const done = await importProjectSessionsFromDialog(selected.project.id, project.id, mode, t);
      if (!done) return;
      if (done.offerRemoveSource) setEmptiedSource(selected.project);
      onClose();
    } finally {
      setImporting(false);
    }
  };

  const modes: { value: ImportProjectSessionsMode; label: string; hint: string }[] = [
    {
      value: 'move',
      label: t('Move to this project'),
      hint: t(
        'The conversations leave the original project and show up only here. Session files stay as they are; nothing is copied or deleted.'
      ),
    },
    {
      value: 'copy',
      label: t('Copy to this project'),
      hint: t(
        'The original project keeps its conversations unchanged; this project gets an independent copy.'
      ),
    },
  ];

  return (
    <>
      <Dialog open={project !== null} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('Import conversations from another project')}</DialogTitle>
            <DialogDescription>
              {t(
                'Pick a project. All of its conversations, archived ones included, are brought into {{name}}.',
                { name: project ? project.alias || project.name : '' }
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="flex flex-col gap-3">
            {candidates.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {t('No other projects')}
              </p>
            ) : (
              <div className="flex max-h-64 flex-col overflow-y-auto rounded-lg border">
                {candidates.map(({ project: candidate, count }) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => setSelectedId(candidate.id)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left',
                      selectedId === candidate.id ? 'bg-muted' : 'hover:bg-muted/50'
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{candidate.alias || candidate.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{candidate.path}</p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t('{{count}} conversations', { count })}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {selected && (
              <RadioGroup
                value={mode}
                onValueChange={(value) => setMode(value as ImportProjectSessionsMode)}
                className="grid gap-2"
                aria-label={t('Import mode')}
              >
                {modes.map((item) => (
                  <label
                    key={item.value}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5"
                  >
                    <Radio value={item.value} disabled={importing} />
                    <span>
                      <span className="block text-sm font-medium">{item.label}</span>
                      <span className="block text-xs text-muted-foreground">{item.hint}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            )}
            {selected && preview && !preview.sourceExists && (
              <p className="text-xs text-muted-foreground">
                {t('The source project folder no longer exists, so moving is preselected.')}
              </p>
            )}
            {selected && mode === 'copy' && preview && preview.copies > 0 && (
              <p className="text-xs text-warning-foreground dark:text-warning">
                {t(
                  'Already copied here {{count}} times. Copying again adds another independent copy.',
                  { count: preview.copies }
                )}
              </p>
            )}
          </DialogPanel>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button
              onClick={() => void handleImport()}
              disabled={importing || !selected || selected.count === 0}
            >
              {importing ? (
                <Spinner className="mr-1.5 size-3.5" />
              ) : mode === 'move' ? (
                <FolderInput className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Copy className="mr-1.5 h-3.5 w-3.5" />
              )}
              {importing
                ? mode === 'move'
                  ? t('Moving…')
                  : t('Copying…')
                : mode === 'move'
                  ? t('Move here')
                  : t('Copy here')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={emptiedSource !== null}
        onOpenChange={(open) => !open && setEmptiedSource(null)}
        title={t('The old project has no conversations left. Remove it from the list?')}
        description={t(
          '"{{name}}" is only removed from the EnsoCode list. Its folder and files on disk are not deleted.',
          { name: emptiedSource ? emptiedSource.alias || emptiedSource.name : '' }
        )}
        confirmLabel={t('Remove')}
        cancelLabel={t('Keep')}
        onConfirm={() => {
          if (emptiedSource) void removeEmptyProjectFromDialog(emptiedSource.id, t);
        }}
      />
    </>
  );
}

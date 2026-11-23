import type { Project } from '@shared/types';
import { FolderInput } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  importProjectSessionsFromDialog,
  moveConversationTargets,
  projectRootConversationCount,
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
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

interface ImportProjectSessionsDialogProps {
  project: Project | null;
  onClose: () => void;
}

/** 把其他项目的全部会话改挂到当前项目（项目挪路径后找回历史） */
export function ImportProjectSessionsDialog({
  project,
  onClose,
}: ImportProjectSessionsDialogProps) {
  const { t } = useI18n();
  const projects = useSettingsStore((state) => state.projects);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (project) setSelectedId(null);
  }, [project]);

  const candidates = useMemo(() => {
    if (!project) return [];
    const { conversations } = useSessionsStore.getState();
    return moveConversationTargets(projects, project.id).map((candidate) => ({
      project: candidate,
      count: projectRootConversationCount(conversations, candidate.id),
    }));
  }, [project, projects]);

  const handleImport = async () => {
    if (!project || !selectedId) return;
    setImporting(true);
    try {
      if (await importProjectSessionsFromDialog(selectedId, project.id, t)) onClose();
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={project !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Import conversations from another project')}</DialogTitle>
          <DialogDescription>
            {t(
              'All conversations of the selected project, archived ones included, will be moved under {{name}}. Session files stay where they are.',
              { name: project ? project.alias || project.name : '' }
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {candidates.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t('No other projects')}
            </p>
          ) : (
            <div className="flex max-h-80 flex-col overflow-y-auto rounded-lg border">
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
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => void handleImport()} disabled={!selectedId || importing}>
            {importing ? (
              <Spinner className="mr-1.5 size-3.5" />
            ) : (
              <FolderInput className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('Import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

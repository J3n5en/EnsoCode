import { FolderPlus, Paperclip } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { composerAcceptsFiles, ingestComposerFiles } from '@/components/chat/composerMentionBridge';
import { addToast } from '@/components/ui/toast';
import { useOverlayGuard } from '@/hooks/useOverlayGuard';
import { type TFunction, useI18n } from '@/i18n';
import {
  addLocalProject,
  enqueueProjectImport,
  focusImportedProject,
  isNotDirectoryError,
  isSkippableProjectPathError,
  type LocalProjectImport,
} from '@/lib/importLocalProject';
import {
  createDropHighlightTracker,
  type DroppedPath,
  type DropZones,
  dropZonesFor,
  MAX_DROPPED_PROJECTS,
  pickDroppedDirectories,
} from '@/lib/projectDrop';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { showLocalCodeView } from '@/stores/bots/mode';

type Zone = keyof DropZones;

const NO_ZONES: DropZones = { project: false, attach: false };

function zoneAt(target: EventTarget | null): Zone | null {
  const zone = target instanceof Element ? target.closest('[data-drop-zone]') : null;
  const id = zone?.getAttribute('data-drop-zone');
  return id === 'project' || id === 'attach' ? id : null;
}

function pathForDroppedFile(file: File): string {
  try {
    return window.electronAPI.files.pathForFile(file);
  } catch {
    return '';
  }
}

function readDroppedPaths(event: DragEvent): DroppedPath[] {
  const items = event.dataTransfer?.items;
  if (items && items.length > 0) {
    const rows: DroppedPath[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      const path = pathForDroppedFile(file);
      const entry = item.webkitGetAsEntry?.();
      rows.push({
        path,
        isDirectory: entry ? entry.isDirectory : file.size === 0 && file.type === '',
      });
    }
    return rows;
  }
  return Array.from(event.dataTransfer?.files ?? []).map((file) => ({
    path: pathForDroppedFile(file),
    isDirectory: file.size === 0 && file.type === '',
  }));
}

async function importDroppedFolders(rows: readonly DroppedPath[], t: TFunction): Promise<void> {
  const picked = pickDroppedDirectories(rows);
  let skippedFiles = picked.skippedFiles;
  let last: LocalProjectImport | undefined;
  for (const path of picked.directories) {
    try {
      last = (await addLocalProject(path)) ?? last;
    } catch (error) {
      if (isNotDirectoryError(error)) {
        skippedFiles += 1;
        continue;
      }
      if (isSkippableProjectPathError(error)) continue;
      addToast({
        type: 'error',
        title: t('Failed to add project'),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (last) {
    try {
      await focusImportedProject(last);
      showLocalCodeView();
    } catch (error) {
      addToast({
        type: 'error',
        title: t('Failed to add project'),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (picked.directories.length === 0 && skippedFiles === 0) {
    addToast({ type: 'error', title: t('Could not read the path of the dropped folder') });
  }
  if (skippedFiles > 0) {
    addToast({ type: 'info', title: t('Only folders can be added as projects') });
  }
  if (picked.truncated) {
    addToast({
      type: 'info',
      title: t('Only the first {{count}} folders were added', { count: MAX_DROPPED_PROJECTS }),
    });
  }
}

/** 全窗拖入遮罩：落在「新建项目」或「引用到对话」区才执行对应行为；高亮期间压住 WebContentsView guest。 */
export function ProjectDropOverlay(): ReactNode {
  const { t } = useI18n();
  const [active, setActive] = useState(false);
  const [zones, setZones] = useState<DropZones>(NO_ZONES);
  const [hover, setHover] = useState<Zone | null>(null);
  useOverlayGuard(active);

  useEffect(() => {
    if (window.electronAPI.remote) return;

    const tracker = createDropHighlightTracker((next) => {
      setActive(next);
      if (!next) setHover(null);
    });
    const typesOf = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []);
    const hasFiles = (event: DragEvent) => typesOf(event).includes('Files');
    // 拖动中 dataTransfer 受保护，只能读 kind/type；返回是否有可用落区
    const syncZones = (event: DragEvent) => {
      const next = dropZonesFor({
        types: typesOf(event),
        items: Array.from(event.dataTransfer?.items ?? [], (item) => ({
          kind: item.kind,
          type: item.type,
        })),
        composerReady: composerAcceptsFiles(),
      });
      setZones((prev) =>
        prev.project === next.project && prev.attach === next.attach ? prev : next
      );
      return next.project || next.attach;
    };

    // preventDefault 放行 drop：主窗口没有 will-navigate 拦截，否则落空会跳到 file://。
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      tracker.enter(syncZones(event));
    };
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      tracker.over(syncZones(event));
      const zone = zoneAt(event.target);
      setHover((prev) => (prev === zone ? prev : zone));
    };
    const onLeave = () => tracker.leave();
    const onCancel = () => tracker.cancel();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') tracker.cancel();
    };
    const onDrop = (event: DragEvent) => {
      tracker.cancel();
      if (!hasFiles(event)) return;
      event.preventDefault();
      const zone = zoneAt(event.target);
      if (!zone) return;
      event.stopPropagation();
      if (zone === 'attach') {
        ingestComposerFiles(Array.from(event.dataTransfer?.files ?? []));
        return;
      }
      const rows = readDroppedPaths(event);
      void enqueueProjectImport(() => importDroppedFolders(rows, t));
    };

    window.addEventListener('dragenter', onEnter, true);
    window.addEventListener('dragover', onOver, true);
    window.addEventListener('dragleave', onLeave, true);
    window.addEventListener('drop', onDrop, true);
    window.addEventListener('dragend', onCancel, true);
    window.addEventListener('blur', onCancel);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('dragenter', onEnter, true);
      window.removeEventListener('dragover', onOver, true);
      window.removeEventListener('dragleave', onLeave, true);
      window.removeEventListener('drop', onDrop, true);
      window.removeEventListener('dragend', onCancel, true);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('keydown', onKey, true);
      tracker.dispose();
    };
  }, [t]);

  if (!active) return null;
  const items = [
    zones.project && { id: 'project' as const, Icon: FolderPlus, label: t('New project') },
    zones.attach && { id: 'attach' as const, Icon: Paperclip, label: t('Reference in chat') },
  ].filter((item) => item !== false);
  return (
    <div
      className="pointer-events-none fixed inset-0 flex items-center justify-center gap-4 bg-background/70 backdrop-blur-[2px]"
      style={{ zIndex: Z_INDEX.MODAL_BACKDROP }}
    >
      {items.map(({ id, Icon, label }) => (
        <div
          key={id}
          data-drop-zone={id}
          className={cn(
            'pointer-events-auto flex h-40 w-56 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed bg-card text-card-foreground shadow-lg transition-colors duration-150',
            hover === id ? 'border-brand bg-brand/5' : 'border-border'
          )}
        >
          <Icon className={cn('h-8 w-8', hover === id ? 'text-brand' : 'text-muted-foreground')} />
          <p className="text-sm font-medium">{label}</p>
        </div>
      ))}
    </div>
  );
}

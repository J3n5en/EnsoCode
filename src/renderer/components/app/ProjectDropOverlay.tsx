import { FolderPlus } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
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
  MAX_DROPPED_PROJECTS,
  pickDroppedDirectories,
  shouldAcceptProjectDrop,
} from '@/lib/projectDrop';
import { Z_INDEX } from '@/lib/z-index';
import { showLocalCodeView } from '@/stores/bots/mode';

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

/** 全窗拖入文件夹添加项目；高亮期间压住 WebContentsView guest，避免侧栏浏览器吞掉拖放。 */
export function ProjectDropOverlay(): ReactNode {
  const { t } = useI18n();
  const [active, setActive] = useState(false);
  useOverlayGuard(active);

  useEffect(() => {
    if (window.electronAPI.remote) return;

    const tracker = createDropHighlightTracker(setActive);
    const typesOf = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []);
    const hasFiles = (event: DragEvent) => typesOf(event).includes('Files');

    // dragenter/dragover 读不到 entry，只高亮、不拦截；preventDefault 仅为放行 drop。
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      tracker.enter(true);
    };
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      tracker.over(true);
    };
    const onLeave = () => tracker.leave();
    const onCancel = () => tracker.cancel();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') tracker.cancel();
    };
    const onDrop = (event: DragEvent) => {
      tracker.cancel();
      if (!hasFiles(event)) return;
      // 不接管时也要 preventDefault：主窗口没有 will-navigate 拦截，否则会跳到 file://。
      event.preventDefault();
      const rows = readDroppedPaths(event);
      if (!shouldAcceptProjectDrop({ types: typesOf(event), entries: rows })) return;
      event.stopPropagation();
      // drop 不再下发，补一个 dragleave 让沿途拖放区（如 Composer）撤掉自身高亮。
      event.target?.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
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
  return (
    <div
      className="pointer-events-none fixed inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[2px]"
      style={{ zIndex: Z_INDEX.MODAL_BACKDROP }}
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border bg-card px-8 py-6 text-card-foreground shadow-lg">
        <FolderPlus className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">{t('Drop folders to add projects')}</p>
      </div>
    </div>
  );
}

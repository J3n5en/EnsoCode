import { FolderPlus } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { addToast } from '@/components/ui/toast';
import { useOverlayGuard } from '@/hooks/useOverlayGuard';
import { type TFunction, useI18n } from '@/i18n';
import {
  importLocalProject,
  isNotDirectoryError,
  isSkippableProjectPathError,
} from '@/lib/importLocalProject';
import {
  type DroppedPath,
  type ProjectDropItemHint,
  pickDroppedDirectories,
  shouldOfferProjectDrop,
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

function dropItemHints(event: DragEvent): ProjectDropItemHint[] | undefined {
  const items = event.dataTransfer?.items;
  if (!items?.length) return undefined;
  const hints: ProjectDropItemHint[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const entry = item.webkitGetAsEntry?.();
    hints.push({
      kind: item.kind,
      ...(entry ? { isDirectory: entry.isDirectory } : {}),
    });
  }
  return hints;
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

async function importDroppedFolders(event: DragEvent, t: TFunction): Promise<void> {
  const picked = pickDroppedDirectories(readDroppedPaths(event));
  let skippedFiles = picked.skippedFiles;
  let imported = 0;
  for (const path of picked.directories) {
    try {
      const project = await importLocalProject(path);
      if (project) imported += 1;
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
  if (imported > 0) showLocalCodeView();
  if (skippedFiles > 0) {
    addToast({ type: 'info', title: t('Only folders can be added as projects') });
  }
  if (picked.truncated) {
    addToast({ type: 'info', title: t('Only the first 10 folders were added') });
  }
}

/** 全窗拖入文件夹添加项目；高亮期间压住 WebContentsView guest，避免侧栏浏览器吞掉拖放。 */
export function ProjectDropOverlay(): ReactNode {
  const { t } = useI18n();
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const depthRef = useRef(0);
  useOverlayGuard(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (window.electronAPI.remote) return;

    const typesOf = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []);
    const offered = (event: DragEvent) =>
      shouldOfferProjectDrop({ types: typesOf(event), items: dropItemHints(event) });

    const reset = () => {
      depthRef.current = 0;
      setActive(false);
    };

    const onEnter = (event: DragEvent) => {
      if (!offered(event) && !activeRef.current) return;
      event.preventDefault();
      depthRef.current += 1;
      if (!activeRef.current) setActive(true);
    };
    const onOver = (event: DragEvent) => {
      if (!offered(event) && !activeRef.current) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (event: DragEvent) => {
      if (!activeRef.current && !typesOf(event).includes('Files')) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current > 0) return;
      const { clientX, clientY } = event;
      if (
        clientX > 0 &&
        clientY > 0 &&
        clientX < window.innerWidth &&
        clientY < window.innerHeight
      ) {
        return;
      }
      reset();
    };
    const onDrop = (event: DragEvent) => {
      const accept = offered(event) || activeRef.current;
      reset();
      if (!accept) return;
      event.preventDefault();
      event.stopPropagation();
      void importDroppedFolders(event, t);
    };

    window.addEventListener('dragenter', onEnter, true);
    window.addEventListener('dragover', onOver, true);
    window.addEventListener('dragleave', onLeave, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragenter', onEnter, true);
      window.removeEventListener('dragover', onOver, true);
      window.removeEventListener('dragleave', onLeave, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, [t]);

  if (!active) return null;
  return (
    <div
      className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[2px]"
      style={{ zIndex: Z_INDEX.MODAL_BACKDROP }}
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border bg-card px-8 py-6 text-card-foreground shadow-lg">
        <FolderPlus className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">{t('Drop folders to add projects')}</p>
      </div>
    </div>
  );
}

import { FolderPlus } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import {
  composerAcceptsFiles,
  ingestComposerFiles,
  insertComposerPaths,
} from '@/components/chat/composerMentionBridge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
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
  type DropPlan,
  type DroppedEntry,
  MAX_DROPPED_PROJECTS,
  planDrop,
  readDroppedEntries,
} from '@/lib/projectDrop';
import { Z_INDEX } from '@/lib/z-index';
import { showLocalCodeView } from '@/stores/bots/mode';

const SHELF_COMPOSER_RETRY_MS = 200;
const SHELF_COMPOSER_RETRIES = 15;

type PendingDrop = {
  plan: DropPlan<File>;
  /** 「添加到当前会话」投递的全部条目（目录与文件）；会话只绑定一个项目目录，目录也只插入路径引用 */
  attach: File[];
};

function pathForDroppedFile(file: File): string {
  return window.electronAPI.files.pathForFile(file);
}

function uniqueFiles(entries: readonly DroppedEntry<File>[]): File[] {
  const seen = new Set<string>();
  return entries
    .filter((entry) => !seen.has(entry.path) && seen.add(entry.path))
    .map((entry) => entry.file);
}

async function importDroppedFolders(
  directories: readonly string[],
  skipped: number,
  t: TFunction
): Promise<void> {
  let skippedFiles = skipped;
  let last: LocalProjectImport | undefined;
  for (const path of directories) {
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
  if (skippedFiles > 0) {
    addToast({ type: 'info', title: t('Only folders can be added as projects') });
  }
}

/**
 * 全窗拖入：任意位置松开都弹窗选择操作；Composer 等自带 drop 的区域先消费（defaultPrevented）则不打扰。
 * 高亮期间压住 WebContentsView guest，并让 iframe 不接指针。
 */
export function ProjectDropOverlay(): ReactNode {
  const { t } = useI18n();
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState<PendingDrop | null>(null);
  useOverlayGuard(active);

  // 拖放浮窗（macOS 实验功能）：托盘冷启动时 Composer 晚挂载，短暂重试后再提示
  useEffect(() => {
    const api = window.electronAPI;
    if (api.remote) return;
    let disposed = false;
    let retry: number | undefined;
    const attempt = (paths: string[], tries: number) => {
      if (disposed || insertComposerPaths(paths)) return;
      if (tries >= SHELF_COMPOSER_RETRIES) {
        addToast({ type: 'info', title: t('Open a conversation to add files') });
        return;
      }
      retry = window.setTimeout(() => attempt(paths, tries + 1), SHELF_COMPOSER_RETRY_MS);
    };
    const take = () => {
      void api.files.takeShelfDrop().then((deliveries) => {
        for (const { action, paths, skipped = 0 } of deliveries) {
          if (action === 'project') {
            const directories = paths.slice(0, MAX_DROPPED_PROJECTS);
            void enqueueProjectImport(() => importDroppedFolders(directories, skipped, t));
          } else if (paths.length > 0) {
            attempt(paths, 0);
          }
        }
      });
    };
    take();
    const off = api.files.onShelfDrop(take);
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      off();
    };
  }, [t]);

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-file-dragging', active);
    return () => root.removeAttribute('data-file-dragging');
  }, [active]);

  useEffect(() => {
    if (window.electronAPI.remote) return;

    const tracker = createDropHighlightTracker(setActive);
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    // preventDefault 放行 drop，否则落空会尝试导航到 file://。
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
    // 冒泡阶段：目标元素（Composer 等）已处理过的 drop 保持原行为
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
      const entries = readDroppedEntries(event.dataTransfer ?? {}, pathForDroppedFile);
      const plan = planDrop(entries);
      if (!plan) return;
      const canAttach = composerAcceptsFiles();
      if (plan.kind === 'files' && !canAttach) {
        addToast({ type: 'info', title: t('Open a conversation to add files') });
        return;
      }
      setPending({ plan, attach: canAttach ? uniqueFiles(entries) : [] });
    };

    window.addEventListener('dragenter', onEnter, true);
    window.addEventListener('dragover', onOver, true);
    window.addEventListener('dragleave', onLeave, true);
    window.addEventListener('drop', onCancel, true);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onCancel, true);
    window.addEventListener('blur', onCancel);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('dragenter', onEnter, true);
      window.removeEventListener('dragover', onOver, true);
      window.removeEventListener('dragleave', onLeave, true);
      window.removeEventListener('drop', onCancel, true);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onCancel, true);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('keydown', onKey, true);
      tracker.dispose();
    };
  }, [t]);

  const plan = pending?.plan;
  const attach = () => {
    if (pending) ingestComposerFiles(pending.attach);
    setPending(null);
  };
  const openProjects = () => {
    if (plan?.kind === 'projects') {
      const { directories, skippedFiles } = plan;
      void enqueueProjectImport(() => importDroppedFolders(directories, skippedFiles, t));
    }
    setPending(null);
  };

  return (
    <>
      {active && (
        <div
          className="pointer-events-none fixed inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[2px]"
          style={{ zIndex: Z_INDEX.MODAL_BACKDROP }}
        >
          <div className="absolute inset-3 rounded-2xl border-2 border-dashed border-brand" />
          <div className="flex flex-col items-center gap-3 text-brand">
            <FolderPlus className="h-10 w-10" />
            <p className="text-sm font-medium">{t('Release to add')}</p>
          </div>
        </div>
      )}
      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogPopup className="max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {plan?.kind === 'files'
                ? t('Add to current conversation')
                : plan && plan.directories.length > 1
                  ? t('Add {{count}} projects', { count: plan.directories.length })
                  : t('Open as project')}
            </DialogTitle>
            <DialogDescription className="break-all">
              {plan?.kind === 'files' ? plan.names.join(', ') : plan?.directories[0]}
            </DialogDescription>
            {plan?.kind === 'projects' && plan.truncated && (
              <p className="text-xs text-muted-foreground">
                {t('At most {{count}} folders can be added at once', {
                  count: MAX_DROPPED_PROJECTS,
                })}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>{t('Cancel')}</DialogClose>
            {plan?.kind === 'files' ? (
              <Button size="sm" onClick={attach}>
                {t('Add to current conversation')}
              </Button>
            ) : (
              <>
                {pending && pending.attach.length > 0 && (
                  <Button variant="outline" size="sm" onClick={attach}>
                    {t('Add to current conversation')}
                  </Button>
                )}
                <Button size="sm" onClick={openProjects}>
                  {plan && plan.directories.length > 1 ? t('Add all') : t('Open as project')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

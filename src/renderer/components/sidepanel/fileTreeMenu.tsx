import type { ReactElement } from 'react';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useI18n } from '@/i18n';

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

export function isMarkdownRel(rel: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(rel);
}

export function revealLabel(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Mac')) return 'Reveal in Finder';
  if (ua.includes('Linux')) return 'Open Containing Folder';
  return 'Reveal in File Explorer';
}

export type FileTreeTarget =
  | { kind: 'blank' }
  | { kind: 'dir'; rel: string; name: string }
  | { kind: 'file'; rel: string; name: string };

export function FileTreeMenu({
  target,
  local,
  children,
  onNewFile,
  onNewFolder,
  onView,
  onPreview,
  onBrowser,
  onCopyPath,
  onCopyRel,
  onCopyFile,
  onReveal,
  onRename,
  onDelete,
  onSend,
}: {
  target: FileTreeTarget;
  local: boolean;
  children: ReactElement;
  onNewFile: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onView?: (rel: string) => void;
  onPreview?: (rel: string) => void;
  onBrowser?: (rel: string) => void;
  onCopyPath: (rel: string) => void;
  onCopyRel: (rel: string) => void;
  onCopyFile?: (rel: string) => void;
  onReveal?: (rel: string) => void;
  onRename?: (rel: string, name: string) => void;
  onDelete?: (rel: string, name: string) => void;
  onSend?: (rel: string, name: string) => void;
}) {
  const { t } = useI18n();
  const createParent =
    target.kind === 'file' ? parentRel(target.rel) : target.kind === 'dir' ? target.rel : '';
  const pathRel = target.kind === 'blank' ? '' : target.rel;
  const showFileOps = target.kind === 'file';
  const showPathOps = target.kind !== 'blank';
  const showRenameDelete = target.kind !== 'blank';

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children as ReactElement<Record<string, unknown>>} />
      <ContextMenuPopup className="min-w-52">
        <ContextMenuItem onClick={() => onNewFile(createParent)}>{t('New File')}</ContextMenuItem>
        <ContextMenuItem onClick={() => onNewFolder(createParent)}>
          {t('New Folder')}
        </ContextMenuItem>
        {showPathOps && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onCopyPath(pathRel)}>{t('Copy Path')}</ContextMenuItem>
            <ContextMenuItem onClick={() => onCopyRel(pathRel)}>
              {t('Copy Relative Path')}
            </ContextMenuItem>
            {showFileOps && local && onCopyFile && (
              <ContextMenuItem onClick={() => onCopyFile(pathRel)}>{t('Copy')}</ContextMenuItem>
            )}
          </>
        )}
        {showFileOps && (
          <>
            {onView && (
              <ContextMenuItem onClick={() => onView(pathRel)}>{t('View File')}</ContextMenuItem>
            )}
            {local && onBrowser && (
              <ContextMenuItem onClick={() => onBrowser(pathRel)}>
                {t('Open in Browser')}
              </ContextMenuItem>
            )}
            {isMarkdownRel(pathRel) && onPreview && (
              <ContextMenuItem onClick={() => onPreview(pathRel)}>
                {t('Open Markdown Preview')}
              </ContextMenuItem>
            )}
          </>
        )}
        {showPathOps && local && onReveal && (
          <ContextMenuItem onClick={() => onReveal(pathRel)}>{t(revealLabel())}</ContextMenuItem>
        )}
        {showRenameDelete &&
          onRename &&
          onDelete &&
          (target.kind === 'file' || target.kind === 'dir') && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => onRename(target.rel, target.name)}>
                {t('Rename')}
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onClick={() => onDelete(target.rel, target.name)}
              >
                {t('Delete')}
              </ContextMenuItem>
            </>
          )}
        {showFileOps && onSend && (
          <ContextMenuItem
            onClick={() => onSend(pathRel, target.kind === 'file' ? target.name : '')}
          >
            {t('Send to conversation')}
          </ContextMenuItem>
        )}
      </ContextMenuPopup>
    </ContextMenu>
  );
}

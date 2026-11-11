import type { FilesSearchContentHit, FilesSearchMode, FilesSearchResult } from '@shared/types';
import { Files, FileText } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { fileTypeIcon, fileTypeIconClass } from './fileIcons';
import { FileTreeMenu } from './fileTreeMenu';

export interface FilesSearchFileActions {
  local: boolean;
  onPreview: (rel: string) => void;
  onBrowser: (rel: string) => void;
  onCopyPath: (rel: string) => void;
  onCopyRel: (rel: string) => void;
  onCopyFile: (rel: string) => void;
  onReveal: (rel: string) => void;
  onNewFile: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onRename: (rel: string, name: string) => void;
  onDelete: (rel: string, name: string) => void;
  onSend: (rel: string, name: string) => void;
}

interface FilesSearchPaneProps {
  conversationId: string;
  projectId: string;
  onOpenFile: (rel: string) => void;
  onClose: () => void;
  menu: FilesSearchFileActions;
}

export function FilesSearchPane({
  conversationId,
  projectId,
  onOpenFile,
  onClose,
  menu,
}: FilesSearchPaneProps) {
  const { t } = useI18n();
  const seqRef = useRef(0);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<FilesSearchMode>('names');
  const [result, setResult] = useState<FilesSearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      seqRef.current += 1;
      setResult(null);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void window.electronAPI.workspaceFiles
        .search({ conversationId, projectId, query, mode })
        .then((next) => {
          if (seq !== seqRef.current) return;
          setResult(next);
          setLoading(false);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [conversationId, mode, projectId, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1 px-1 pb-1">
        <Input
          size="sm"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
          }}
          placeholder={mode === 'names' ? t('Search file names') : t('Search file contents')}
          aria-label={t('Search')}
        />
        <div className="flex gap-0.5">
          <ModeButton
            active={mode === 'names'}
            onClick={() => setMode('names')}
            label={t('File name')}
            icon={Files}
          />
          <ModeButton
            active={mode === 'content'}
            onClick={() => setMode('content')}
            label={t('Content')}
            icon={FileText}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-1">
        {!query.trim() ? (
          <p className="px-1 py-2 text-muted-foreground text-xs">
            {t('Type to search this workspace.')}
          </p>
        ) : loading && !result ? (
          <p className="px-1 py-2 text-muted-foreground text-xs">{t('Searching…')}</p>
        ) : result && !result.ok ? (
          <p className="px-1 py-2 text-muted-foreground text-xs">
            {t(searchErrorMessage(result.error))}
          </p>
        ) : result?.ok && result.hits.length === 0 ? (
          <p className="px-1 py-2 text-muted-foreground text-xs">{t('No results')}</p>
        ) : result?.ok && result.mode === 'names' ? (
          result.hits.map((hit) => {
            const Icon = fileTypeIcon(hit.name, false);
            return (
              <SearchFileMenu
                key={hit.relativePath}
                rel={hit.relativePath}
                name={hit.name}
                menu={menu}
                onOpenFile={onOpenFile}
              >
                <button
                  type="button"
                  data-search-hit={hit.relativePath}
                  className="flex w-full items-start gap-1 rounded-sm px-1 py-0.5 text-left hover:bg-muted"
                  onClick={() => onOpenFile(hit.relativePath)}
                >
                  <Icon
                    className={cn('mt-0.5 size-3.5 shrink-0', fileTypeIconClass(hit.name, false))}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-xs">{hit.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {hit.relativePath}
                    </span>
                  </span>
                </button>
              </SearchFileMenu>
            );
          })
        ) : result?.ok && result.mode === 'content' ? (
          result.hits.map((hit) => {
            const name = hit.relativePath.split('/').pop() || hit.relativePath;
            return (
              <SearchFileMenu
                key={contentKey(hit)}
                rel={hit.relativePath}
                name={name}
                menu={menu}
                onOpenFile={onOpenFile}
              >
                {contentHitButton(hit, onOpenFile)}
              </SearchFileMenu>
            );
          })
        ) : null}
      </div>
    </div>
  );
}

function contentKey(hit: FilesSearchContentHit): string {
  return `${hit.relativePath}:${hit.line}:${hit.column}`;
}

function contentHitButton(hit: FilesSearchContentHit, onOpenFile: (rel: string) => void) {
  const name = hit.relativePath.split('/').pop() || hit.relativePath;
  const Icon = fileTypeIcon(name, false);
  return (
    <button
      type="button"
      data-search-hit={contentKey(hit)}
      className="flex w-full items-start gap-1 rounded-sm px-1 py-0.5 text-left hover:bg-muted"
      onClick={() => onOpenFile(hit.relativePath)}
    >
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', fileTypeIconClass(name, false))} />
      <span className="min-w-0">
        <span className="block truncate text-xs">
          {name}
          <span className="text-muted-foreground">:{hit.line}</span>
        </span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground">
          {hit.content.trim()}
        </span>
      </span>
    </button>
  );
}

function SearchFileMenu({
  rel,
  name,
  menu,
  onOpenFile,
  children,
}: {
  rel: string;
  name: string;
  menu: FilesSearchFileActions;
  onOpenFile: (rel: string) => void;
  children: ReactElement;
}) {
  return (
    <FileTreeMenu
      target={{ kind: 'file', rel, name }}
      local={menu.local}
      onNewFile={menu.onNewFile}
      onNewFolder={menu.onNewFolder}
      onView={onOpenFile}
      onPreview={menu.onPreview}
      onBrowser={menu.onBrowser}
      onCopyPath={menu.onCopyPath}
      onCopyRel={menu.onCopyRel}
      onCopyFile={menu.onCopyFile}
      onReveal={menu.onReveal}
      onRename={menu.onRename}
      onDelete={menu.onDelete}
      onSend={menu.onSend}
    >
      {children}
    </FileTreeMenu>
  );
}

/** Main 返回的错误码 → 用户能据以行动的提示；未知码兜底成通用文案 */
function searchErrorMessage(error: string): string {
  switch (error) {
    case 'unsupported':
      return 'Search is not available for SSH workspaces.';
    case 'rg-missing':
      return 'Search needs ripgrep (rg). Install it and make sure it is on PATH.';
    case 'timeout':
      return 'Search timed out. Try a more specific query or a smaller folder.';
    default:
      return 'Could not complete the file action.';
  }
}

function ModeButton({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: typeof Files;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn('h-6 flex-1 px-1 text-xs', active && 'bg-muted')}
      aria-pressed={active}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
      {label}
    </Button>
  );
}

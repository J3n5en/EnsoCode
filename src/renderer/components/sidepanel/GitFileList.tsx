import type { GitFile } from '@shared/types/git';
import { ChevronDown, Folder, FolderOpen, List, ListTree } from 'lucide-react';
import { Fragment, type ReactNode, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

type Directory = {
  name: string;
  path: string;
  directories: Map<string, Directory>;
  files: GitFile[];
};

export function GitFileViewToggle({ tree, onToggle }: { tree: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const label = t(tree ? 'List view' : 'Tree view');
  return (
    <Button variant="ghost" size="icon-xs" title={label} aria-label={label} onClick={onToggle}>
      {tree ? <List className="size-3.5" /> : <ListTree className="size-3.5" />}
    </Button>
  );
}

export function GitFileList({
  files,
  tree,
  children,
}: {
  files: GitFile[];
  tree: boolean;
  children: (file: GitFile) => ReactNode;
}) {
  const id = useId();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const root = useMemo(() => {
    const root: Directory = { name: '', path: '', directories: new Map(), files: [] };
    if (!tree) return root;
    for (const file of files) {
      const segments = file.path.split('/');
      let directory = root;
      for (const name of segments.slice(0, -1)) {
        let child = directory.directories.get(name);
        if (!child) {
          child = {
            name,
            path: directory.path ? `${directory.path}/${name}` : name,
            directories: new Map(),
            files: [],
          };
          directory.directories.set(name, child);
        }
        directory = child;
      }
      directory.files.push(file);
    }
    return root;
  }, [files, tree]);

  const renderDirectory = (directory: Directory): ReactNode => (
    <>
      {[...directory.directories.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => {
          const expanded = !collapsed.has(child.path);
          const contentId = `${id}-${encodeURIComponent(child.path)}`;
          return (
            <div key={`directory:${child.path}`}>
              <button
                type="button"
                title={child.path}
                aria-expanded={expanded}
                aria-controls={expanded ? contentId : undefined}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(child.path)) next.delete(child.path);
                    else next.add(child.path);
                    return next;
                  })
                }
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn('size-3 shrink-0 text-muted-foreground', !expanded && '-rotate-90')}
                />
                {expanded ? (
                  <FolderOpen aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{child.name}</span>
              </button>
              {expanded && (
                <div id={contentId} className="ml-3 min-w-0 border-l pl-1">
                  {renderDirectory(child)}
                </div>
              )}
            </div>
          );
        })}
      {directory.files
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => (
          <Fragment key={`file:${file.path}`}>{children(file)}</Fragment>
        ))}
    </>
  );

  return tree
    ? renderDirectory(root)
    : files.map((file) => <Fragment key={file.path}>{children(file)}</Fragment>);
}

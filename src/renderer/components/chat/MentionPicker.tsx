import type { MentionCandidate } from '@shared/types/mentions';
import { Bot, ChevronRight, FileText, History } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { flattenMentionRoot, type MentionSearchGroups } from '@/hooks/useMentionSearch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

type FolderId = 'agents' | 'chats';

interface MentionPickerProps {
  groups: MentionSearchGroups;
  query: string;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  openFolderId: FolderId | null;
  folderIndex: number;
  onOpenFolderIdChange: (id: FolderId | null) => void;
  onFolderIndexChange: (index: number) => void;
  onSelect: (candidate: MentionCandidate) => void;
  id?: string;
  left?: number;
  flyoutSide?: 'left' | 'right';
}

export function MentionPicker({
  groups,
  query,
  activeIndex,
  onActiveIndexChange,
  openFolderId,
  folderIndex,
  onOpenFolderIdChange,
  onFolderIndexChange,
  onSelect,
  id = 'composer-mention-picker',
  left = 0,
  flyoutSide = 'right',
}: MentionPickerProps) {
  const { t } = useI18n();
  const items = useMemo(() => flattenMentionRoot(groups, query), [groups, query]);
  const optionRefs = useRef(new Map<number, HTMLButtonElement>());
  const subRefs = useRef(new Map<number, HTMLButtonElement>());
  const nested = items[0]?.type === 'folder';

  useEffect(() => {
    optionRefs.current.get(activeIndex)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  useEffect(() => {
    if (!openFolderId) return;
    subRefs.current.get(folderIndex)?.scrollIntoView({ block: 'nearest' });
  }, [openFolderId, folderIndex]);

  if (items.length === 0) return null;
  const folderLabels: Record<FolderId, string> = { agents: t('Agents'), chats: t('Chats') };
  const folderIcons: Record<FolderId, typeof Bot> = { agents: Bot, chats: History };
  const folderItems = openFolderId ? groups[openFolderId] : [];
  let flatIndex = 0;

  const renderGroup = (group: 'agents' | 'chats' | 'files', pad: boolean) => {
    const candidates = groups[group];
    if (candidates.length === 0) return null;
    const label = group === 'files' ? t('Files') : folderLabels[group as FolderId];
    return (
      <div role="group" aria-label={label}>
        <p
          className={cn(
            'px-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase',
            pad ? 'pt-2' : 'pt-1.5'
          )}
        >
          {label}
        </p>
        {candidates.map((candidate) => {
          const index = flatIndex++;
          return (
            <MentionOption
              key={`${group}:${candidate.id}`}
              ref={(node) => {
                if (node) optionRefs.current.set(index, node);
                else optionRefs.current.delete(index);
              }}
              id={`${id}-option-${index}`}
              candidate={candidate}
              active={index === activeIndex}
              onHover={() => {
                onActiveIndexChange(index);
                if (nested) onOpenFolderIdChange(null);
              }}
              onSelect={() => onSelect(candidate)}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div
      data-slot="mention-picker"
      className="absolute bottom-full z-10 mb-1.5 max-w-full"
      style={{ left }}
    >
      <div
        id={id}
        role="listbox"
        aria-label={t('Mention suggestions')}
        className="max-h-72 w-80 max-w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
      >
        {nested ? (
          <>
            {items
              .filter((item): item is { type: 'folder'; id: FolderId } => item.type === 'folder')
              .map((folder) => {
                const index = flatIndex++;
                const Icon = folderIcons[folder.id];
                return (
                  <button
                    key={`folder:${folder.id}`}
                    ref={(node) => {
                      if (node) optionRefs.current.set(index, node);
                      else optionRefs.current.delete(index);
                    }}
                    id={`${id}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={activeIndex === index}
                    onClick={() => {
                      onActiveIndexChange(index);
                      onOpenFolderIdChange(folder.id);
                      onFolderIndexChange(0);
                    }}
                    onMouseMove={() => {
                      onActiveIndexChange(index);
                      if (openFolderId !== folder.id) {
                        onOpenFolderIdChange(folder.id);
                        onFolderIndexChange(0);
                      }
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                      activeIndex === index && 'bg-foreground/10'
                    )}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1 font-medium">{folderLabels[folder.id]}</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                );
              })}
            {renderGroup('files', true)}
          </>
        ) : (
          <>
            {renderGroup('agents', false)}
            {renderGroup('chats', groups.agents.length > 0)}
            {renderGroup('files', groups.agents.length > 0 || groups.chats.length > 0)}
          </>
        )}
      </div>
      {openFolderId && folderItems.length > 0 && (
        <div
          role="listbox"
          aria-label={folderLabels[openFolderId]}
          data-slot="mention-flyout"
          className={cn(
            'absolute top-0 z-20 max-h-72 w-72 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md',
            flyoutSide === 'right' ? 'left-full ml-1' : 'right-full mr-1'
          )}
        >
          {folderItems.map((candidate, index) => (
            <MentionOption
              key={`sub:${candidate.id}`}
              ref={(node) => {
                if (node) subRefs.current.set(index, node);
                else subRefs.current.delete(index);
              }}
              id={`${id}-sub-${index}`}
              candidate={candidate}
              active={index === folderIndex}
              onHover={() => onFolderIndexChange(index)}
              onSelect={() => onSelect(candidate)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MentionOption({
  ref,
  id,
  candidate,
  active,
  onHover,
  onSelect,
}: {
  id: string;
  ref: React.Ref<HTMLButtonElement>;
  candidate: MentionCandidate;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const Icon =
    candidate.kind === 'agent-type' ? Bot : candidate.kind === 'chat' ? History : FileText;
  return (
    <button
      ref={ref}
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      onClick={onSelect}
      // onMouseMove 而非 onMouseEnter：键盘导航的 scrollIntoView 会让项目从静止的
      // 物理光标下滑过，Chrome 重算 hover 触发 mouseenter 会把高亮拽回光标处；
      // mousemove 只在物理移动时触发，不和键盘打架。
      onMouseMove={onHover}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
        // 浅色主题下 popover(纯白)与 muted 亮度差仅 0.035，高亮几乎不可见；
        // 用前景色衍生的透明度保证两种主题都有对比度。
        active && 'bg-foreground/10'
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="shrink-0 font-medium">{candidate.label}</span>
          <Badge variant="outline" className="px-1 py-0 text-[9px]">
            {candidate.kind === 'agent-type'
              ? t(
                  candidate.source === 'system'
                    ? 'System'
                    : candidate.source === 'builtin'
                      ? 'Built-in'
                      : 'Custom'
                )
              : candidate.kind === 'chat'
                ? t('Chat')
                : t('File')}
          </Badge>
          {candidate.kind === 'agent-type' && candidate.locked && (
            <Badge variant="secondary" className="px-1 py-0 text-[9px]">
              {t('Locked')}
            </Badge>
          )}
        </span>
        <span className="block truncate text-muted-foreground">
          {candidate.kind === 'agent-type'
            ? t(candidate.description)
            : candidate.kind === 'chat'
              ? candidate.sessionFile.split('/').at(-1)
              : candidate.relativePath}
        </span>
      </span>
    </button>
  );
}

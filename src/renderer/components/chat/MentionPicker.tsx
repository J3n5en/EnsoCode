import type { MentionCandidate } from '@shared/types/mentions';
import { Bot, ChevronRight, FileText } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { flattenMentionRoot, type MentionSearchGroups } from '@/hooks/useMentionSearch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface MentionPickerProps {
  groups: MentionSearchGroups;
  query: string;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  folderOpen: boolean;
  folderIndex: number;
  onFolderOpenChange: (open: boolean) => void;
  onFolderIndexChange: (index: number) => void;
  onSelect: (candidate: MentionCandidate) => void;
  id?: string;
}

export function MentionPicker({
  groups,
  query,
  activeIndex,
  onActiveIndexChange,
  folderOpen,
  folderIndex,
  onFolderOpenChange,
  onFolderIndexChange,
  onSelect,
  id = 'composer-mention-picker',
}: MentionPickerProps) {
  const { t } = useI18n();
  const items = useMemo(() => flattenMentionRoot(groups, query), [groups, query]);
  const optionRefs = useRef(new Map<number, HTMLButtonElement>());
  const agentRefs = useRef(new Map<number, HTMLButtonElement>());
  const nestAgents = items[0]?.type === 'folder';

  useEffect(() => {
    optionRefs.current.get(activeIndex)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  useEffect(() => {
    if (!folderOpen) return;
    agentRefs.current.get(folderIndex)?.scrollIntoView({ block: 'nearest' });
  }, [folderOpen, folderIndex]);

  if (items.length === 0) return null;
  let flatIndex = nestAgents ? 1 : 0;

  return (
    <div className="absolute bottom-full left-0 z-10 mb-1.5">
      <div
        id={id}
        role="listbox"
        aria-label={t('Mention suggestions')}
        className="max-h-72 w-80 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
      >
        {nestAgents ? (
          <>
            <button
              ref={(node) => {
                if (node) optionRefs.current.set(0, node);
                else optionRefs.current.delete(0);
              }}
              id={`${id}-option-0`}
              type="button"
              role="option"
              aria-selected={activeIndex === 0}
              onClick={() => {
                onActiveIndexChange(0);
                onFolderOpenChange(true);
                onFolderIndexChange(0);
              }}
              onMouseMove={() => {
                onActiveIndexChange(0);
                onFolderOpenChange(true);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                activeIndex === 0 && 'bg-foreground/10'
              )}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background">
                <Bot className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
              <span className="min-w-0 flex-1 font-medium">{t('Agents')}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
            {groups.files.length > 0 && (
              <div role="group" aria-label={t('Files')}>
                <p className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {t('Files')}
                </p>
                {groups.files.map((candidate) => {
                  const index = flatIndex++;
                  return (
                    <MentionOption
                      key={`file:${candidate.id}`}
                      ref={(node) => {
                        if (node) optionRefs.current.set(index, node);
                        else optionRefs.current.delete(index);
                      }}
                      id={`${id}-option-${index}`}
                      candidate={candidate}
                      active={index === activeIndex}
                      onHover={() => {
                        onActiveIndexChange(index);
                        onFolderOpenChange(false);
                      }}
                      onSelect={() => onSelect(candidate)}
                    />
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <>
            {groups.agents.length > 0 && (
              <div role="group" aria-label={t('Agents')}>
                <p className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {t('Agents')}
                </p>
                {groups.agents.map((candidate) => {
                  const index = flatIndex++;
                  return (
                    <MentionOption
                      key={`agent:${candidate.id}`}
                      ref={(node) => {
                        if (node) optionRefs.current.set(index, node);
                        else optionRefs.current.delete(index);
                      }}
                      id={`${id}-option-${index}`}
                      candidate={candidate}
                      active={index === activeIndex}
                      onHover={() => onActiveIndexChange(index)}
                      onSelect={() => onSelect(candidate)}
                    />
                  );
                })}
              </div>
            )}
            {groups.files.length > 0 && (
              <div role="group" aria-label={t('Files')}>
                <p className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {t('Files')}
                </p>
                {groups.files.map((candidate) => {
                  const index = flatIndex++;
                  return (
                    <MentionOption
                      key={`file:${candidate.id}`}
                      ref={(node) => {
                        if (node) optionRefs.current.set(index, node);
                        else optionRefs.current.delete(index);
                      }}
                      id={`${id}-option-${index}`}
                      candidate={candidate}
                      active={index === activeIndex}
                      onHover={() => onActiveIndexChange(index)}
                      onSelect={() => onSelect(candidate)}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      {nestAgents && folderOpen && groups.agents.length > 0 && (
        <div
          role="listbox"
          aria-label={t('Agents')}
          className="absolute top-0 left-full z-20 ml-1 max-h-72 w-72 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
        >
          {groups.agents.map((candidate, index) => (
            <MentionOption
              key={`agent:${candidate.id}`}
              ref={(node) => {
                if (node) agentRefs.current.set(index, node);
                else agentRefs.current.delete(index);
              }}
              id={`${id}-agent-${index}`}
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
  const Icon = candidate.kind === 'agent-type' ? Bot : FileText;
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
              : t('File')}
          </Badge>
          {candidate.kind === 'agent-type' && candidate.locked && (
            <Badge variant="secondary" className="px-1 py-0 text-[9px]">
              {t('Locked')}
            </Badge>
          )}
        </span>
        <span className="block truncate text-muted-foreground">
          {candidate.kind === 'agent-type' ? t(candidate.description) : candidate.relativePath}
        </span>
      </span>
    </button>
  );
}

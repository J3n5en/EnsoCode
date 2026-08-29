import type { MentionCandidate } from '@shared/types/mentions';
import { Bot, FileText } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { flattenMentionGroups, type MentionSearchGroups } from '@/hooks/useMentionSearch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface MentionPickerProps {
  groups: MentionSearchGroups;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (candidate: MentionCandidate) => void;
  id?: string;
}

export function MentionPicker({
  groups,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  id = 'composer-mention-picker',
}: MentionPickerProps) {
  const { t } = useI18n();
  const items = useMemo(() => flattenMentionGroups(groups), [groups]);
  const optionRefs = useRef(new Map<number, HTMLButtonElement>());

  useEffect(() => {
    optionRefs.current.get(activeIndex)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (items.length === 0) return null;
  let flatIndex = 0;

  return (
    <div
      id={id}
      role="listbox"
      aria-label={t('Mention suggestions')}
      className="absolute bottom-full left-0 z-10 mb-1.5 max-h-72 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
    >
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
                onMouseEnter={() => onActiveIndexChange(index)}
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
                onMouseEnter={() => onActiveIndexChange(index)}
                onSelect={() => onSelect(candidate)}
              />
            );
          })}
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
  onMouseEnter,
  onSelect,
}: {
  id: string;
  ref: React.Ref<HTMLButtonElement>;
  candidate: MentionCandidate;
  active: boolean;
  onMouseEnter: () => void;
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
      onMouseEnter={onMouseEnter}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
        active && 'bg-muted'
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

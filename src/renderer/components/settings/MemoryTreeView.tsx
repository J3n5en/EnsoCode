import type { TreeNodeDto } from '@shared/memory/graphDto';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/i18n';

/**
 * 知识树：一层分组 + 组内记忆，可展开折叠。
 * 勾选记忆用于结晶（≥3 条才能合成），所以选择状态提到外层管理。
 */
export function MemoryTreeView({
  tree,
  loading,
  selected,
  onToggle,
  onInterpretGroup,
  interpreting,
}: {
  tree: TreeNodeDto[];
  loading: boolean;
  selected: ReadonlySet<string>;
  onToggle: (memoryId: string) => void;
  onInterpretGroup: (node: TreeNodeDto) => void;
  interpreting: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());

  if (tree.length === 0) {
    return (
      <p className="py-6 text-[13px] text-muted-foreground">
        {loading ? t('Loading…') : t('No memories yet.')}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border/60">
      {tree.map((group) => {
        const expanded = open.has(group.id);
        const memoryIds = (group.children ?? [])
          .map((c) => c.memoryId)
          .filter((id): id is string => Boolean(id));
        return (
          <li key={group.id}>
            <div className="flex items-center justify-between gap-3 py-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  const next = new Set(open);
                  if (!next.delete(group.id)) next.add(group.id);
                  setOpen(next);
                }}
              >
                <p className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{expanded ? '▾' : '▸'}</span>
                  <span className="truncate">{group.label}</span>
                  <Badge variant="secondary">{group.count}</Badge>
                </p>
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
                disabled={interpreting || memoryIds.length === 0}
                onClick={() => onInterpretGroup(group)}
              >
                {t('Interpret')}
              </Button>
            </div>
            {expanded && (
              <ul className="divide-y border-t bg-muted/20 pl-6">
                {(group.children ?? []).map((child) => (
                  <li key={child.id} className="flex items-center gap-2 py-2 pr-2">
                    {child.memoryId && (
                      <Checkbox
                        checked={selected.has(child.memoryId)}
                        onCheckedChange={() => child.memoryId && onToggle(child.memoryId)}
                        aria-label={t('Select memory')}
                      />
                    )}
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {child.isCrystal && <span title={t('Crystal')}>★</span>}
                      <span className="truncate text-sm">{child.label}</span>
                    </span>
                  </li>
                ))}
                {group.count > (group.children?.length ?? 0) && (
                  <li className="py-2 text-muted-foreground text-xs">
                    {t('Showing {{shown}} of {{total}}', {
                      shown: String(group.children?.length ?? 0),
                      total: String(group.count),
                    })}
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

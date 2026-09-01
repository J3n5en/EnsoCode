import { Search } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';

export function matchesFilter(query: string, parts: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return parts.some((part) => part?.toLowerCase().includes(q));
}

export function useVisibleSelection(visibleIds: string[]) {
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const selectedIds = visibleIds.filter((id) => selected.has(id));
  const allSelected = visibleIds.length > 0 && selectedIds.length === visibleIds.length;
  const someSelected = selectedIds.length > 0 && !allSelected;

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  return { selectedIds, allSelected, someSelected, toggleOne, toggleAll, isSelected: (id: string) => selected.has(id) };
}

export function ListFilterBar({
  query,
  onQueryChange,
  placeholder,
  allSelected = false,
  someSelected = false,
  onToggleSelectAll,
  onEnable,
  onDisable,
  selectDisabled,
  actionDisabled,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  allSelected?: boolean;
  someSelected?: boolean;
  onToggleSelectAll?: (selected: boolean) => void;
  onEnable?: () => void;
  onDisable?: () => void;
  selectDisabled?: boolean;
  actionDisabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <div className="flex w-full items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          className="h-8 text-xs [&_input]:pl-8"
        />
      </div>
      {onToggleSelectAll != null && (
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          disabled={selectDisabled}
          aria-label={t('Select all')}
          onCheckedChange={(checked) => onToggleSelectAll(checked)}
        />
      )}
      {onEnable != null && onDisable != null && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            disabled={actionDisabled}
            onClick={onEnable}
          >
            {t('Enable')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            disabled={actionDisabled}
            onClick={onDisable}
          >
            {t('Disable')}
          </Button>
        </>
      )}
    </div>
  );
}

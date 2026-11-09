import { useDndContext, useDroppable } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import {
  ALL_GROUP_ID,
  type ProjectGroup,
  RECENT_GROUP_ID,
  UNGROUPED_GROUP_ID,
} from '@shared/projectGroups';
import { Check, ChevronDown, Pencil, Plus, TextSearch, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type DragPayload, selectorGroupDropId } from '@/components/chat/dragDrop';
import { indicatorOffset } from '@/components/chat/groupChipIndicator';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

/** 侧栏弹层里的操作行（与节点切换器的行一致） */
const POPOVER_ROW_CLASS =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors';

const BAR_ICON_CLASS =
  'flex size-4.5 shrink-0 items-center justify-center rounded-[5px] text-subtle-foreground transition-colors hover:bg-foreground/5 hover:text-foreground';
/** ⌄ 自身宽度 + 间距：按「没有 ⌄ 时」判断是否放得下，否则 ⌄ 占的位置会让它一直不消失 */
const OVERFLOW_TRIGGER_SPACE = 24;
const EDGE_FADE = 20;

interface GroupChipsProps {
  groups: readonly ProjectGroup[];
  selectedId: string;
  counts: Record<string, number>;
  totalCount: number;
  recentCount: number;
  ungroupedCount: number;
  query: string;
  onQueryChange: (query: string) => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onAddGroup: () => void;
  onEditGroup: (id: string) => void;
}

/** 侧栏分类条：横滑、拖动排序、接收项目拖入；放不下时出现 ⌄ 列出全部分组；搜索展开时就地换成搜索框 */
export function GroupChips({
  groups,
  selectedId,
  counts,
  totalCount,
  recentCount,
  ungroupedCount,
  query,
  onQueryChange,
  searchOpen,
  onSearchOpenChange,
  onSelect,
  onAddGroup,
  onEditGroup,
}: GroupChipsProps) {
  const { t } = useI18n();
  const ordered = groups.slice().sort((a, b) => a.order - b.order);
  const hasGroups = ordered.length > 0;
  const showSearch = searchOpen || query.length > 0;
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false, overflow: false });
  // 拖动分组时父组件要跟着重排下划线
  const { active } = useDndContext();

  const selectedGroup = ordered.find((group) => group.id === selectedId);
  const selectedLabel =
    selectedId === UNGROUPED_GROUP_ID ? t('Ungrouped') : (selectedGroup?.name ?? null);
  const placeholder = selectedLabel
    ? t('Search in {{group}}...', { group: selectedLabel })
    : t('Search conversations...');

  // 下划线不能用按钮的 ::after：滚动容器 overflow 会裁掉伸出底边的部分，
  // 而它必须盖住底部分割线，底边才和分割线重合。
  const placeIndicator = useCallback(() => {
    const row = rowRef.current;
    const scroll = scrollRef.current;
    const track = trackRef.current;
    const indicator = indicatorRef.current;
    const chip = scroll?.querySelector<HTMLElement>('[data-selected]');
    if (!row || !scroll || !track || !indicator || !chip || row.offsetParent === null) {
      if (indicator) indicator.style.width = '0px';
      return;
    }
    const scrollRect = scroll.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    const frame = indicatorOffset(chipRect, scrollRect.left);
    track.style.left = `${scrollRect.left - rowRect.left}px`;
    track.style.width = `${scrollRect.width}px`;
    indicator.style.transform = `translateX(${frame.x}px)`;
    indicator.style.width = `${frame.width}px`;
  }, []);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    placeIndicator();
    // 搜索展开时标签条隐藏，宽度为 0，保留上次结果
    if (!el || el.clientWidth === 0) return;
    setEdges((prev) => {
      const reclaim = prev.overflow ? OVERFLOW_TRIGGER_SPACE : 0;
      const next = {
        left: el.scrollLeft > 1,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
        overflow: el.scrollWidth > el.clientWidth + reclaim + 1,
      };
      return prev.left === next.left && prev.right === next.right && prev.overflow === next.overflow
        ? prev
        : next;
    });
  }, [placeIndicator]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);

  // 选中、展开搜索、拖动分组都会挪动标签，但测量只读 DOM
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是重测触发信号
  useLayoutEffect(() => {
    placeIndicator();
  }, [placeIndicator, active, selectedId, showSearch, ordered.length]);

  // 竖向滚轮转横滑：React 的 onWheel 是 passive，拦不住默认滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 选中的标签滚进可见区（从 ⌄ 里选了被藏住的分组时）
  const scrolledOnce = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 选中项变化时重新对齐
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const chip = el?.querySelector<HTMLElement>('[data-selected]');
    if (!el || !chip || el.clientWidth === 0) return;
    const behavior = scrolledOnce.current ? 'smooth' : 'auto';
    scrolledOnce.current = true;
    const start = chip.offsetLeft;
    const end = start + chip.offsetWidth;
    if (start < el.scrollLeft + EDGE_FADE) el.scrollTo({ left: start - EDGE_FADE, behavior });
    else if (end > el.scrollLeft + el.clientWidth - EDGE_FADE)
      el.scrollTo({ left: end - el.clientWidth + EDGE_FADE, behavior });
  }, [selectedId, hasGroups, searchOpen]);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = () => {
    onQueryChange('');
    onSearchOpenChange(false);
  };

  const fade = (on: boolean) => (on ? `${EDGE_FADE}px` : '0px');
  const maskImage =
    edges.left || edges.right
      ? `linear-gradient(to right, transparent, #000 ${fade(edges.left)}, #000 calc(100% - ${fade(edges.right)}), transparent)`
      : undefined;

  return (
    <div className="group/bar shrink-0">
      {/* 35px + 1px 分割线 = 会话 tab 条 ChromeRow 的 36px；用 px，不随 rem 缩放，两条底线才能接上 */}
      <div className="relative z-[1] flex h-[35px] items-end gap-1.5 px-3.5">
        {showSearch && (
          <label className="mb-1 flex h-7 min-w-0 flex-1 cursor-text items-center gap-2 rounded-lg border border-transparent bg-foreground/5 pr-0.5 pl-2.5 text-xs text-muted-foreground transition-colors focus-within:border-brand/45">
            <TextSearch className="size-3.5 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                closeSearch();
              }}
              onBlur={() => {
                // 切走窗口也会失焦，此时不收起
                if (!query && document.hasFocus()) onSearchOpenChange(false);
              }}
              placeholder={placeholder}
              className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={closeSearch}
              className="flex size-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-foreground/5 hover:text-foreground"
              title={t('Close')}
              aria-label={t('Close')}
            >
              <X className="size-3" />
            </button>
          </label>
        )}
        <div
          ref={rowRef}
          className={cn(
            'relative flex min-w-0 flex-1 items-center gap-1.5',
            showSearch && 'hidden'
          )}
        >
          <div
            ref={scrollRef}
            onScroll={measure}
            style={{ maskImage }}
            className="min-w-0 overflow-x-auto [scrollbar-width:none]"
          >
            <div className="flex w-max gap-3.5">
              <button
                type="button"
                data-enso="group-chip"
                data-selected={selectedId === ALL_GROUP_ID || undefined}
                data-active={selectedId === ALL_GROUP_ID || undefined}
                onClick={() => onSelect(ALL_GROUP_ID)}
                className={tabClass(selectedId === ALL_GROUP_ID, false)}
              >
                <TabContent label={t('All')} count={totalCount} />
              </button>
              <button
                type="button"
                data-enso="group-chip"
                data-selected={selectedId === RECENT_GROUP_ID || undefined}
                data-active={selectedId === RECENT_GROUP_ID || undefined}
                onClick={() => onSelect(RECENT_GROUP_ID)}
                className={tabClass(selectedId === RECENT_GROUP_ID, false)}
              >
                <TabContent label={t('Recent')} count={recentCount} />
              </button>
              <SortableContext
                items={ordered.map((group) => selectorGroupDropId(group.id))}
                strategy={horizontalListSortingStrategy}
              >
                {ordered.map((group) => (
                  <SortableGroupChip
                    key={group.id}
                    group={group}
                    count={counts[group.id] ?? 0}
                    selected={selectedId === group.id}
                    onSelect={() => onSelect(group.id)}
                  />
                ))}
              </SortableContext>
              {hasGroups && (
                <UngroupedChip
                  label={t('Ungrouped')}
                  count={ungroupedCount}
                  selected={selectedId === UNGROUPED_GROUP_ID}
                  onSelect={() => onSelect(UNGROUPED_GROUP_ID)}
                />
              )}
            </div>
          </div>
          <span
            ref={trackRef}
            aria-hidden
            className="pointer-events-none absolute -bottom-px z-10 h-[1.5px] overflow-hidden"
          >
            <span
              ref={indicatorRef}
              className="absolute top-0 left-0 h-full rounded-full bg-foreground"
            />
          </span>
          <button
            type="button"
            onClick={onAddGroup}
            className={cn(
              BAR_ICON_CLASS,
              'opacity-0 focus-visible:opacity-100 group-hover/bar:opacity-100 [@media(hover:none)]:opacity-100'
            )}
            title={t('New group')}
            aria-label={t('New group')}
          >
            <Plus className="size-3" />
          </button>
          {edges.overflow && (
            <GroupMenu
              groups={ordered}
              selectedId={selectedId}
              counts={counts}
              totalCount={totalCount}
              recentCount={recentCount}
              ungroupedCount={ungroupedCount}
              onSelect={onSelect}
              onAddGroup={onAddGroup}
              onEditGroup={onEditGroup}
            />
          )}
        </div>
      </div>
      <div className="mx-3.5 h-px bg-border" />
    </div>
  );
}

function tabClass(selected: boolean, dropping: boolean) {
  return cn(
    'flex shrink-0 items-center whitespace-nowrap pt-1 pb-[7px] text-[0.8929rem] transition-colors',
    selected ? 'font-medium text-foreground' : 'text-subtle-foreground hover:text-foreground',
    dropping && 'rounded-t-md bg-foreground/[0.075] text-foreground'
  );
}

function TabContent({
  label,
  count,
  emoji,
  color,
}: {
  label: string;
  count: number;
  emoji?: string;
  color?: string;
}) {
  return (
    <>
      {emoji && <span className="mr-1 text-[13px] leading-none">{emoji}</span>}
      {color && (
        <span
          className="mr-1.5 size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}
      <span className="max-w-32 truncate">{label}</span>
      <span className="ml-1 font-normal text-[0.75rem] text-subtle-foreground/75 tabular-nums">
        {count}
      </span>
    </>
  );
}

const isProjectDrag = (payload: unknown) =>
  (payload as DragPayload | undefined)?.type === 'project';

function SortableGroupChip({
  group,
  count,
  selected,
  onSelect,
}: {
  group: ProjectGroup;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, active } =
    useSortable({
      id: selectorGroupDropId(group.id),
      data: { type: 'project-group', groupId: group.id } satisfies DragPayload,
    });
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-enso="group-chip"
      data-selected={selected || undefined}
      data-active={selected || undefined}
      onClick={onSelect}
      // 只沿横轴跟手：纵向位移会被横滑容器裁掉
      style={{
        transform: transform ? `translate3d(${Math.round(transform.x)}px, 0, 0)` : undefined,
        transition,
      }}
      className={cn(
        tabClass(selected, isOver && isProjectDrag(active?.data.current)),
        isDragging && 'z-10 cursor-grabbing text-foreground'
      )}
      {...attributes}
      {...listeners}
    >
      <TabContent label={group.name} count={count} emoji={group.emoji} color={group.color} />
    </button>
  );
}

function UngroupedChip({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { active } = useDndContext();
  // 拖分组标签时不接收：否则拖到末尾压上「未分组」，被拖的标签会弹回原位
  const { setNodeRef, isOver } = useDroppable({
    id: selectorGroupDropId(UNGROUPED_GROUP_ID),
    disabled: (active?.data.current as DragPayload | undefined)?.type === 'project-group',
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-enso="group-chip"
      data-selected={selected || undefined}
      data-active={selected || undefined}
      onClick={onSelect}
      className={tabClass(selected, isOver && isProjectDrag(active?.data.current))}
    >
      <TabContent label={label} count={count} />
    </button>
  );
}

function GroupMenu({
  groups,
  selectedId,
  counts,
  totalCount,
  recentCount,
  ungroupedCount,
  onSelect,
  onAddGroup,
  onEditGroup,
}: {
  groups: readonly ProjectGroup[];
  selectedId: string;
  counts: Record<string, number>;
  totalCount: number;
  recentCount: number;
  ungroupedCount: number;
  onSelect: (id: string) => void;
  onAddGroup: () => void;
  onEditGroup: (id: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const closeAnd = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          BAR_ICON_CLASS,
          'ml-auto data-popup-open:bg-foreground/5 data-popup-open:text-foreground'
        )}
        title={t('All groups')}
        aria-label={t('All groups')}
      >
        <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-56 [&_[data-slot=popover-viewport]]:p-1">
        <GroupMenuRow
          label={t('All')}
          count={totalCount}
          selected={selectedId === ALL_GROUP_ID}
          onSelect={closeAnd(() => onSelect(ALL_GROUP_ID))}
        />
        <GroupMenuRow
          label={t('Recent')}
          count={recentCount}
          selected={selectedId === RECENT_GROUP_ID}
          onSelect={closeAnd(() => onSelect(RECENT_GROUP_ID))}
        />
        {groups.map((group) => (
          <GroupMenuRow
            key={group.id}
            label={group.name}
            emoji={group.emoji}
            color={group.color}
            count={counts[group.id] ?? 0}
            selected={selectedId === group.id}
            onSelect={closeAnd(() => onSelect(group.id))}
            onEdit={closeAnd(() => onEditGroup(group.id))}
          />
        ))}
        {groups.length > 0 && (
          <GroupMenuRow
            label={t('Ungrouped')}
            count={ungroupedCount}
            selected={selectedId === UNGROUPED_GROUP_ID}
            onSelect={closeAnd(() => onSelect(UNGROUPED_GROUP_ID))}
          />
        )}
        <div className="my-1 border-t" />
        <button
          type="button"
          onClick={closeAnd(onAddGroup)}
          className={cn(
            POPOVER_ROW_CLASS,
            'text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          <Plus className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t('New group')}</span>
        </button>
      </PopoverPopup>
    </Popover>
  );
}

function GroupMenuRow({
  label,
  count,
  emoji,
  color,
  selected,
  onSelect,
  onEdit,
}: {
  label: string;
  count: number;
  emoji?: string;
  color?: string;
  selected: boolean;
  onSelect: () => void;
  onEdit?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="group/row relative">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          POPOVER_ROW_CLASS,
          selected
            ? 'bg-brand/10 text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        <span className="flex w-4 shrink-0 items-center justify-center gap-1">
          {emoji ? (
            <span className="text-[13px] leading-none">{emoji}</span>
          ) : color ? (
            <span className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
          ) : null}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{count}</span>
        <span className="flex size-5 shrink-0 items-center justify-center">
          {selected && (
            <Check className={cn('size-3.5 text-brand', onEdit && 'group-hover/row:opacity-0')} />
          )}
        </span>
      </button>
      {/* 编辑按钮盖在勾的位置、不嵌进行按钮里 */}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="absolute inset-y-0 right-2 my-auto flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
          title={t('Edit group')}
          aria-label={t('Edit group')}
        >
          <Pencil className="size-3.5" />
        </button>
      )}
    </div>
  );
}

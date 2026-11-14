import {
  type ImportanceTier,
  importanceTier,
  UNIT_TYPES,
  type UnitType,
} from '@shared/memory/constants';
import {
  type EvolvesEdgeDto,
  isMemoryRetrievalMode,
  type MemoryDeletionImpact,
  type MemoryDetail,
  type MemoryListItem,
  type MemoryListQuery,
  type MemorySearchMode,
  type MemorySpaceKind,
  type PendingMemoryWriteDto,
} from '@shared/memory/dto';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { usePendingMemoryWrites, usePendingMemoryWritesStore } from '@/stores/memoryReview';

/**
 * 记忆库浏览与维护。归档是默认动作；永久删除要二次确认（禁止静默删除）。
 * evolves 审阅只改 review_state，不动 is_latest 也不删关系。
 */

export const MEMORY_PAGE_SIZE = 25;
const ALL = '__all__';

/** 记录时间按本地时区显示到分钟 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type Translate = (key: string, params?: Record<string, string>) => string;

export const SPACE_KINDS: readonly MemorySpaceKind[] = [
  'global',
  'project',
  'secretary',
  'bot',
  'chat',
];

const SPACE_KIND_LABEL: Record<MemorySpaceKind, string> = {
  global: 'Global',
  project: 'Projects',
  secretary: 'Secretary',
  bot: 'Members',
  chat: 'Group chats',
};

/** 具体空间优先；只选了类别时把该类别下的空间都带上（空数组 = 该类别下没有记忆） */
export function scopeFilter(
  kind: MemorySpaceKind | null,
  spaceId: string | null,
  spaces: readonly { id: string; kind: MemorySpaceKind }[]
): Pick<MemoryListQuery, 'spaceId' | 'spaceIds'> {
  if (spaceId) return { spaceId };
  if (!kind) return {};
  return { spaceIds: spaces.filter((space) => space.kind === kind).map((space) => space.id) };
}

/** 旧 Main 没给 spaceKinds 时按前缀推断（认不出秘书项目） */
function fallbackKind(spaceId: string): MemorySpaceKind {
  if (spaceId.startsWith('bot:')) return 'bot';
  if (spaceId.startsWith('chat:')) return 'chat';
  return spaceId.startsWith('proj:') ? 'project' : 'global';
}

interface MemoryDraft {
  title: string;
  content: string;
  unitType: UnitType;
  /** 输入框原文，保存时再校验 */
  importance: string;
}

function titleList(titles: string[]): string {
  const shown = titles.slice(0, 5).map((title) => `“${title}”`);
  return titles.length > 5 ? `${shown.join('、')}…` : shown.join('、');
}

/** 删除确认框里的影响说明，一条一句 */
export function deletionImpactLines(impact: MemoryDeletionImpact, t: Translate): string[] {
  const lines: string[] = [];
  const history = impact.deleted.filter((d) => d.role === 'history');
  if (history.length > 0) {
    lines.push(
      t('Also deletes {{count}} older versions it replaced: {{titles}}', {
        count: String(history.length),
        titles: titleList(history.map((d) => d.title)),
      })
    );
  }
  if (impact.bridges.length > 0) {
    lines.push(
      t(
        'The older and newer versions around it are linked directly, so the history stays continuous.'
      )
    );
  }
  if (impact.relations.length > 0) {
    lines.push(
      t('Removes the relation links to {{titles}}; those memories are kept.', {
        titles: titleList(impact.relations.map((r) => r.title)),
      })
    );
  }
  for (const crystal of impact.crystalsUpdated) {
    lines.push(
      t('Crystal {{title}} loses this source and keeps {{count}} sources.', {
        title: `“${crystal.title}”`,
        count: String(crystal.remaining),
      })
    );
  }
  for (const crystal of impact.crystalsDemoted) {
    lines.push(
      t(
        'Crystal {{title}} would be left with {{count}} sources, so it becomes a normal memory. Its content is kept.',
        { title: `“${crystal.title}”`, count: String(crystal.remaining) }
      )
    );
  }
  if (impact.releasedSources > 0) {
    lines.push(
      t('This is a crystal: its {{count}} source memories are kept, only the links are removed.', {
        count: String(impact.releasedSources),
      })
    );
  }
  if (lines.length === 0) lines.push(t('No other memories are affected.'));
  return lines;
}

/** 空结果分两种：库里真的没东西 vs 当前筛选条件没命中（接口未启用时返回空而非报错） */
export function isPristineEmpty(libraryHasRows: boolean | null, hasFilters: boolean): boolean {
  return libraryHasRows === false && !hasFilters;
}

export type MemoryEmptyReason = 'needs-query' | 'library-empty' | 'no-match';

/**
 * fast/deep 按相关度排序，没有查询词就无从排起，后端直接返回空——
 * 这时说「没有符合筛选条件」是误导，要请用户先输入。
 */
export function emptyReason(
  mode: MemorySearchMode,
  query: string,
  libraryHasRows: boolean | null,
  hasFilters: boolean
): MemoryEmptyReason {
  if (isMemoryRetrievalMode(mode) && !query.trim()) return 'needs-query';
  return isPristineEmpty(libraryHasRows, hasFilters) ? 'library-empty' : 'no-match';
}

export function MemoryRows({
  items,
  onOpen,
  t,
  selected,
  onToggle,
  emptyLabel,
}: {
  items: MemoryListItem[];
  onOpen: (id: string) => void;
  t: (key: string, params?: Record<string, string>) => string;
  selected?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  emptyLabel?: string;
}) {
  return (
    <ul className="divide-y rounded-lg border">
      {items.length === 0 && (
        <li className="px-3 py-6 text-sm text-muted-foreground">{emptyLabel}</li>
      )}
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2 px-3 py-2" data-memory-id={item.id}>
          {onToggle && (
            <Checkbox
              checked={selected?.has(item.id) ?? false}
              onCheckedChange={() => onToggle(item.id)}
              aria-label={t('Select memory')}
            />
          )}
          <button
            type="button"
            onClick={() => onOpen(item.id)}
            className="min-w-0 flex-1 space-y-0.5 text-left"
          >
            <span className="flex items-center gap-2">
              {item.isCrystal && <span title={t('Crystal')}>★</span>}
              <span className="truncate text-sm">{item.title}</span>
              <Badge variant="secondary">{item.unitType}</Badge>
              <ImportanceBadge importance={item.importance} t={t} />
              {item.lifecycleState === 'archived' && (
                <Badge variant="outline">{t('Archived')}</Badge>
              )}
            </span>
            <span className="line-clamp-2 text-muted-foreground text-xs">
              {item.contentSummary}
            </span>
            <span className="block text-muted-foreground text-xs">
              {t('Recorded {{date}}', { date: formatDateTime(item.createdAt) })} · {item.spaceLabel}{' '}
              · {t('Retrieved {{count}} times', { count: String(item.appearances) })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// 重要度是有序的，不是分类：用不同强度的 variant 让高低一眼可分，
// 全用同一个灰 badge 等于没给信息。tooltip 给出原始数值。
const IMPORTANCE_STYLE: Record<
  ImportanceTier,
  { variant: 'warning' | 'info' | 'outline' | 'secondary'; label: string }
> = {
  critical: { variant: 'warning', label: 'critical' },
  important: { variant: 'info', label: 'important' },
  useful: { variant: 'outline', label: 'useful' },
  low: { variant: 'outline', label: 'low' },
};

function ImportanceBadge({
  importance,
  t,
}: {
  importance: number;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const tier = importanceTier(importance);
  const style = IMPORTANCE_STYLE[tier];
  return (
    <Badge
      variant={style.variant}
      className={tier === 'low' ? 'text-muted-foreground' : undefined}
      title={t('Importance {{value}}', { value: importance.toFixed(2) })}
    >
      {t(style.label)}
    </Badge>
  );
}

export function PendingReviewSection({
  edges,
  onReview,
  t,
}: {
  edges: EvolvesEdgeDto[];
  onReview: (id: string, state: 'accepted' | 'rejected') => void;
  t: (key: string) => string;
}) {
  if (edges.length === 0) return null;
  return (
    <section className="space-y-2" data-settings-row="memory.review">
      <h3 className="text-sm font-medium">{t('Needs review')}</h3>
      <p className="text-xs text-muted-foreground">
        {t(
          'Reviewing only records your judgement. Nothing is deleted and no memory is superseded.'
        )}
      </p>
      {edges.map((edge) => (
        <div key={edge.id} className="space-y-1 rounded-lg border px-3 py-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{edge.relation}</Badge>
            <span className="text-xs text-muted-foreground">
              {edge.olderId.slice(0, 8)} → {edge.newerId.slice(0, 8)}
            </span>
          </div>
          {edge.reason && <p className="text-xs text-muted-foreground">{edge.reason}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onReview(edge.id, 'accepted')}>
              {t('Accept')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onReview(edge.id, 'rejected')}>
              {t('Dismiss')}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** Bot 成员写项目 / 全局记忆的待审批项；批准后才真正写入 */
export function PendingWritesSection({
  writes,
  onReview,
  t,
}: {
  writes: PendingMemoryWriteDto[];
  onReview: (id: string, decision: 'approve' | 'reject') => void;
  t: (key: string) => string;
}) {
  if (writes.length === 0) return null;
  return (
    <section className="space-y-2" data-settings-row="memory.pending-writes">
      <h3 className="text-sm font-medium">{t('Memory writes awaiting approval')}</h3>
      <p className="text-xs text-muted-foreground">
        {t('Bot members need your approval before writing to project or global memory.')}
      </p>
      {writes.map((write) => (
        <div key={write.id} className="space-y-1 rounded-lg border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {write.originLabel && <span className="text-foreground">{write.originLabel}</span>}
            <span>→ {write.spaceLabel}</span>
            {write.redacted && <span>· {t('Secrets redacted')}</span>}
          </div>
          {write.title && <div className="text-sm font-medium">{write.title}</div>}
          <p className="whitespace-pre-wrap text-xs">{write.content}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onReview(write.id, 'approve')}>
              {t('Approve')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onReview(write.id, 'reject')}>
              {t('Reject')}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

function PendingWritesReview({ t }: { t: (key: string) => string }) {
  const writes = usePendingMemoryWrites();
  const review = usePendingMemoryWritesStore((s) => s.review);
  return (
    <PendingWritesSection
      writes={writes}
      t={t}
      onReview={(id, decision) => void review(id, decision)}
    />
  );
}

export function MemoryLibrary({ revision = 0 }: { revision?: number } = {}) {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [spaceKind, setSpaceKind] = React.useState<string>(ALL);
  const [spaceId, setSpaceId] = React.useState<string>(ALL);
  const [unitType, setUnitType] = React.useState<string>(ALL);
  const [includeArchived, setIncludeArchived] = React.useState(false);
  const [offset, setOffset] = React.useState(0);
  const [mode, setMode] = React.useState<MemorySearchMode>('exact');
  const [approximate, setApproximate] = React.useState(false);
  const [vectorsUsed, setVectorsUsed] = React.useState(true);
  const [items, setItems] = React.useState<MemoryListItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [spaces, setSpaces] = React.useState<
    { id: string; label: string; kind: MemorySpaceKind }[]
  >([]);
  // 列表请求读最新空间表，但空间表刷新本身不该再触发一次列表请求
  const spacesRef = React.useRef(spaces);
  spacesRef.current = spaces;
  const [libraryExists, setLibraryExists] = React.useState<boolean | null>(null);
  const [detail, setDetail] = React.useState<MemoryDetail | null>(null);
  const [draft, setDraft] = React.useState<MemoryDraft | null>(null);
  const [editError, setEditError] = React.useState<string | null>(null);
  // impact 为 undefined = 影响说明还在加载；确认按钮在拿到之前不可点
  const [pendingDelete, setPendingDelete] = React.useState<{
    ids: string[];
    impact: MemoryDeletionImpact | null | undefined;
  } | null>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [pendingEdges, setPendingEdges] = React.useState<EvolvesEdgeDto[]>([]);

  const mounted = React.useRef(false);
  const listRequest = React.useRef(0);
  const detailRequest = React.useRef(0);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listRequest.current++;
      detailRequest.current++;
    };
  }, []);

  const reload = React.useCallback(() => {
    if (!mounted.current) return;
    // 包括不发 IPC 的空查询，也必须让此前在途的结果过期。
    const request = ++listRequest.current;
    const isCurrent = () => mounted.current && request === listRequest.current;
    // 语义模式没有查询词时后端必然返回空，别白跑一次 IPC（还会顺带加载 embedder）
    if (isMemoryRetrievalMode(mode) && !query.trim()) {
      setItems([]);
      setTotal(0);
      setApproximate(true);
      setVectorsUsed(true);
      return;
    }
    const kind = SPACE_KINDS.find((k) => k === spaceKind) ?? null;
    void window.electronAPI.memory
      .list({
        query: query.trim() || undefined,
        ...scopeFilter(kind, spaceId === ALL ? null : spaceId, spacesRef.current),
        unitType: unitType === ALL ? undefined : (unitType as UnitType),
        includeArchived,
        limit: MEMORY_PAGE_SIZE,
        offset,
        mode,
      })
      .then((result) => {
        if (!isCurrent()) return;
        setItems(result.items);
        setTotal(result.total);
        setApproximate(result.approximate === true);
        setVectorsUsed(result.vectorsUsed !== false);
      });
    // 全库统计与待审阅不属于列表筛选，不能随空查询一起作废。
    void window.electronAPI.memory.stats().then((stats) => {
      if (!mounted.current) return;
      setSpaces(
        Object.keys(stats.bySpace).map((id) => ({
          id,
          label: stats.spaceLabels[id] ?? id,
          kind: stats.spaceKinds?.[id] ?? fallbackKind(id),
        }))
      );
      setLibraryExists(stats.total > 0);
    });
    void window.electronAPI.memory.evolvesPending().then((edges) => {
      if (mounted.current) setPendingEdges(edges);
    });
  }, [query, spaceKind, spaceId, unitType, includeArchived, offset, mode]);

  React.useEffect(() => {
    reload();
    return () => {
      listRequest.current++;
    };
  }, [reload]);
  // Main 在任何写入后广播（包括 agent 通过工具写的），比靠组件树传 revision 可靠
  const reloadRef = React.useRef(reload);
  reloadRef.current = reload;
  React.useEffect(() => window.electronAPI.memory.onChanged(() => reloadRef.current()), []);
  const seenRevision = React.useRef(revision);
  React.useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    reload();
  }, [revision, reload]);

  const openDetail = (id: string) => {
    const request = ++detailRequest.current;
    void window.electronAPI.memory.detail(id).then((result) => {
      if (mounted.current && request === detailRequest.current) setDetail(result);
    });
  };

  const closeDetail = () => {
    detailRequest.current++;
    setDetail(null);
    setDraft(null);
    setEditError(null);
  };

  // 串行：每次变更都要重新拉列表，并发会让分页与 total 错位
  const bulkRun = async (ids: Iterable<string>, run: (id: string) => Promise<unknown>) => {
    setBusy(true);
    try {
      for (const id of ids) await run(id);
    } finally {
      if (mounted.current) {
        setBusy(false);
        setSelected(new Set());
        reloadRef.current();
      }
    }
  };

  const bulkArchive = () => void bulkRun(selected, (id) => window.electronAPI.memory.archive(id));

  const askDelete = (ids: string[]) => {
    setPendingDelete({ ids, impact: undefined });
    void window.electronAPI.memory.deletePreview(ids).then((impact) => {
      if (!mounted.current) return;
      setPendingDelete((current) => (current?.ids === ids ? { ids, impact } : current));
    });
  };

  // 一次删一条，后面的若已作为前面那条的历史版本被删掉，Main 返回 not found，忽略即可
  const confirmDelete = () => {
    if (!pendingDelete) return;
    const { ids } = pendingDelete;
    void bulkRun(ids, (id) => window.electronAPI.memory.delete(id)).then(() => {
      if (!mounted.current) return;
      setPendingDelete(null);
      if (detail && ids.includes(detail.id)) closeDetail();
    });
  };

  const startEdit = (memory: MemoryDetail) => {
    setEditError(null);
    setDraft({
      title: memory.title,
      content: memory.content,
      unitType: memory.unitType,
      importance: String(memory.importance),
    });
  };

  const saveEdit = async () => {
    if (!detail || !draft) return;
    const importance = Number(draft.importance);
    if (!draft.content.trim()) return setEditError(t('Content cannot be empty.'));
    if (draft.importance.trim() === '' || !(importance >= 0 && importance <= 1)) {
      return setEditError(t('Importance must be between 0 and 1.'));
    }
    setBusy(true);
    const result = await window.electronAPI.memory.update(detail.id, {
      title: draft.title,
      content: draft.content,
      unitType: draft.unitType,
      importance,
    });
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) return setEditError(result.error ?? t('Could not save the memory.'));
    setDraft(null);
    setEditError(null);
    openDetail(detail.id);
    reloadRef.current();
  };

  const runMutation = (action: Promise<{ ok: boolean }>) => {
    void action.then(() => {
      if (!mounted.current) return;
      closeDetail();
      reloadRef.current();
    });
  };

  const hasFilters =
    query.trim() !== '' ||
    spaceKind !== ALL ||
    spaceId !== ALL ||
    unitType !== ALL ||
    includeArchived === true;
  const kindItems = [
    { value: ALL, label: t('All space types') },
    ...SPACE_KINDS.filter((kind) => spaces.some((space) => space.kind === kind)).map((kind) => ({
      value: kind,
      label: t(SPACE_KIND_LABEL[kind]),
    })),
  ];
  const spaceItems = [
    { value: ALL, label: t('All spaces') },
    ...spaces
      .filter((space) => spaceKind === ALL || space.kind === spaceKind)
      .map((space) => ({ value: space.id, label: space.label })),
  ];
  const unitTypeItems = [
    { value: ALL, label: t('All types') },
    ...UNIT_TYPES.map((type) => ({ value: type, label: type })),
  ];
  const modeItems = [
    { value: 'exact', label: t('Exact match') },
    { value: 'fast', label: t('Fast retrieval') },
    { value: 'deep', label: t('Deep retrieval') },
  ];

  return (
    <div className="space-y-4" data-settings-row="memory.library">
      <div>
        <h3 className="text-sm font-medium">{t('Stored memories')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('Everything the agent has saved. Archiving hides a memory from search but keeps it.')}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* 检索方式属于「怎么搜」，和搜索框合成一个控件，不当作并列的筛选项 */}
        <InputGroup className="w-full sm:w-96" data-size="sm">
          <InputGroupInput
            value={query}
            placeholder={t('Search memories')}
            onChange={(event) => {
              setOffset(0);
              setQuery(event.target.value);
            }}
          />
          <InputGroupAddon align="inline-end" className="pe-1">
            <Select
              value={mode}
              items={modeItems}
              onValueChange={(value) => {
                setOffset(0);
                setMode(value === 'deep' ? 'deep' : value === 'fast' ? 'fast' : 'exact');
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto min-w-0 gap-1 border-0 bg-transparent px-2 shadow-none before:hidden"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {modeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </InputGroupAddon>
        </InputGroup>
        {/* base-ui 的 Select 靠 items 把 value 映射成 label；不传时触发器会直接显示原始 value */}
        <Select
          value={spaceKind}
          items={kindItems}
          onValueChange={(value) => {
            setOffset(0);
            setSpaceKind(String(value));
            setSpaceId(ALL);
          }}
        >
          <SelectTrigger size="sm" className="w-36" data-memory-filter="space-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {kindItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={spaceId}
          items={spaceItems}
          onValueChange={(value) => {
            setOffset(0);
            setSpaceId(String(value));
          }}
        >
          <SelectTrigger size="sm" className="w-36" data-memory-filter="space">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {spaceItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={unitType}
          items={unitTypeItems}
          onValueChange={(value) => {
            setOffset(0);
            setUnitType(String(value));
          }}
        >
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {unitTypeItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {mode === 'exact' && (
          <label className="flex items-center gap-2 text-muted-foreground text-sm">
            <Switch
              checked={includeArchived}
              onCheckedChange={(value) => {
                setOffset(0);
                setIncludeArchived(value === true);
              }}
            />
            {t('Show archived')}
          </label>
        )}
      </div>

      {isMemoryRetrievalMode(mode) && (
        <p className="text-xs text-muted-foreground">
          {t(
            mode === 'deep'
              ? 'Same recall as Fast, plus intent-weighted fusion and an optional short-timeout LLM rerank. Failures fall back; archived memories are excluded.'
              : 'Same path the agent uses: full-text, vectors and entities merged by relevance. Shows the top matches only — no exact count, and archived memories are excluded.'
          )}
          {!vectorsUsed && ` ${t('Embedding model is not ready, so vectors are skipped.')}`}
        </p>
      )}

      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-accent/30 px-3 py-2">
          <span className="text-sm">
            {t('{{count}} selected', { count: String(selected.size) })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setSelected(new Set())}
            >
              {t('Clear selection')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => bulkArchive()}>
              {t('Archive selected')}
            </Button>
            <button
              type="button"
              disabled={busy}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
              onClick={() => askDelete([...selected])}
            >
              {t('Delete permanently')}
            </button>
          </div>
        </div>
      )}

      <MemoryRows
        items={items}
        onOpen={openDetail}
        t={t}
        selected={selected}
        emptyLabel={
          {
            'needs-query': t('Type a query to search by meaning.'),
            'library-empty': t(
              'No memories yet. They appear here once the agent stores something.'
            ),
            'no-match': t('No memories match these filters.'),
          }[emptyReason(mode, query, libraryExists, hasFilters)]
        }
        onToggle={(id) => {
          const next = new Set(selected);
          if (!next.delete(id)) next.add(id);
          setSelected(next);
        }}
      />

      {!approximate && total > MEMORY_PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - MEMORY_PAGE_SIZE))}
          >
            {t('Previous')}
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + MEMORY_PAGE_SIZE, total)} / {total}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + MEMORY_PAGE_SIZE >= total}
            onClick={() => setOffset(offset + MEMORY_PAGE_SIZE)}
          >
            {t('Next')}
          </Button>
        </div>
      )}

      <PendingWritesReview t={t} />

      <PendingReviewSection
        edges={pendingEdges}
        t={t}
        onReview={(id, state) => runMutation(window.electronAPI.memory.evolvesReview(id, state))}
      />

      <Dialog open={detail !== null} onOpenChange={(open) => !open && closeDetail()}>
        <DialogContent>
          {detail && draft && (
            <>
              <DialogHeader>
                <DialogTitle>{t('Edit memory')}</DialogTitle>
                <DialogDescription>
                  {t('Search indexes are rebuilt from the new text right away.')}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-3" data-memory-edit="">
                <label className="block space-y-1">
                  <span className="text-muted-foreground text-xs">{t('Memory title')}</span>
                  <Input
                    value={draft.title}
                    data-memory-field="title"
                    onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted-foreground text-xs">{t('Content')}</span>
                  <Textarea
                    value={draft.content}
                    rows={6}
                    data-memory-field="content"
                    onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <span className="text-muted-foreground text-xs">{t('Type')}</span>
                    <Select
                      value={draft.unitType}
                      items={UNIT_TYPES.map((type) => ({ value: type, label: type }))}
                      onValueChange={(value) => {
                        const next = UNIT_TYPES.find((type) => type === value);
                        if (next) setDraft({ ...draft, unitType: next });
                      }}
                    >
                      <SelectTrigger size="sm" data-memory-field="unitType">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {UNIT_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-muted-foreground text-xs">{t('Importance (0–1)')}</span>
                    <Input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      size="sm"
                      value={draft.importance}
                      data-memory-field="importance"
                      onChange={(event) => setDraft({ ...draft, importance: event.target.value })}
                    />
                  </label>
                </div>
                {editError && <p className="text-destructive text-xs">{editError}</p>}
              </DialogPanel>
              <DialogFooter>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setDraft(null)}>
                  {t('Cancel')}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  data-memory-action="save"
                  onClick={() => void saveEdit()}
                >
                  {t('Save')}
                </Button>
              </DialogFooter>
            </>
          )}
          {detail && !draft && (
            <>
              <DialogHeader>
                <DialogTitle>{detail.title}</DialogTitle>
                <DialogDescription>
                  {[detail.unitType, detail.spaceLabel].join(' · ')}
                </DialogDescription>
              </DialogHeader>

              <DialogPanel className="space-y-4" data-memory-detail={detail.id}>
                <p className="whitespace-pre-wrap text-sm" data-memory-field="content">
                  {detail.content}
                </p>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <MetaField label={t('Importance')} value={detail.importance.toFixed(2)} />
                  <MetaField label={t('Recorded at')} value={formatDateTime(detail.createdAt)} />
                  {detail.updatedAt !== detail.createdAt && (
                    <MetaField label={t('Updated at')} value={formatDateTime(detail.updatedAt)} />
                  )}
                  <MetaField
                    label={t('Embedding')}
                    value={detail.embeddingModel ?? t('Not vectorized')}
                  />
                  {detail.eventStart && (
                    <MetaField
                      label={t('Event date')}
                      value={`${detail.eventStart}${detail.eventEnd ? ` → ${detail.eventEnd}` : ''}`}
                    />
                  )}
                </dl>

                {detail.entityNames.length > 0 && (
                  <section className="space-y-1.5">
                    <p className="font-medium text-xs">{t('Entities')}</p>
                    <div className="flex flex-wrap gap-1">
                      {detail.entityNames.map((name) => (
                        <Badge key={name} variant="secondary">
                          {name}
                        </Badge>
                      ))}
                    </div>
                  </section>
                )}

                {detail.crystalSources.length > 0 && (
                  <section className="space-y-1.5">
                    <p className="font-medium text-xs">{t('Synthesized from')}</p>
                    <ul className="divide-y rounded-lg border">
                      {detail.crystalSources.map((source) => (
                        <li
                          key={source.id}
                          className="flex items-center justify-between gap-2 px-3 py-2"
                        >
                          <span className="truncate text-sm">{source.title}</span>
                          <span className="shrink-0 text-muted-foreground text-xs">
                            {(source.contributionWeight * 100).toFixed(0)}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {detail.evolves.length > 0 && (
                  <section className="space-y-1.5">
                    <p className="font-medium text-xs">{t('Related versions')}</p>
                    <ul className="divide-y rounded-lg border">
                      {detail.evolves.map((edge) => (
                        <li key={edge.id} className="flex items-center gap-2 px-3 py-2">
                          <Badge variant="outline">{edge.relation}</Badge>
                          <span className="text-muted-foreground text-xs">{edge.reviewState}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </DialogPanel>

              <DialogFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  className="sm:me-auto"
                  data-memory-action="delete"
                  onClick={() => askDelete([detail.id])}
                >
                  {t('Delete permanently')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-memory-action="edit"
                  onClick={() => startEdit(detail)}
                >
                  {t('Edit')}
                </Button>
                {detail.lifecycleState === 'archived' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => runMutation(window.electronAPI.memory.restore(detail.id))}
                  >
                    {t('Restore')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => runMutation(window.electronAPI.memory.archive(detail.id))}
                  >
                    {t('Archive')}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !busy && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingDelete && pendingDelete.ids.length > 1
                ? t('Delete {{count}} memories permanently?', {
                    count: String(pendingDelete.ids.length),
                  })
                : t('Delete this memory permanently?')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'This cannot be undone. Archiving keeps the memory out of search while preserving it.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel data-memory-delete-impact="">
            {pendingDelete?.impact === undefined ? (
              <p className="text-muted-foreground text-xs">{t('Checking what this affects…')}</p>
            ) : pendingDelete.impact === null ? (
              <p className="text-muted-foreground text-xs">{t('Memory not found.')}</p>
            ) : (
              <ul className="list-disc space-y-1 ps-4 text-xs">
                {deletionImpactLines(pendingDelete.impact, t).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
              {t('Cancel')}
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              data-memory-action="confirm-delete"
              disabled={busy || !pendingDelete?.impact}
              onClick={confirmDelete}
            >
              {t('Delete permanently')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate text-sm">{value}</dd>
    </div>
  );
}

export default MemoryLibrary;

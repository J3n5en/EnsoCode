import { CRYSTAL_MIN_SOURCES } from '@shared/memory/constants';
import type {
  CrystallizeResult,
  InsightResult,
  MemoryBriefDto,
  MemoryGraphDto,
  TreeGrouping,
  TreeNodeDto,
} from '@shared/memory/graphDto';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { SettingsSection } from './kit';
import { MemoryGraphView } from './MemoryGraphView';
import { MemoryTreeView } from './MemoryTreeView';

/**
 * 知识视图：图谱 / 知识树两种浏览方式，共用「解读」与「结晶」两个动作。
 * 解读只读（LLM 生成 briefing），结晶会写库（走 createCrystal 的完整链路，含候选网）。
 */

const GRAPH_LIMIT = 120;
const TREE_LIMIT_PER_GROUP = 30;
const EMPTY_GRAPH: MemoryGraphDto = { nodes: [], edges: [], totalEntities: 0 };

type Mode = 'graph' | 'tree';

export function MemoryKnowledge({ revision = 0 }: { revision?: number } = {}) {
  const { t } = useI18n();
  const [mode, setMode] = React.useState<Mode>('graph');
  const [groupBy, setGroupBy] = React.useState<TreeGrouping>('unitType');
  const [graph, setGraph] = React.useState<MemoryGraphDto>(EMPTY_GRAPH);
  const [tree, setTree] = React.useState<TreeNodeDto[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [entityId, setEntityId] = React.useState<string | null>(null);
  const [entityMemories, setEntityMemories] = React.useState<MemoryBriefDto[]>([]);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [insight, setInsight] = React.useState<InsightResult | null>(null);
  const [interpreting, setInterpreting] = React.useState(false);
  const [crystal, setCrystal] = React.useState<CrystallizeResult | null>(null);
  const [crystallizing, setCrystallizing] = React.useState(false);

  const reload = React.useCallback(() => {
    setLoading(true);
    const done = () => setLoading(false);
    if (mode === 'graph') {
      void window.electronAPI.memory
        .graph({ limit: GRAPH_LIMIT, minMemories: 1 })
        .then(setGraph)
        .finally(done);
    } else {
      void window.electronAPI.memory
        .tree({ groupBy, limitPerGroup: TREE_LIMIT_PER_GROUP })
        .then(setTree)
        .finally(done);
    }
  }, [mode, groupBy]);

  React.useEffect(reload, [reload]);
  const reloadRef = React.useRef(reload);
  reloadRef.current = reload;
  React.useEffect(() => window.electronAPI.memory.onChanged(() => reloadRef.current()), []);
  const seenRevision = React.useRef(revision);
  React.useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    reload();
  }, [revision, reload]);

  React.useEffect(() => {
    if (!entityId) {
      setEntityMemories([]);
      return;
    }
    void window.electronAPI.memory.graphEntity(entityId).then(setEntityMemories);
  }, [entityId]);

  const runInsight = async (request: { entityId?: string; memoryIds?: string[] }) => {
    setInterpreting(true);
    setInsight(null);
    try {
      setInsight(await window.electronAPI.memory.insight(request));
    } finally {
      setInterpreting(false);
    }
  };

  const runCrystallize = async () => {
    setCrystallizing(true);
    try {
      const result = await window.electronAPI.memory.crystallize({ memoryIds: [...selected] });
      setCrystal(result);
      if (result.ok) setSelected(new Set());
    } finally {
      setCrystallizing(false);
    }
  };

  const modeItems = [
    { value: 'graph', label: t('Graph') },
    { value: 'tree', label: t('Tree') },
  ];
  const groupItems = [
    { value: 'unitType', label: t('By type') },
    { value: 'entity', label: t('By entity') },
    { value: 'time', label: t('By month') },
  ];
  const enoughForCrystal = selected.size >= CRYSTAL_MIN_SOURCES;

  return (
    <SettingsSection
      bare
      rowId="memory.knowledge"
      title={t('Knowledge')}
      description={t(
        'Browse what the agent knows as a graph or a tree, ask for an interpretation, and consolidate related memories into a crystal.'
      )}
    >
      <div className="flex flex-wrap items-center gap-2 py-2">
        <Select
          value={mode}
          items={modeItems}
          onValueChange={(value) => setMode(value === 'tree' ? 'tree' : 'graph')}
        >
          <SelectTrigger size="sm" className="w-32">
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
        {mode === 'tree' && (
          <Select
            value={groupBy}
            items={groupItems}
            onValueChange={(value) => setGroupBy(value as TreeGrouping)}
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {groupItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <span className="flex-1" />
        {mode === 'tree' && (
          <>
            <span
              className={cn(
                'text-xs',
                enoughForCrystal ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {t('{{count}} selected', { count: String(selected.size) })}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!enoughForCrystal || crystallizing}
              onClick={() => void runCrystallize()}
            >
              {crystallizing
                ? t('Synthesizing…')
                : t('Crystallize ({{min}}+)', { min: String(CRYSTAL_MIN_SOURCES) })}
            </Button>
          </>
        )}
      </div>

      {mode === 'graph' ? (
        <MemoryGraphView
          graph={graph}
          loading={loading}
          selectedId={entityId}
          onSelect={setEntityId}
          memories={entityMemories}
          interpreting={interpreting}
          onInterpret={(id) => void runInsight({ entityId: id })}
        />
      ) : (
        <MemoryTreeView
          tree={tree}
          loading={loading}
          selected={selected}
          interpreting={interpreting}
          onToggle={(id) => {
            const next = new Set(selected);
            if (!next.delete(id)) next.add(id);
            setSelected(next);
          }}
          onInterpretGroup={(group) => {
            const ids = (group.children ?? [])
              .map((c) => c.memoryId)
              .filter((id): id is string => Boolean(id));
            void runInsight({ memoryIds: ids });
          }}
        />
      )}

      <Dialog open={insight !== null} onOpenChange={(open) => !open && setInsight(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Interpretation')}</DialogTitle>
            {insight?.ok && (
              <DialogDescription>
                {t('Based on {{count}} memories', { count: String(insight.sourceCount ?? 0) })}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogPanel>
            {insight?.ok ? (
              <p className="whitespace-pre-wrap text-sm">{insight.text}</p>
            ) : (
              <p className="text-destructive text-sm">{insight?.error}</p>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>{t('Close')}</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={crystal !== null} onOpenChange={(open) => !open && setCrystal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {crystal?.ok ? t('Crystal created') : t('Nothing was written')}
            </DialogTitle>
            {crystal?.ok && <DialogDescription>{crystal.title}</DialogDescription>}
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {crystal?.ok ? (
              <p className="whitespace-pre-wrap text-sm">{crystal.content}</p>
            ) : (
              <>
                <p className="text-destructive text-sm">{crystal?.error}</p>
                {crystal?.candidates && crystal.candidates.length > 0 && (
                  <ul className="divide-y border-border border-y">
                    {crystal.candidates.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                        <span className="truncate text-sm">{c.title}</span>
                        <Badge variant="secondary">{(c.similarity * 100).toFixed(0)}%</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>{t('Close')}</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
